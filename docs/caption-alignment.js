// Compare dialogue timing across releases without requiring the same subtitle language.
export function dialogueIntervals(track) {
    return track.cues.filter(cue => cue.duration > 0 && cue.text?.trim() &&
        !/(?:sign|screen.text|on.screen|credits|karaoke|typeset)/i.test(cue.style || "") &&
        !/\{[^}]*\\(?:p[1-9]|pos\(|move\()/.test(cue.text))
        .map(cue => ({ start: cue.time, end: cue.time + cue.duration })).sort((a, b) => a.start - b.start);
}

export function overlapsDialogue(cue, dialogue) {
    return dialogue.some(line => line.start < cue.end && line.end > cue.start);
}

export function songGaps(dialogue, slot, duration) {
    if (!dialogue.length || !Number.isFinite(duration)) return [];
    const gaps = [];
    let end = 0;
    for (const next of [...dialogue, { start: duration, end: duration }]) {
        const start = Math.min(next.start, duration);
        const midpoint = (end + start) / 2;
        if (start - end > 90_000 && (slot === "OP" ? midpoint < duration / 2 : midpoint >= duration / 2)) {
            gaps.push({ start: end, end: start });
        }
        end = Math.max(end, next.end);
    }
    return gaps;
}

export function dialogueOffset(captions, dialogue, range) {
    const nearby = time => time >= range.start - 180_000 && time <= range.end + 180_000;
    const outside = time => time < range.start || time >= range.end;
    const source = [...new Set(captions.map(c => c.start).filter(t => nearby(t) && outside(t)))];
    const local = [...new Set(dialogue.map(c => c.start).filter(nearby))];
    if (source.length < 7 || local.length < 7) return null;
    const bins = new Map();
    for (const src of source) {
        for (const dst of local) {
            const diff = dst - src;
            if (diff < -20_000) continue;
            if (diff > 20_000) break;
            const key = Math.round(diff / 250) * 250;
            bins.set(key, (bins.get(key) || 0) + 1);
        }
    }
    function score(offset) {
        let cursor = 0;
        const differences = [];
        let weight = 0;
        for (const t of source) {
            const expected = t + offset;
            while (local[cursor] < expected - 450) cursor++;
            if (cursor >= local.length || local[cursor] > expected + 450) continue;
            while (cursor + 1 < local.length && Math.abs(local[cursor + 1] - expected) < Math.abs(local[cursor] - expected)) cursor++;
            const diff = local[cursor++] - t;
            differences.push(diff);
            weight += 1 - Math.abs(diff - offset) / 900;
        }
        differences.sort((a, b) => a - b);
        return { offset: differences[Math.floor(differences.length / 2)], count: differences.length, weight };
    }
    const scores = [...bins].sort((a, b) => b[1] - a[1]).slice(0, 20)
        .map(([offset]) => score(offset)).filter(s => s.count >= 7)
        .map(s => score(s.offset)).sort((a, b) => b.weight - a.weight);
    const best = scores[0];
    if (!best || best.count < Math.min(source.length, local.length) * 0.35 ||
        scores.some(other => Math.abs(other.offset - best.offset) > 900 && other.weight > best.weight * 0.85)) return null;
    return best;
}

