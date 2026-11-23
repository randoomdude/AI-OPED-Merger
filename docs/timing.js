import { assLyric, positionedLyrics } from "./furigana.js";

export function timestamp(value) {
    const text = String(value ?? "").trim();
    const parts = text.split(":");
    if (!text || parts.length > 3 || parts.some(part => !/^\d+(?:\.\d+)?$/.test(part))) return NaN;
    if (parts.slice(0, -1).some(part => part.includes("."))) return NaN;
    if (parts.slice(1).some(part => Number(part) >= 60)) return NaN;
    return parts.reduce((seconds, part) => seconds * 60 + Number(part), 0) * 1000;
}

export function clock(ms, decimals = 2) {
    if (!Number.isFinite(ms)) return "";
    const factor = 10 ** decimals;
    const total = Math.max(0, Math.round(ms * factor / 1000));
    const hours = Math.floor(total / (3600 * factor));
    const minutes = Math.floor(total / (60 * factor)) % 60;
    const seconds = Math.floor(total / factor) % 60;
    return hours + ":" + String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0")
        + "." + String(total % factor).padStart(decimals, "0");
}

export function parseLrc(text) {
    const lines = [];
    const offset = Number(text.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/im)?.[1] || 0);
    for (const row of text.split(/\r?\n/)) {
        const tags = Array.from(row.matchAll(/\[(\d+:\d{2}(?:\.\d+)?)\]/g));
        const lyric = row.replace(/\[\d+:\d{2}(?:\.\d+)?\]/g, "").replace(/<\d+:\d{2}(?:\.\d+)?>/g, "").trim();
        if (!lyric) continue;
        for (const tag of tags) {
            const time = timestamp(tag[1]) + offset;
            if (Number.isFinite(time)) lines.push({ time, text: lyric });
        }
    }
    return lines.sort((a, b) => a.time - b.time);
}

export function makeDraft(lines, { first, last, firstEpisode, second, secondEpisode, secondMode,
    beforeCutEnd = null, start, end }) {
    if (![start, end, firstEpisode].every(Number.isFinite) || start < 0 || end <= start || firstEpisode < start || firstEpisode >= end) {
        throw Error("Enter a valid song window and place the first lyric inside it.");
    }
    if (!lines[first] || !lines[last] || last < first) throw Error("Choose a first and last line in order.");
    const firstSource = lines[first].time;
    const split = second !== null && secondMode === "shift";
    const secondSource = lines[second]?.time;
    let scale = 1;
    if (second !== null) {
        if (second <= first || second > last || !(secondSource > firstSource) || !(secondEpisode > firstEpisode) || secondEpisode >= end) {
            throw Error("The second anchor must be a later line within the selected range and song window.");
        }
        if (split) {
            const previousStart = firstEpisode + lines[second - 1].time - firstSource;
            if (secondEpisode <= previousStart) throw Error("The shifted line must start after the preceding line.");
            if (beforeCutEnd !== null && !(beforeCutEnd > previousStart && beforeCutEnd <= secondEpisode)) {
                throw Error("Set the previous line’s end between its start and the shifted line.");
            }
        } else {
            scale = (secondEpisode - firstEpisode) / (secondSource - firstSource);
        }
    }
    const episodeTime = index => split && index >= second
        ? secondEpisode + lines[index].time - secondSource
        : firstEpisode + (lines[index].time - firstSource) * scale;
    const cutoff = Math.round(end / 10) * 10;
    const rows = [];
    for (let index = first; index <= last; index++) {
        const lineStart = Math.round(episodeTime(index));
        if (Math.round(lineStart / 10) * 10 >= cutoff) break;
        const nextStart = index < last ? Math.round(episodeTime(index + 1)) : lineStart + 4000;
        const cueEnd = split && index + 1 === second ? beforeCutEnd ?? nextStart : nextStart;
        const lineEnd = Math.min(cutoff, cueEnd);
        rows.push({ text: lines[index].text, start: clock(lineStart), end: lineEnd > lineStart ? clock(lineEnd) : "", include: true });
    }
    return rows;
}

export const plainCueDuration = 3000;

export function estimatePlainStart(rows) {
    let lead = 0;
    for (const row of rows) {
        if (!row.include) continue;
        const start = timestamp(row.start);
        const end = timestamp(row.end);
        const anchor = Number.isFinite(start) ? start : end - plainCueDuration;
        if (Number.isFinite(anchor)) return Math.max(0, anchor - lead);
        lead += plainCueDuration;
    }
    return 0;
}

