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

export function lyricForms(input) {
    const value = rubyMarkup(input);
    const pattern = /(?:[｜|]([^｜|《》\r\n]+)|([\p{Script=Han}々〆ヶ]+))《([^《》\r\n]+)》/gu;
    let base = "", reading = "", inline = "", offset = 0;
    for (const match of value.matchAll(pattern)) {
        const prefix = value.slice(offset, match.index);
        const word = match[1] ?? match[2];
        base += prefix + word;
        reading += prefix + match[3];
        inline += prefix + word + "（" + match[3] + "）";
        offset = match.index + match[0].length;
    }
    const tail = value.slice(offset);
    return { base: base + tail, reading: reading + tail, inline: inline + tail, annotated: offset > 0 };
}

function safeText(s) {
    return s.replace(/\\/g, "＼").replace(/\{/g, "｛").replace(/\}/g, "｝").replace(/\r?\n/g, "\\N");
}

export function assLyric(input, mode, size) {
    return input.split(/\r?\n/).map(line => {
        const forms = lyricForms(line);
        if (!forms.annotated || mode === "base") return safeText(forms.base);
        if (mode === "inline") return safeText(forms.inline);
        return "{\\fs" + Math.round(size * 0.62) + "}" + safeText(forms.reading)
            + "\\N{\\fs" + size + "}" + safeText(forms.base);
    }).join("\\N");
}
