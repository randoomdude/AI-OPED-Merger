import assert from "node:assert/strict";
import test from "node:test";
import { alignDraftStart } from "../docs/reuse.js";

test("playhead shift moves both endpoints and preserves the draft’s contents and selection", () => {
    const events = [{ content: "A", style: "OP" }];
    const rows = [
        { start: "0:01:10.00", end: "0:01:13.00", text: "A", include: true, events },
        { start: "0:01:14.00", end: "0:01:15.15", text: "B", include: false },
        { start: "", end: "", text: "C", include: true },
    ];
    const shifted = alignDraftStart(rows, 65020, 180000, true);
    assert.deepEqual(shifted, [
        { ...rows[0], start: "0:01:05.02", end: "0:01:08.02" },
        { ...rows[1], start: "0:01:09.02", end: "0:01:10.17" },
        rows[2],
    ]);
    assert.equal(rows[0].start, "0:01:10.00");
    assert.equal(rows[0].end, "0:01:13.00");
    assert.throws(() => alignDraftStart(rows, 177000, 180000, true), /outside this episode/);
});

test("moving the start repairs an invalid end and keeps an already marked end for a blank start", () => {
    const anchor = { start: "0:01:15.00", end: "0:01:10.00", text: "Line 5", include: true };
    const rest = [{ start: "0:01:16.00", end: "0:01:19.00", text: "Line 6", include: true }];
    const single = alignDraftStart([anchor, ...rest], 75000, 180000, false);
    assert.deepEqual(single, [{ ...anchor, end: "0:01:16.00" }]);
    const shifted = alignDraftStart([{ ...anchor, end: "" }, ...rest], 80000, 180000, true);
    assert.deepEqual(shifted.map(({ start, end }) => [start, end]), [
        ["0:01:20.00", "0:01:21.00"], ["0:01:21.00", "0:01:24.00"],
    ]);
    const fromBlank = alignDraftStart([{ ...anchor, start: "", end: "0:01:17.40" }], 75000, 180000, false);
    assert.equal(fromBlank[0].end, "0:01:17.40");
});
