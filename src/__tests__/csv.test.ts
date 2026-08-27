import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { column, parseCapture, timeAxisSeconds } from "../model/csv";

const CSV = "Sample,Timestamp,Measured Motor Steps,Target Motor Steps\n0,1000,0,0\n1,1001,0.5,1\n2,1002,1,1\n";
const FIXTURES = join(__dirname, "fixtures");
const load = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

describe("parseCapture", () => {
	it("splits headers and numeric columns", () => {
		const c = parseCapture(CSV);
		expect(c.headers).toContain("Measured Motor Steps");
		expect(c.rowCount).toBe(3);
		expect(c.columns["Target Motor Steps"]).toEqual([0, 1, 1]);
	});
	it("is empty for blank input", () => {
		expect(parseCapture("").rowCount).toBe(0);
	});
	it("reports no notes/truncation for a normal capture", () => {
		const c = parseCapture(CSV);
		expect(c.notes).toEqual([]);
		expect(c.truncated).toBe(false);
	});
});

describe("parseCapture — RRF's 'Data lost' buffer-overrun marker", () => {
	const c = parseCapture(load("hold-truncated-datalost.csv"));

	it("skips the marker line rather than parsing it as a data row", () => {
		expect(c.rowCount).toBe(100);
	});
	it("flags the capture as truncated and records the raw marker line", () => {
		expect(c.truncated).toBe(true);
		expect(c.notes.some((n) => /data lost/i.test(n))).toBe(true);
	});
	it("never lets the marker line poison a column with NaN", () => {
		for (const values of Object.values(c.columns)) {
			expect(values.every(Number.isFinite)).toBe(true);
		}
	});
});

describe("column lookup", () => {
	it("finds columns case-insensitively", () => {
		const c = parseCapture(CSV);
		expect(column(c, "measured motor steps")).toEqual([0, 0.5, 1]);
		expect(column(c, "Nonexistent")).toBeNull();
	});
});

describe("timeAxisSeconds", () => {
	it("uses the Timestamp column (ms→s, zeroed)", () => {
		expect(timeAxisSeconds(parseCapture(CSV), 0)).toEqual([0, 0.001, 0.002]);
	});
	it("derives time from the sample rate when there is no timestamp", () => {
		const c = parseCapture("Sample,Measured Motor Steps,Target Motor Steps\n0,0,0\n1,1,1\n");
		expect(timeAxisSeconds(c, 1000)).toEqual([0, 0.001]);
	});
});
