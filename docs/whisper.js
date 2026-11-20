import { lyricForms } from "./furigana.js";
import { clock } from "./timing.js";

export function readWhisperTiming(data, file, slot, duration) {
    if (data?.format !== "ai-oped-whisper" || data.version !== 1) throw Error("Choose a timing JSON file from the Whisper helper.");
    if (data.mkv !== file.name || data.mkv_size !== file.size || data.slot !== slot) {
        throw Error("Open the same MKV and choose the opening or ending used in the Whisper helper.");
    }
    const { start_ms: start, end_ms: end, segments } = data;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start
        || (duration && end > Math.ceil(duration / 10) * 10)) {
        throw Error("The Whisper timing window falls outside the episode.");
    }
    function validCue(cue, minimumDuration) {
        return cue && Number.isSafeInteger(cue.start_ms) && Number.isSafeInteger(cue.end_ms)
            && cue.start_ms >= start && cue.end_ms <= end && cue.end_ms - cue.start_ms >= minimumDuration
            && typeof cue.text === "string" && cue.text.trim();
    }
    if (!Array.isArray(segments) || !segments.length || segments.length > 1000 || segments.some(segment =>
        !validCue(segment, 1) || !Array.isArray(segment.words) || segment.words.length > 3000
        || segment.words.some(word => !validCue(word, 0)))) {
        throw Error("The Whisper timing file is empty or contains invalid cues.");
    }
    return data;
}

function draftRow(text, start, end) {
    const hasDuration = Math.round(end / 10) > Math.round(start / 10);
    return { text, start: hasDuration ? clock(start) : "", end: hasDuration ? clock(end) : "", include: hasDuration };
}

function transcriptRows(segments) {
    const rows = [];
    for (const segment of segments) {
        if (!segment.words.length) {
            rows.push(draftRow(segment.text, segment.start_ms, segment.end_ms));
            continue;
        }
        let text = "";
        let start;
        let end;
        for (const word of segment.words) {
            if (text && (word.start_ms - end >= 450 || word.end_ms - start > 5000 || text.length + word.text.length > 36
                || /[。！？!?]\s*$/.test(text))) {
                rows.push(draftRow(text.trim(), start, end));
                text = "";
            }
            if (!text) start = word.start_ms;
            text += word.text;
            end = word.end_ms;
        }
        if (text) rows.push(draftRow(text.trim(), start, end));
    }
    return rows;
}

function characters(text) {
    return [...text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")].map(char => {
        const code = char.charCodeAt(0);
        return code >= 0x30a1 && code <= 0x30f6 ? String.fromCharCode(code - 0x60) : char;
    });
}

function timedCharacters(segments) {
    const words = segments.flatMap(segment => segment.words).sort((a, b) => a.start_ms - b.start_ms);
    return words.flatMap(word => {
        const chars = characters(word.text);
        const duration = (word.end_ms - word.start_ms) / chars.length;
        return chars.map((char, index) => ({
            char, start: word.start_ms + index * duration, end: word.start_ms + (index + 1) * duration,
        }));
    });
}

// Keep matches in song order and favor nearby words within each lyric line.
function matchLines(lines, audio) {
    const matchScore = 5;
    const reference = lines.flatMap((chars, line) => chars.map((char, index) => ({ char, line, gapCost: index ? 2 : 0 })));
    const width = audio.length + 1;
    if ((reference.length + 1) * width > 6_000_000) throw Error("Use a shorter lyrics excerpt or a smaller song window to match timing.");
    const scores = new Uint16Array((reference.length + 1) * width);
    for (let i = reference.length - 1; i >= 0; i--) {
        for (let j = audio.length - 1; j >= 0; j--) {
            const cell = i * width + j;
            const together = reference[i].char === audio[j].char ? matchScore + scores[cell + width + 1] : 0;
            scores[cell] = Math.max(together, scores[cell + width], scores[cell + 1] - reference[i].gapCost);
        }
    }
    const matches = lines.map(() => []);
    let i = 0;
    let j = 0;
    while (i < reference.length && j < audio.length) {
        const cell = i * width + j;
        if (reference[i].char === audio[j].char && scores[cell] === matchScore + scores[cell + width + 1]) {
            matches[reference[i].line].push(j);
            i++;
            j++;
        } else if (scores[cell + width] > scores[cell + 1] - reference[i].gapCost) {
            i++;
        } else {
            j++;
        }
    }
    return matches;
}

// The older ASS exporter put a smaller reading above the complete sung line.
function referenceText(row) {
    if (!row.events?.length) return lyricForms(row.text).base;
    return row.events.map(({content}) => {
        const legacy = content.match(/^\{\\fs(\d+)\}.*?\\N\{\\fs(\d+)\}([\s\S]*)$/);
        if (legacy && Number(legacy[1]) < Number(legacy[2])) return legacy[3];
        // Positioned ruby events in the current exporter use a custom thin border.
        if (/^\{\\an8\\q2\\pos\([^}]+\\fnMeiryo[^}]+\\bord[\d.]+\}/.test(content)) return "";
        return content;
    }).join("").replace(/\{[^}]*\}/g, "").replace(/\\[Nnh]/g, " ");
}

export function whisperDraft(data, reference) {
    if (!reference.length) {
        const rows = transcriptRows(data.segments);
        return { rows, matched: rows.filter(row => row.include).length };
    }
    const audio = timedCharacters(data.segments);
    const lines = reference.map(row => row.include ? characters(referenceText(row)) : []);
    const matches = matchLines(lines, audio);
    // An unambiguous exact phrase can move across other lines in the TV edit.
    const audioText = audio.map(item => item.char).join("");
    const phrases = lines.map(chars => chars.join(""));
    const owners = new Int32Array(audio.length).fill(-1);
    const exact = phrases.map((phrase, index) => {
        if (phrase.length < 5 || phrases.filter(value => value.includes(phrase)).length !== 1) return null;
        const offset = audioText.indexOf(phrase);
        if (offset < 0 || audioText.indexOf(phrase, offset + 1) !== -1) return null;
        const first = Array.from(audioText.slice(0, offset)).length;
        const hits = lines[index].map((_, j) => first + j);
        if (hits.some((hit, j) => j && audio[hit].start - audio[hit - 1].end > 1500)) return null;
        return hits;
    });
    exact.forEach((hits, index) => hits?.forEach(hit => { owners[hit] = owners[hit] === -1 ? index : -2; }));
    let matched = 0;
    const rows = reference.map((row, index) => {
        if (!row.include) return row;
        const hits = exact[index] ?? matches[index];
        if (hits.some(hit => owners[hit] !== -1 && owners[hit] !== index)) return row;
        const first = hits[0];
        const last = hits.at(-1);
        const length = lines[index].length;
        const threshold = length <= 4 ? length : Math.ceil(length * 0.75);
        if (hits.length && hits.length >= threshold && hits.length >= (last - first + 1) * 0.75 && !hits.some((hit, j) => j && audio[hit].start - audio[hits[j-1]].end > 1500)) {
            const cue = draftRow(row.text, audio[first].start, audio[last].end);
            if (cue.include) {
                matched++;
                return { ...row, start: cue.start, end: cue.end };
            }
        }
        return row;
    });
    return { rows, matched };
}
