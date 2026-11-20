import { timestamp } from "./timing.js";
import { rubyMarkup } from "./furigana.js";

export async function fetchCaptions(url, signal) {
    const response = await fetch(url, { credentials: "omit", redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(18000)]) });
    if (!response.ok) throw Error("Jimaku returned HTTP " + response.status + ".");
    const max = 5 * 1024 * 1024;
    const reader = response.body.getReader();
    const parts = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > max) throw Error("This subtitle file is larger than 5 MB.");
            parts.push(value);
        }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
    if (bytes[0] === 255 && bytes[1] === 254) return new TextDecoder("utf-16le").decode(bytes);
    if (bytes[0] === 254 && bytes[1] === 255) return new TextDecoder("utf-16be").decode(bytes);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return new TextDecoder("shift_jis").decode(bytes); }
}

export function parseCaptions(content, name) {
    const cues = [];
    const clean = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    function add(start, end, raw, style = "") {
        const text = rubyMarkup(raw).replace(/<\/?(?:b|i|u|s|font)(?:\s[^>]*)?>/gi, "")
            .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
        if (Number.isFinite(start) && end > start && text) cues.push({ start, end, text, style });
    }
    if (/\.srt$/i.test(name)) {
        for (const block of clean.split(/\n[ \t]*\n/)) {
            const lines = block.trim().split("\n");
            const idx = lines.findIndex(line => line.includes("-->"));
            const times = idx >= 0 && lines[idx].match(/^\s*(\d+:\d{2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d+:\d{2}:\d{2}[.,]\d{1,3})/);
            if (times) add(timestamp(times[1].replace(",", ".")), timestamp(times[2].replace(",", ".")), lines.slice(idx + 1).join("\n"));
        }
    } else {
        let fields = [], events = false;
        for (const line of clean.split("\n")) {
            if (/^\s*\[/.test(line)) events = /^\s*\[Events\]\s*$/i.test(line);
            if (!events) continue;
            if (/^Format:/i.test(line)) fields = line.slice(7).toLowerCase().split(",").map(f => f.trim());
            if (!/^Dialogue:/i.test(line) || fields.at(-1) !== "text") continue;
            const values = line.slice(9).split(",");
            const raw = values.slice(fields.length - 1).join(",");
            if (/\{[^}]*\\p[1-9]/.test(raw)) continue;
            add(timestamp(values[fields.indexOf("start")]), timestamp(values[fields.indexOf("end")]),
                raw.replace(/\{[^}]*\}/g, "").replace(/\\[Nn]/g, "\n").replace(/\\h/g, " "), values[fields.indexOf("style")] || "");
        }
    }
    if (!cues.length) throw Error("No readable timed captions were found in this file.");
    return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}

function musicMarker(text) {
    const s = text.normalize("NFKC").replace(/\s/g, "");
    if (/^[♪♫♬]+[~〜ー]+$/.test(s)) return "start";
    if (/^[~〜ー]+[♪♫♬]+$/.test(s)) return "end";
    return /^[♪♫♬~〜ー]+$/.test(s) ? "music" : "";
}

export function suggestedWindow(cues, slot, duration, offset = 0) {
    if (!Number.isFinite(duration)) return null;
    let first;
    const pairs = [];
    for (const cue of cues) {
        const marker = musicMarker(cue.text);
        if (marker === "start") first = cue;
        if (marker === "end" && first) {
            const start = Math.max(0, first.start + offset), end = Math.min(cue.end + offset, duration);
            if (end - start >= 60_000 && end - start <= 120_000 &&
                (slot === "OP" ? start < duration / 2 : start >= duration / 2)) pairs.push({ start, end });
            first = null;
        }
    }
    return pairs.length === 1 ? pairs[0] : null;
}

export function lyricWindows(cues, slot, duration) {
    const groups = [];
    for (const cue of cues) {
        if (musicMarker(cue.text) || !(/[♪♫♬]/.test(cue.text) ||
            /(?:^|[^a-z])(?:op|ed|opening|ending|karaoke|lyrics?|songs?)(?:$|[^a-z])/i.test(cue.style))) continue;
        const last = groups.at(-1);
        if (last && cue.start <= last.end + 12_000) {
            last.end = Math.max(last.end, cue.end);
            last.count++;
        } else groups.push({ start: cue.start, end: cue.end, count: 1 });
    }
    return groups.filter(g => g.count >= 3 && g.end - g.start >= 20_000 && g.end - g.start <= 125_000 &&
        (slot === "OP" ? g.start < duration / 2 : g.start >= duration / 2) && g.end > 0 && g.start < duration)
        .map(g => ({ start: Math.max(0, g.start), end: Math.min(duration, g.end) }));
}

export function windowCaptions(cues, start, end) {
    const seen = new Set();
    return cues.filter(cue => cue.start < end && cue.end > start && !musicMarker(cue.text))
        .map(cue => ({ ...cue, start: Math.max(start, cue.start), end: Math.min(end, cue.end) }))
        .filter(cue => {
            const key = JSON.stringify([cue.start, cue.end, cue.text]);
            if (seen.has(key) || Math.round(cue.end / 10) <= Math.round(cue.start / 10)) return false;
            seen.add(key);
            return true;
        });
}