export function fillMissingTimes(rows, { start, end }) {
    // Work in ASS centiseconds so short gaps still produce valid, distinct cues.
    let cursor = Math.round(start / 10);
    const cutoff = Math.round(end / 10);
    if (![cursor, cutoff].every(Number.isFinite) || cursor < 0 || cutoff <= cursor) {
        throw Error("Enter a valid episode start and end for the song.");
    }

    const filled = rows.map(row => ({ ...row }));
    const pending = [];
    function fillBefore(boundary) {
        if (!pending.length) return;
        const length = Math.min(plainCueDuration / 10, Math.floor((boundary - cursor) / pending.length));
        if (length < 1) throw Error("There’s no room to fill some lines between the entered times. Adjust those times or the song window.");
        for (const row of pending) {
            const hasEnd = Boolean(row.end.trim());
            const lineStart = hasEnd ? boundary - length : cursor;
            if (!row.start.trim()) row.start = clock(lineStart * 10);
            if (!hasEnd) row.end = clock((lineStart + length) * 10);
            cursor = lineStart + length;
        }
        pending.length = 0;
    }

    for (const [index, row] of filled.entries()) {
        if (!row.include) continue;
        const lineStart = row.start.trim() ? Math.round(timestamp(row.start) / 10) : null;
        const lineEnd = row.end.trim() ? Math.round(timestamp(row.end) / 10) : null;
        if ([lineStart, lineEnd].some(time => time !== null && !Number.isFinite(time))
            || (lineStart !== null && lineEnd !== null && lineEnd <= lineStart)) {
            throw Error("Line " + (index + 1) + " needs a valid time before the blanks can be filled.");
        }
        if (lineStart !== null) {
            fillBefore(lineStart);
            cursor = lineStart;
        }
        if (lineStart === null || lineEnd === null) pending.push(row);
        if (lineEnd !== null) {
            fillBefore(lineEnd);
            cursor = lineEnd;
        }
    }
    fillBefore(cutoff);
    return filled;
}

export function srtCues(content) {
    const text = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    const stamps = /^\s*(\d+:\d{2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d+:\d{2}:\d{2}[.,]\d{1,3})(?:\s.*)?$/;
    const cues = [];
    for (const block of text.split(/\n[ \t]*\n/)) {
        const lines = block.trim().split("\n");
        const index = /^\d+$/.test(lines[0]?.trim()) ? 1 : 0;
        const match = lines[index]?.match(stamps);
        if (!match) continue;
        const start = timestamp(match[1].replace(",", "."));
        const end = timestamp(match[2].replace(",", "."));
        const caption = lines.slice(index + 1).join("\n");
        if (Number.isFinite(start) && end > start && caption) cues.push({ time: start, duration: end - start, text: caption });
    }
    return cues;
}

const srtHeader = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1280", "PlayResY: 720",
    "WrapStyle: 0", "ScaledBorderAndShadow: yes", "", "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,32,32,28,1",
].join("\n");

