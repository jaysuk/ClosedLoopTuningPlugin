import { describe, expect, it } from "vitest";

import { parseAccelCapture } from "../model/accelCsv";

describe("parseAccelCapture", () => {
	it("parses rows and the trailer's achieved rate", () => {
		const c = parseAccelCapture("Sample,X,Y,Z\n0,0.1,0.2,0.3\n1,0.1,0.2,0.3\nRate 1344, overflows 0\n");
		expect(c.rowCount).toBe(2);
		expect(c.rateHz).toBe(1344);
		expect(c.overflows).toBe(0);
		expect(c.axes.X).toHaveLength(2);
		expect(c.axes.X).toEqual([0.1, 0.1]);
		expect(c.failed).toBe(false);
		expect(c.notes.some((n) => /rate 1344/i.test(n))).toBe(true);
	});

	it("parses a non-zero overflow count from the trailer", () => {
		const c = parseAccelCapture("Sample,X,Y,Z\n0,0.1,0.2,0.3\nRate 1344, overflows 7\n");
		expect(c.overflows).toBe(7);
	});

	it("flags a failed start and yields no data", () => {
		const c = parseAccelCapture("Sample,X\nFailed to start accelerometer\n");
		expect(c.failed).toBe(true);
		expect(c.rowCount).toBe(0);
	});

	it("gives rateHz: null (never a guessed default) when the trailer is missing, but still parses the data", () => {
		const c = parseAccelCapture("Sample,X,Y,Z\n0,0.1,0.2,0.3\n1,0.15,0.25,0.35\n");
		expect(c.rateHz).toBeNull();
		expect(c.rowCount).toBe(2);
		expect(c.axes.X).toEqual([0.1, 0.15]);
	});

	it("parses an axis subset (only the recorded axes appear)", () => {
		const c = parseAccelCapture("Sample,X,Z\n0,1,2\n1,3,4\nRate 1000, overflows 0\n");
		expect(c.axes.X).toEqual([1, 3]);
		expect(c.axes.Z).toEqual([2, 4]);
		expect(c.axes.Y).toBeUndefined();
	});

	it("skips a malformed row into notes instead of poisoning a series with NaN", () => {
		const c = parseAccelCapture("Sample,X,Y,Z\n0,0.1,0.2,0.3\ngarbled\n1,0.1,0.2,0.3\nRate 1000, overflows 0\n");
		expect(c.rowCount).toBe(2);
		expect(c.axes.X!.every(Number.isFinite)).toBe(true);
		expect(c.notes.some((n) => n === "garbled")).toBe(true);
	});

	// The row that got through the width check above: right number of cells, one of them unparseable. A
	// blank field is exactly what a dropped sample looks like. Before this, the NaN reached vibration.ts,
	// made that axis's mean NaN, and silently zeroed the whole axis's RMS and peak — while the capture
	// still reported itself valid. Under-reporting vibration with no warning is the worst outcome here.
	it("rejects a right-width row with a non-numeric cell, rather than pushing NaN", () => {
		const c = parseAccelCapture("Sample,X,Y,Z\n0,1.0,0,0\n1,,0,0\n2,-1.0,0,0\nRate 800, overflows 0\n");
		expect(c.rowCount).toBe(2);
		expect(c.axes.X).toEqual([1.0, -1.0]);
		expect(c.axes.X!.every(Number.isFinite)).toBe(true);
		expect(c.notes.some((n) => n === "1,,0,0")).toBe(true);
	});

	it("keeps every axis the same length when a row is rejected", () => {
		const c = parseAccelCapture("Sample,X,Y,Z\n0,1,2,3\n1,4,nonsense,6\n2,7,8,9\nRate 800, overflows 0\n");
		expect(c.rowCount).toBe(2);
		expect(c.axes.X).toEqual([1, 7]);
		expect(c.axes.Y).toEqual([2, 8]);
		expect(c.axes.Z).toEqual([3, 9]);
	});

	it("is empty for blank input", () => {
		const c = parseAccelCapture("");
		expect(c.rowCount).toBe(0);
		expect(c.rateHz).toBeNull();
		expect(c.failed).toBe(false);
	});
});
