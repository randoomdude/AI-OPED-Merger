import assert from "node:assert/strict";
import test from "node:test";
import { findChapter } from "../docs/chapters.js";

const chapters = (titles, starts) => titles.map((title, i) => ({
    title, start: starts[i] * 1000, end: starts[i + 1] * 1000,
}));

test("Toaru episode 3 uses its labeled songs before Intro and the next episode preview", () => {
    const list = chapters(["Intro", "OP", "Part A", "Part B", "ED", "Next Episode"],
        [0, 107, 196.97, 715.95, 1324.97, 1414.98, 1420]);
    assert.equal(findChapter(list, "OP").start, 107000);
    assert.equal(findChapter(list, "ED").start, 1324970);
});

test("recognizes decorated or translated names and ignores pre/post-song chapters", () => {
    const list = chapters(["Before OP", "Chapter 02", "Post-ED", "ＥＤ２ — Credits"], [0, 40, 130, 700, 790]);
    list[1].titles = ["Chapter 02", "オープニングテーマ「Song」"];
    assert.equal(findChapter(list, "OP").start, 40000);
    assert.equal(findChapter(list, "ED").start, 700000);
});

test("uses chapter two as an estimate only for a plausible unlabeled opening", () => {
    const list = chapters(["Cold open", "Chapter 02", "Part A", "Part B"], [0, 50, 140, 800, 1400]);
    assert.equal(findChapter(list, "OP").inferred, true);
    assert.equal(findChapter(list.slice(0, 3), "OP"), undefined);
    assert.equal(findChapter(list, "ED"), undefined);
    list[1].title = "Part A";
    assert.equal(findChapter(list, "OP"), undefined);
    list[1].title = "Chapter 02";
    list[1].end = 700000;
    assert.equal(findChapter(list, "OP"), undefined);
});
