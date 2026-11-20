/* Web Worker for reading local Matroska files. */
self.window = self; // The upstream browser bundle uses window as its UMD global.
importScripts("./vendor/matroska-subtitles.min.js");

const ids = {
    segment: 0x18538067, tracks: 0x1654ae6b, info: 0x1549a966, chapters: 0x1043a770,
    track: 0xae, trackNumber: 0xd7, default: 0x88, forced: 0x55aa,
    language: 0x22b59c, languageIetf: 0x22b59d,
    edition: 0x45b9, defaultEdition: 0x45db, ordered: 0x45dd,
    chapter: 0xb6, start: 0x91, end: 0x92, hidden: 0x98, enabled: 0x4598,
    display: 0x80, title: 0x85, duration: 0x4489, timeScale: 0x2ad7b1,
};
const decode = new TextDecoder();
const metadataLimit = 16 * 1024 * 1024;

function vint(bytes, offset, isSize) {
    const first = bytes[offset];
    if (!first) throw Error("Invalid Matroska element.");
    let mask = 0x80;
    let length = 1;
    while (!(first & mask)) {
        mask >>= 1;
        length++;
    }
    if (offset + length > bytes.length) throw Error("Incomplete Matroska element.");
    let value = isSize ? first & (mask - 1) : first;
    let unknown = isSize && value === mask - 1;
    for (let i = 1; i < length; i++) {
        value = value * 256 + bytes[offset + i];
        unknown &&= bytes[offset + i] === 255;
    }
    if (!unknown && !Number.isSafeInteger(value)) throw Error("Matroska element is too large.");
    return { value: unknown ? null : value, length };
}

function header(bytes, offset) {
    const id = vint(bytes, offset, false);
    const length = vint(bytes, offset + id.length, true);
    return { id: id.value, start: offset + id.length + length.length, size: length.value };
}

function children(bytes) {
    const elements = [];
    let cursor = 0;
    while (cursor < bytes.length) {
        const element = header(bytes, cursor);
        const end = element.start + element.size;
        if (element.size === null || end > bytes.length) throw Error("Incomplete Matroska metadata.");
        elements.push({ id: element.id, data: bytes.subarray(element.start, end) });
        cursor = end;
    }
    return elements;
}

function unsigned(bytes, fallback = null) {
    return bytes ? bytes.reduce((total, byte) => total * 256 + byte, 0) : fallback;
}

function field(entries, id) {
    return entries.find(entry => entry.id === id)?.data;
}

function readChapters(bytes) {
    const editions = children(bytes).filter(item => item.id === ids.edition).map(item => children(item.data));
    const edition = editions.find(item => unsigned(field(item, ids.defaultEdition))) || editions[0];
    if (!edition || unsigned(field(edition, ids.ordered))) return [];
    return edition.filter(item => item.id === ids.chapter).flatMap(item => {
        const fields = children(item.data);
        const start = unsigned(field(fields, ids.start));
        if (start === null || unsigned(field(fields, ids.hidden)) || !unsigned(field(fields, ids.enabled), 1)) return [];
        const end = unsigned(field(fields, ids.end));
        const display = field(fields, ids.display);
        const label = display && field(children(display), ids.title);
        return [{ title: label ? decode.decode(label) : "", start: start / 1e6, end: end === null ? null : end / 1e6 }];
    }).sort((a, b) => a.start - b.start);
}

async function inspect(file) {
    const flags = new Map();
    let chapters = [];
    let duration = null;
    let segmentFound = false;
    let limit = file.size;
    for (let offset = 0; offset < limit;) {
        const bytes = new Uint8Array(await file.slice(offset, offset + 16).arrayBuffer());
        const element = header(bytes, 0);
        const start = offset + element.start;
        const end = element.size === null ? limit : start + element.size;
        if (end > limit) throw Error("MKV is incomplete. Finish downloading it and try again.");
        if (element.id === ids.segment) {
            segmentFound = true;
            limit = end;
            offset = start;
            continue;
        }
        if (segmentFound && [ids.tracks, ids.chapters, ids.info].includes(element.id)) {
            if (element.size > metadataLimit) throw Error("MKV metadata exceeds 16 MB.");
            const data = new Uint8Array(await file.slice(start, end).arrayBuffer());
            if (element.id === ids.chapters) chapters = readChapters(data);
            if (element.id === ids.tracks) {
                for (const entry of children(data).filter(item => item.id === ids.track)) {
                    const fields = children(entry.data);
                    flags.set(unsigned(field(fields, ids.trackNumber)), {
                        default: Boolean(unsigned(field(fields, ids.default), 1)),
                        forced: Boolean(unsigned(field(fields, ids.forced))),
                        language: decode.decode(field(fields, ids.languageIetf) || field(fields, ids.language)) || "eng",
                    });
                }
            }
            if (element.id === ids.info) {
                const fields = children(data);
                const raw = field(fields, ids.duration);
                const scale = unsigned(field(fields, ids.timeScale), 1e6);
                if (raw && [4, 8].includes(raw.length)) {
                    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
                    duration = (raw.length === 4 ? view.getFloat32(0) : view.getFloat64(0)) * scale / 1e6;
                    if (!Number.isFinite(duration) || duration <= 0) duration = null;
                }
            }
        }
        if (element.size === null) break;
        offset = end;
    }
    if (!segmentFound) throw Error("Choose a Matroska MKV file.");
    chapters.forEach((chapter, index) => {
        chapter.end ??= chapters[index + 1]?.start ?? duration;
    });
    return { flags, chapters, duration };
}

async function extract(file) {
    const { flags, chapters, duration } = await inspect(file);
    const parser = new MatroskaSubtitles.SubtitleParser();
    let tracks = new Map();
    const fonts = [];
    let encounteredTracks = false;
    let failure;
    parser.on("error", error => { failure = error; });
    parser.on("tracks", entries => {
        encounteredTracks = true;
        tracks = new Map(entries.filter(entry => entry.type === "ass").map(entry => [
            entry.number, { ...entry, ...flags.get(entry.number), cues: [] },
        ]));
    });
    parser.on("subtitle", (cue, number) => tracks.get(number)?.cues.push(cue));
    parser.on("file", attachment => {
        if (attachment.data && /\.(ttf|otf|ttc|woff2?)$/i.test(attachment.filename || "")) {
            fonts.push({ name: attachment.filename.replace(/^.*[/\\]/, ""), data: new Uint8Array(attachment.data) });
        }
    });
    const reader = file.stream().getReader();
    let processed = 0;
    let progress = -1;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            parser.write(value);
            if (failure) throw failure;
            if (encounteredTracks && !tracks.size) throw Error("No embedded ASS subtitle tracks were found.");
            processed += value.length;
            const percent = Math.floor(100 * processed / file.size);
            if (percent > progress) {
                progress = percent;
                postMessage({ progress });
            }
        }
        parser.end();
        if (failure) throw failure;
    } finally {
        await reader.cancel();
    }
    tracks = Array.from(tracks.values()).filter(track => track.header && track.cues.length);
    if (!tracks.length) throw Error("No embedded ASS subtitle cues were found.");
    postMessage({ tracks, chapters, duration, fonts }, fonts.map(font => font.data.buffer));
}

onmessage = ({ data }) => extract(data).catch(error => postMessage({ error: error.message }));
