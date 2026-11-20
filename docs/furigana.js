// A template fragment keeps pasted markup inert. Only text and ruby readings are copied out.
export function rubyMarkup(input) {
    if (!/<ruby\b/i.test(input)) return input;
    const template = document.createElement("template");
    template.innerHTML = input;
    function walk(node) {
        if (node.nodeType === 3) return node.data;
        if (["SCRIPT", "STYLE", "RP", "RT", "RTC"].includes(node.nodeName)) return "";
        if (node.nodeName === "BR") return "\n";
        if (node.nodeName === "RUBY") {
            let base = "", result = "";
            for (const part of node.childNodes) {
                if (part.nodeName === "RT" && base.trim()) {
                    const reading = part.textContent.trim();
                    result += reading ? "｜" + base.trim() + "《" + reading + "》" : base;
                    base = "";
                } else base += walk(part);
            }
            return result + base;
        }
        const value = [...node.childNodes].map(walk).join("");
        return ["P", "DIV", "LI", "TR"].includes(node.nodeName) ? value + "\n" : value;
    }
    return walk(template.content).trim();
}

function lyricRuns(input) {
    const value = rubyMarkup(input);
    const pattern = /(?:[｜|]([^｜|《》\r\n]+)|([\p{Script=Han}々〆ヶ]+))《([^《》\r\n]+)》/gu;
    const runs = [];
    let offset = 0;
    for (const match of value.matchAll(pattern)) {
        if (match.index > offset) runs.push({ base: value.slice(offset, match.index) });
        runs.push({ base: match[1] ?? match[2], ruby: match[3] });
        offset = match.index + match[0].length;
    }
    if (offset < value.length) runs.push({ base: value.slice(offset) });
    return runs;
}

export function lyricForms(input) {
    const runs = lyricRuns(input);
    return {
        base: runs.map(run => run.base).join(""),
        inline: runs.map(run => run.ruby ? run.base + "（" + run.ruby + "）" : run.base).join(""),
    };
}

function safeText(s) {
    return s.replace(/\\/g, "＼").replace(/\{/g, "｛").replace(/\}/g, "｝").replace(/\r?\n/g, "\\N");
}

export function assLyric(input, mode) {
    const forms = lyricForms(input);
    return safeText(mode === "inline" ? forms.inline : forms.base);
}

// Measure at one large size and convert the font's complete line height to ASS script units.
const rubyFont = "Meiryo";
let context;
function emWidth(text) {
    context ??= document.createElement("canvas").getContext("2d");
    context.font = "200px " + rubyFont + ", sans-serif";
    const metric = context.measureText(text);
    const height = metric.fontBoundingBoxAscent + metric.fontBoundingBoxDescent;
    return metric.width / (height || 200);
}

function wrapRuns(runs, size, small, limit) {
    const rows = [];
    let row = { cells: [], width: 0 };
    function append(base, ruby) {
        const width = Math.max(emWidth(base) * size, ruby ? emWidth(ruby) * small : 0);
        if (row.width && row.width + width > limit) {
            rows.push(row);
            row = { cells: [], width: 0 };
        }
        const scale = width > limit ? limit / width : 1;
        row.cells.push({ base, ruby, width: width * scale, scale });
        row.width += width * scale;
    }
    for (const { base, ruby } of runs) {
        if (ruby || emWidth(base) * size <= limit) append(base, ruby);
        else {
            for (const part of base.match(/[A-Za-z0-9']+|\s+|./gu) || []) append(part);
        }
    }
    rows.push(row);
    return rows;
}

// Each <rt> and its own base share a horizontal center. Plain runs have no reading event.
export function positionedLyrics(input, width, size, margin, top) {
    const small = Math.max(8, Math.round(size * 0.55));
    const events = [];
    let y = top;
    for (const line of input.split(/\r?\n/)) {
        const rows = wrapRuns(lyricRuns(line), size, small, Math.max(1, width - 2 * margin));
        for (const row of rows) {
            const hasRuby = row.cells.some(cell => cell.ruby);
            const baseY = y + (hasRuby ? small + Math.max(1, size * 0.06) : 0);
            let left = (width - row.width) / 2;
            for (const cell of row.cells) {
                const x = (left + cell.width / 2).toFixed(2);
                const scale = cell.scale < 1 ? "\\fscx" + (cell.scale * 100).toFixed(2) : "";
                function place(value, at, fontSize, outline) {
                    if (!value.trim()) return;
                    const txt = safeText(value).replace(/^ +| +$/g, spaces => "\\h".repeat(spaces.length));
                    events.push("{\\an8\\q2\\pos(" + x + "," + at.toFixed(2) + ")\\fn" + rubyFont
                        + "\\fs" + fontSize + scale + outline + "}" + txt);
                }
                place(cell.base, baseY, size, "");
                if (cell.ruby) place(cell.ruby, y, small, "\\bord" + Math.max(0.7, size / 24).toFixed(2));
                left += cell.width;
            }
            y = baseY + size + Math.max(2, size * 0.1);
        }
    }
    return { events, bottom: y };
}