function srtAssText(input) {
    const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
    const token = /<(\/?)([bius])\s*>|<br\s*\/?>|<\/?font\b[^>]*>|\{\\an([1-9])\}/gi;
    const colorStack = [];
    const styles = { b: 0, i: 0, u: 0, s: 0 };
    const colors = { white: "ffffff", black: "000000", red: "ff0000", green: "008000", blue: "0000ff",
        yellow: "ffff00", cyan: "00ffff", magenta: "ff00ff" };
    function plain(value) {
        return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code) => {
            if (!code.startsWith("#")) return entities[code.toLowerCase()];
            const hex = code[1].toLowerCase() === "x";
            const point = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
            return point > 0 && point <= 0x10ffff && (point < 0xd800 || point > 0xdfff) && point !== 13
                && (point >= 32 || point === 9 || point === 10) ? String.fromCodePoint(point) : entity;
        }).replace(/\\/g, "＼").replace(/\{/g, "｛").replace(/\}/g, "｝").replace(/\r\n?|\n/g, "\\N");
    }
    let result = "", cursor = 0;
    for (const match of input.matchAll(token)) {
        result += plain(input.slice(cursor, match.index));
        cursor = match.index + match[0].length;
        if (match[2]) {
            const tag = match[2].toLowerCase();
            styles[tag] = match[1] ? Math.max(0, styles[tag] - 1) : styles[tag] + 1;
            result += "{\\" + tag + Number(styles[tag] > 0) + "}";
        } else if (match[3]) result += "{\\an" + match[3] + "}";
        else if (/^<br/i.test(match[0])) result += "\\N";
        else {
            const original = colorStack.at(-1);
            if (/^<\//.test(match[0])) colorStack.pop();
            else {
                const value = match[0].match(/\bcolor\s*=\s*(?:["']([^"']+)["']|([^>\s]+))/i);
                const raw = (value?.[1] || value?.[2] || "").toLowerCase();
                let rgb = /^(?:#?[0-9a-f]{6}|#[0-9a-f]{3})$/.test(raw) ? raw.replace("#", "")
                    : Object.hasOwn(colors, raw) ? colors[raw] : "";
                if (rgb?.length === 3) rgb = rgb.replace(/./g, c => c + c);
                colorStack.push(rgb ? rgb.match(/../g).reverse().join("") : original);
            }
            const color = colorStack.at(-1);
            if (color !== original) result += color ? "{\\1c&H" + color + "&}" : "{\\1c}";
        }
    }
    return result + plain(input.slice(cursor));
}

// Matroska supplies styled dialogue separately. SRT tracks use a default ASS style.
export function originalAss(track) {
    const srt = track.type === "utf8";
    const header = srt ? srtHeader : track.header.replace(/\r\n/g, "\n").trimEnd();
    const lines = track.cues.map(cue => [
        cue.layer || 0, clock(cue.time), clock(cue.time + cue.duration), cue.style || "Default",
        cue.name || "", cue.marginL || 0, cue.marginR || 0, cue.marginV || 0, cue.effect || "",
        srt ? srtAssText(cue.text) : cue.text,
    ]);
    const events = header.includes("[Events]") ? header : header + "\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text";
    if (lines.some(line => !line[1] || !line[2])) throw Error("The MKV contains an ASS cue without a usable timestamp.");
    return events + "\n" + lines.map(line => "Dialogue: " + line.join(",")).join("\n") + "\n";
}

export function validatedCues(slots, duration) {
    const cues = [];
    for (const [slot, rows] of Object.entries(slots)) {
        for (const [index, row] of rows.entries()) {
            if (!row.include) continue;
            const start = Math.round(timestamp(row.start) / 10) * 10;
            const end = Math.round(timestamp(row.end) / 10) * 10;
            if (![start, end].every(Number.isFinite) || !(end > start) || (duration && end > Math.ceil(duration / 10) * 10)) {
                throw Error(slot + " line " + (index + 1) + " needs a valid start and end inside the episode.");
            }
            if (!row.text.trim() && !row.events?.length) throw Error(slot + " line " + (index + 1) + " needs lyric text.");
            cues.push({ slot, start, end, text: row.text, events: row.events });
        }
    }
    return cues.sort((a, b) => a.start - b.start);
}

export function mergedAss(original, cues, furigana = "above") {
    if (!cues.length) return original;
    const events = original.indexOf("[Events]");
    if (events < 0 || !original.includes("[V4+ Styles]")) throw Error("ASS script has no standard style and event sections.");
    let style = "OPED_Lyrics";
    while (original.includes("Style: " + style + ",")) style += "_";
    const scriptX = Number(original.match(/^PlayResX:\s*(\d+)/im)?.[1]);
    const scriptY = Number(original.match(/^PlayResY:\s*(\d+)/im)?.[1]);
    const height = scriptY || (scriptX === 1280 ? 1024 : scriptX ? Math.round(scriptX * 3 / 4) : 288);
    const width = scriptX || (height === 1024 ? 1280 : Math.round(height * 4 / 3));
    const size = Math.max(16, Math.round(height * .063));
    const margin = Math.round(height * .04);
    const definition = "Style: " + style + ",Arial," + size
        + ",&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,8,12,12," + margin + ",1";
    const definitions = [definition.slice(7)];
    const styleNames = new Map();
    function importedStyle(event) {
        if (styleNames.has(event.definition)) return styleNames.get(event.definition);
        const suffix = event.definition.slice(event.definition.indexOf(","));
        let name = event.style;
        const existing = [...original.matchAll(/^Style: (.+)$/gm)].map(match => match[1].trimEnd()).concat(definitions);
        while (existing.some(value => value.startsWith(name + ",") && value !== name + suffix)) name += "_";
        if (!existing.includes(name + suffix)) definitions.push(name + suffix);
        styleNames.set(event.definition, name);
        return name;
    }
    let active = [];
    const dialogue = [];
    for (const cue of cues) {
        if (cue.events?.length) {
            for (const event of cue.events) {
                dialogue.push("Dialogue: " + [event.layer, clock(cue.start), clock(cue.end), importedStyle(event),
                    event.actor, event.left, event.right, event.vertical, event.effect, event.content].join(","));
            }
            continue;
        }
        active = active.filter(item => item.end > cue.start);
        const top = Math.max(margin, ...active.map(item => item.bottom));
        const ruby = furigana === "above" && /《|<ruby\b/i.test(cue.text);
        const layout = furigana === "above" && (ruby || active.some(item => item.positioned))
            ? positionedLyrics(cue.text, width, size, margin, top) : null;
        const lines = layout?.events ?? [assLyric(cue.text, furigana)];
        for (const line of lines) {
            dialogue.push("Dialogue: " + [0, clock(cue.start), clock(cue.end), style, cue.slot, 0, 0, 0, "", line].join(","));
        }
        active.push({ end: cue.end, bottom: layout?.bottom ?? top + size * cue.text.split(/\r?\n/).length + 3,
            positioned: Boolean(layout) });
    }
    const withStyle = original.replace(/(\[V4\+ Styles\][\s\S]*?)(?=\n\[|$)/, section =>
        section.trimEnd() + "\n" + definitions.map(value => value.startsWith("Style: ") ? value : "Style: " + value).join("\n") + "\n");
    return withStyle.trimEnd() + "\n" + dialogue.join("\n") + "\n";
}
