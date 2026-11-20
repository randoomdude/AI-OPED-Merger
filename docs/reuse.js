import { clock, timestamp } from "./timing.js";

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
