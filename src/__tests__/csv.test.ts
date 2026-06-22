import { describe, expect, it } from "vitest";

import { column, parseCapture, timeAxisSeconds } from "../model/csv";

const CSV = "Sample,Timestamp,Measured Motor Steps,Target Motor Steps\n0,1000,0,0\n1,1001,0.5,1\n2,1002,1,1\n";

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
