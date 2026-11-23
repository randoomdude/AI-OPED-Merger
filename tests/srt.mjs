import assert from "node:assert/strict";
import test from "node:test";
import { srtCues, originalAss, mergedAss } from "../docs/timing.js";

test("SRT timestamps, multiline dialogue and formatting survive an ASS export", () => {
    const cues = srtCues("\ufeff1\r\n00:01:02,345 --> 00:01:04,450\r\n<i>Café &amp; tea</i>\r\n<font color=\"#f00\">赤</font>, ok\r\n\r\n" +
        "3\n00:01:05.00 --> 00:01:06.75\n{\\an8}Top <b>text</b> &#x1f3b5;");
    assert.equal(cues.length, 2);
    assert.equal(Math.round(cues[0].time), 62345);
    const ass = originalAss({ type: "utf8", cues });
    assert.match(ass, /\[V4\+ Styles\]/);
    assert.ok(ass.includes("0:01:02.35,0:01:04.45,Default,,0,0,0,,{\\i1}Café & tea{\\i0}\\N{\\1c&H0000ff&}赤{\\1c}, ok"));
    assert.ok(ass.includes("0:01:05.00,0:01:06.75,Default,,0,0,0,,{\\an8}Top {\\b1}text{\\b0} 🎵"));
    const result = mergedAss(ass, [{ slot: "OP", start: 1000, end: 2000, text: "Test lyric" }]);
    assert.equal((result.match(/^Dialogue:/gm) || []).length, 3);
});

test("plain SRT text cannot introduce ASS overrides", () => {
    const [cue] = srtCues("00:00:01,000 --> 00:00:02,000\n&lt;b&gt; {\\p1} C:\\path");
    assert.ok(originalAss({ type: "utf8", cues: [cue] }).includes("<b> ｛＼p1｝ C:＼path"));
    assert.deepEqual(srtCues("1\n00:00:02,000 --> 00:00:01,000\nInvalid"), []);
});
