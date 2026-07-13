import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseCapture } from "../model/csv";
import {
	downsampleCapture, shapeCapturesForDownload, slimModelForReport, type ReportCapture,
} from "../model/report";

const FIXTURE_DIR = path.join(__dirname, "fixtures");
function load(name: string) {
	return parseCapture(readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

describe("downsampleCapture", () => {
	it("shrinks a long capture to at most maxPoints samples", () => {
		const capture = load("move250-stable-best.csv");
		const result = downsampleCapture(capture, 2000, 200);
		expect(result).not.toBeNull();
		expect(result!.time.length).toBeLessThanOrEqual(200);
		expect(result!.measured.length).toBe(result!.time.length);
		expect(result!.target.length).toBe(result!.time.length);
	});

	it("preserves the single largest error spike instead of averaging it away", () => {
		const capture = load("move250-runaway.csv"); // has a large, distinctive error spike
		const measured = capture.columns["Measured Motor Steps"];
		const target = capture.columns["Target Motor Steps"];
		let peakErr = -1;
		for (let i = 0; i < measured.length; i++) {
			const e = Math.abs(measured[i] - target[i]);
			if (e > peakErr) { peakErr = e; }
		}
		const result = downsampleCapture(capture, 2000, 100);
		expect(result).not.toBeNull();
		const decimatedPeak = result!.measured.reduce((mx, m, i) => Math.max(mx, Math.abs(m - result!.target[i])), 0);
		// The decimated peak should be very close to the true peak — not washed out by averaging.
		expect(decimatedPeak).toBeGreaterThan(peakErr * 0.95);
	});

	it("returns the series unchanged when it's already at or below maxPoints", () => {
		const capture = load("move250-stable-best.csv");
		const result = downsampleCapture(capture, 2000, 100000);
		expect(result!.time.length).toBe(capture.rowCount);
	});

	it("returns null when the capture has no usable measured/target columns", () => {
		const empty = parseCapture("Foo,Bar\n1,2\n3,4\n");
		expect(downsampleCapture(empty, 2000)).toBeNull();
	});
});

describe("shapeCapturesForDownload", () => {
	function cap(over: Partial<ReportCapture>): ReportCapture {
		return { seq: 0, phase: "p", csv: "raw-csv-data", ...over };
	}

	it("keeps csv only on the last capture of each phase by default", () => {
		const captures = [
			cap({ seq: 0, phase: "p", value: 30 }),
			cap({ seq: 1, phase: "p", value: 50 }),
			cap({ seq: 2, phase: "d", value: 0 }),
			cap({ seq: 3, phase: "d", value: 0.01 }),
		];
		const shaped = shapeCapturesForDownload(captures, false);
		expect(shaped[0].csv).toBeUndefined();
		expect(shaped[1].csv).toBe("raw-csv-data");
		expect(shaped[2].csv).toBeUndefined();
		expect(shaped[3].csv).toBe("raw-csv-data");
	});

	it("always keeps csv on a notable (unstable) capture, even mid-sequence", () => {
		const captures = [
			cap({ seq: 0, phase: "p", value: 30 }),
			cap({ seq: 1, phase: "p", value: 300, notable: true }),
			cap({ seq: 2, phase: "p", value: 150 }),
		];
		const shaped = shapeCapturesForDownload(captures, false);
		expect(shaped[0].csv).toBeUndefined();
		expect(shaped[1].csv).toBe("raw-csv-data"); // notable, kept even though not last
		expect(shaped[2].csv).toBe("raw-csv-data"); // last of phase "p"
	});

	it("keeps every capture's csv when includeAll is true", () => {
		const captures = [cap({ seq: 0, phase: "p" }), cap({ seq: 1, phase: "p" }), cap({ seq: 2, phase: "d" })];
		const shaped = shapeCapturesForDownload(captures, true);
		expect(shaped.every((c) => c.csv === "raw-csv-data")).toBe(true);
	});

	it("does not mutate the input array", () => {
		const captures = [cap({ seq: 0, phase: "p" }), cap({ seq: 1, phase: "p" })];
		shapeCapturesForDownload(captures, false);
		expect(captures[0].csv).toBe("raw-csv-data");
	});
});

describe("slimModelForReport", () => {
	it("embeds only the board/axis/kinematics fields a report needs", () => {
		const slim = slimModelForReport(
			{ firmwareName: "RepRapFirmware", firmwareVersion: "3.7.0", canAddress: 0, closedLoop: { runs: 3 } },
			"cartesian",
			{ letter: "X", min: 0, max: 200, stepsPerMm: 80, homed: true },
		);
		expect(slim).toEqual({
			boards: [{ firmwareName: "RepRapFirmware", firmwareVersion: "3.7.0", canAddress: 0, closedLoop: { runs: 3 } }],
			move: { kinematics: { name: "cartesian" }, axis: { letter: "X", min: 0, max: 200, stepsPerMm: 80, homed: true } },
		});
	});

	it("handles a missing board/axis gracefully (extruder, or nothing selected yet)", () => {
		const slim = slimModelForReport(null, undefined, null);
		expect(slim).toEqual({ boards: [], move: { kinematics: undefined, axis: null } });
	});
});
