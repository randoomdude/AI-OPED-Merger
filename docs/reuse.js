import { clock, plainCueDuration, timestamp } from "./timing.js";

export function shiftRows(rows, delta, duration) {
    if (!Number.isFinite(delta)) throw Error("Enter both song start times.");
    return rows.map(row => {
        const next = { ...row };
        for (const key of ["start", "end"]) {
            if (!row[key]) continue;
            const value = timestamp(row[key]) + delta;
            if (!Number.isFinite(value) || value < 0 || value > Math.ceil(duration / 10) * 10)
                throw Error("The offset would move a subtitle outside this episode.");
            next[key] = clock(value);
        }
        return next;
    });
}

export function alignDraftStart(rows, playhead, duration, following) {
    const [anchor, ...later] = rows;
    const priorStart = timestamp(anchor.start);
    const priorEnd = timestamp(anchor.end);
    const start = Math.round(playhead / 10) * 10;
    const limit = Number.isFinite(duration) ? Math.ceil(duration / 10) * 10 : Infinity;
    if (!Number.isFinite(start) || start < 0 || start >= limit) {
        throw Error("Set the playhead to a time inside the episode.");
    }
    if (following && !Number.isFinite(priorStart)) {
        throw Error("Enter a start time for this line before shifting the following lines.");
    }
    const tail = following ? shiftRows(later, start - priorStart, limit) : later;
    let end;
    if (Number.isFinite(priorStart) && priorEnd > priorStart) {
        end = start + priorEnd - priorStart;
    } else if (!Number.isFinite(priorStart) && priorEnd > start) {
        end = priorEnd;
    } else {
        const next = tail.find(row => row.include && timestamp(row.start) > start);
        end = Math.min(start + plainCueDuration, next ? timestamp(next.start) : Infinity, limit);
    }
    end = Math.max(start + 10, Math.round(end / 10) * 10);
    if (end > limit) throw Error("The offset would move a subtitle outside this episode.");
    const first = { ...anchor, start: clock(start), end: clock(end) };
    return following ? [first, ...tail] : [first];
}

// ASS Text is the final field and may itself contain commas.
export function songRows(script, slot) {
    const styles = new Map();
    const groups = new Map();
    for (const line of script.split(/\r?\n/)) {
        if (line.startsWith("Style: ")) {
            const definition = line.slice(7);
            styles.set(definition.split(",")[0], definition);
        }
        if (!line.startsWith("Dialogue: ")) continue;
        const fields = line.slice(10).split(",");
        const [layer, start, end, style, actor, left, right, vertical, effect] = fields;
        const label = slot === "OP" ? /^(?:OP|Opening)(?:[ _-]?\d+)?$/i : /^(?:ED|Ending)(?:[ _-]?\d+)?$/i;
        if (!label.test(actor) && !label.test(style)) continue;
        if (fields.length < 10 || !styles.has(style) || !(timestamp(end) > timestamp(start)))
            throw Error("A song event has an invalid time or missing ASS style.");
        const key = start + "/" + end;
        const content = fields.slice(9).join(",");
        const row = groups.get(key) ?? { start, end, text: "", include: true, events: [] };
        row.events.push({layer, style, actor, left, right, vertical, effect, content, definition: styles.get(style)});
        const visible = content.replace(/\{[^}]*\}/g, "").replace(/\\[Nnh]/g, " ");
        row.text += visible;
        groups.set(key, row);
    }
    return [...groups.values()].sort((a, b) => timestamp(a.start) - timestamp(b.start));
}
