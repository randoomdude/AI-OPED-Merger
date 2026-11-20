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

// Matroska supplies the ASS script and the dialogue fields separately.
export function originalAss(track) {
    const header = track.header.replace(/\r\n/g, "\n").trimEnd();
    const lines = track.cues.map(cue => [
        cue.layer || 0, clock(cue.time), clock(cue.time + cue.duration), cue.style || "Default",
        cue.name || "", cue.marginL || 0, cue.marginR || 0, cue.marginV || 0, cue.effect || "", cue.text,
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
            if (!row.text.trim()) throw Error(slot + " line " + (index + 1) + " needs lyric text.");
            cues.push({ slot, start, end, text: row.text });
        }
    }
    return cues.sort((a, b) => a.start - b.start);
}

export function mergedAss(original, cues) {
    if (!cues.length) return original;
    const events = original.indexOf("[Events]");
    if (events < 0 || !original.includes("[V4+ Styles]")) throw Error("ASS script has no standard style and event sections.");
    let style = "OPED_Lyrics";
    while (original.includes("Style: " + style + ",")) style += "_";
    const height = Number(original.match(/^PlayResY:\s*(\d+)/im)?.[1] || 360);
    const size = Math.max(16, Math.round(height * .063));
    const margin = Math.round(height * .04);
    const definition = "Style: " + style + ",Arial," + size
        + ",&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,8,12,12," + margin + ",1";
    const withStyle = original.slice(0, events).trimEnd() + "\n" + definition + "\n\n" + original.slice(events);
    // Lyrics are plain text. Full-width braces and slashes cannot become ASS overrides.
    return withStyle.trimEnd() + "\n" + cues.map(cue => {
        const text = cue.text.replace(/\\/g, "＼").replace(/\{/g, "｛").replace(/\}/g, "｝").replace(/\r?\n/g, "\\N");
        return "Dialogue: " + [0, clock(cue.start), clock(cue.end), style, cue.slot, 0, 0, 0, "", text].join(",");
    }).join("\n") + "\n";
}
