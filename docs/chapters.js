// A release can label its cold open "Intro" and still have a separate opening song.
const markers = {
    OP: /(?:^|[^a-z0-9])(?:op(?:ening)?|ncop)(?:\s*\d+)?(?![a-z0-9])|オープニング|主題歌OP/i,
    ED: /(?:^|[^a-z0-9])(?:ed|ending|nced)(?:\s*\d+)?(?![a-z0-9])|エンディング|主題歌ED/i,
};
const aliases = { OP: /^intro(?:\s*\d+)?$/i, ED: /^(?:end\s+credits|credits|outro)(?:\s*\d+)?$/i };
const transition = /\b(?:before|after|pre|post)[\s_-]*(?:op|ed|opening|ending)\b|(?:OP|ED)(?:後|前)/i;
const generic = /^(?:(?:chapter|chap\.?|ch\.?|チャプター|第)?[\s._#-]*\d+(?:章)?|untitled)?$/i;

export function findChapter(chapters, slot) {
    const names = ch => (ch.titles?.length ? ch.titles : [ch.title || ""]).map(s => s.normalize("NFKC").trim());
    const other = slot === "OP" ? "ED" : "OP";
    for (const ch of chapters) {
        const label = names(ch).find(s => markers[slot].test(s) && !markers[other].test(s) && !transition.test(s));
        if (label) return { ...ch, title: label };
    }
    const alias = chapters.find(ch => names(ch).some(s => aliases[slot].test(s)));
    const second = chapters[1];
    if (slot === "OP" && chapters.length >= 4 && names(second).every(s => generic.test(s)) &&
        second.start <= 10 * 60_000 && second.end - second.start >= 60_000 && second.end - second.start <= 120_000 &&
        (!alias || alias.start === 0 && Math.abs(alias.end - alias.start - 90_000) > 5_000)) {
        return { ...second, inferred: true };
    }
    return alias;
}
