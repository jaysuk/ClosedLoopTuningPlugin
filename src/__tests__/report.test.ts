import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildSeries, computeRestEffort, segmentMove } from "../model/analysis";
import { parseCapture } from "../model/csv";
import { computeTuneSignal } from "../model/signal";
import { evaluateTune } from "../model/evaluate";
import { parseAccelCapture } from "../model/accelCsv";
import { computeVibration } from "../model/vibration";
import {
	downsampleCapture, isNotableCapture, shapeCapturesForDownload, slimModelForReport, type ReportCapture,
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

	// docs/PLAN-standstill-effort.md §5.1: ReportCapture.metrics is typed `unknown` and holds the
	// whole TuneSignal/StepMetrics object verbatim — confirms restEffort (added to both in an earlier
	// phase) survives untouched, since report.ts never reads or reshapes .metrics, only .csv.
	it("carries a capture's restEffort metrics through the shaping step untouched", () => {
		const dither = computeTuneSignal(load("hold-dither-i0.csv"), 2000);
		expect(dither).not.toBeNull();
		const captures: Array<ReportCapture> = [cap({ seq: 0, phase: "i", metrics: dither })];
		const [shaped] = shapeCapturesForDownload(captures, false);
		const metrics = shaped.metrics as typeof dither;
		expect(metrics!.restEffort).toEqual(dither!.restEffort);
		expect(metrics!.restEffort.pTermRestRipple).toBeCloseTo(33.6, 5);
	});

	it("also carries restEffort computed directly (the extruder/StepMetrics path)", () => {
		const re = computeRestEffort(load("hold-settled-i23.csv"), 2000);
		const captures: Array<ReportCapture> = [cap({ seq: 0, phase: "i", metrics: { restEffort: re } })];
		const [shaped] = shapeCapturesForDownload(captures, false);
		expect((shaped.metrics as { restEffort: typeof re }).restEffort).toEqual(re);
	});

	// docs/PLAN-accelerometer.md §8: vibration is attached to TuneSignal post-hoc (captureSignal(), not
	// computeTuneSignal itself — see useClosedLoopTuning.ts), so this builds that same shape by hand
	// using the real hardware fixture, same pattern as the restEffort round-trip above.
	it("carries a capture's vibration metrics through the shaping step untouched", () => {
		const cl = load("accel-2026-09-05/closed-loop.csv");
		const accel = parseAccelCapture(readFileSync(path.join(FIXTURE_DIR, "accel-2026-09-05", "accelerometer.csv"), "utf8"));
		const series = buildSeries(cl, 1000)!;
		const seg = segmentMove(series.target, series.time, 1000);
		const vibration = computeVibration(accel, series.time, seg.classes);
		const signal = computeTuneSignal(cl, 1000)!;
		signal.vibration = vibration;

		const captures: Array<ReportCapture> = [cap({ seq: 0, phase: "p", metrics: signal })];
		const [shaped] = shapeCapturesForDownload(captures, false);
		const metrics = shaped.metrics as typeof signal;
		expect(metrics.vibration).toEqual(vibration);
		expect(metrics.vibration!.overall.dominantHz).toBe(200);
	});
});

// docs/PLAN-accelerometer.md §17: the accelerometer's finding reaches the user through the downloaded
// report's `state.evaluation`, which `downloadTuningReport` passes through by spreading `tuneSession`
// (only `captures` is reshaped). This pins that the finding — and critically the UNCHANGED score/grade
// alongside it — survives that path intact and is plain JSON-serialisable data.
describe("evaluation in the downloaded report", () => {
	it("carries the accelerometer finding through report shaping without altering score or grade", () => {
		const cl = load("accel-2026-09-05/closed-loop.csv");
		const accel = parseAccelCapture(readFileSync(path.join(FIXTURE_DIR, "accel-2026-09-05", "accelerometer.csv"), "utf8"));
		const series = buildSeries(cl, 1000)!;
		const seg = segmentMove(series.target, series.time, 1000);
		const vibration = computeVibration(accel, series.time, seg.classes);

		const withVibration = evaluateTune(cl, 1000, vibration);
		const without = evaluateTune(cl, 1000);
		expect(withVibration.findings.some((f) => f.title.includes("accelerometer"))).toBe(true);

		// The report spreads the session wholesale; a JSON round-trip is what actually reaches the file.
		const roundTripped = JSON.parse(JSON.stringify(withVibration)) as typeof withVibration;
		expect(roundTripped.findings.some((f) => f.title.includes("accelerometer"))).toBe(true);
		expect(roundTripped.score).toBe(without.score);
		expect(roundTripped.grade).toBe(without.grade);
	});
});

describe("isNotableCapture", () => {
	it("a real sub-rail limit-cycle capture is notable — kept in full even mid-sequence", () => {
		const dither = computeTuneSignal(load("hold-limit-cycle-soft.csv"), 2000);
		expect(isNotableCapture(dither)).toBe(true);
	});

	it("a 2-count quantisation flutter is NOT notable (PLAN-v2.7 §2)", () => {
		const flutter = computeTuneSignal(load("hold-dither-i0.csv"), 2000);
		expect(isNotableCapture(flutter)).toBe(false);
	});

	it("a real settled capture is NOT notable", () => {
		const settled = computeTuneSignal(load("hold-settled-i23.csv"), 2000);
		expect(isNotableCapture(settled)).toBe(false);
	});

	it("an invalid rest-effort tail never makes a capture notable, however large the raw ripple number", () => {
		const settled = computeTuneSignal(load("hold-settled-i23.csv"), 2000)!;
		const invalid = { ...settled, restEffort: { ...settled.restEffort, restTailValid: false, errorRestRipple: 999 } };
		expect(isNotableCapture(invalid)).toBe(false);
	});

	it("still catches a saturating/unstable capture via pTermSatDuty, independent of restEffort", () => {
		expect(isNotableCapture({ pTermSatDuty: 0.5 })).toBe(true);
	});

	it("handles null/undefined/shapeless metrics without throwing", () => {
		expect(isNotableCapture(null)).toBe(false);
		expect(isNotableCapture(undefined)).toBe(false);
		expect(isNotableCapture({})).toBe(false);
	});

	it("end to end: a notable dithering capture keeps its raw CSV even mid-sequence, via the real composable wiring", () => {
		const dither = computeTuneSignal(load("hold-limit-cycle-soft.csv"), 2000);
		const captures: Array<ReportCapture> = [
			{ seq: 0, phase: "i", value: 0, metrics: dither, csv: "raw-csv-data", notable: isNotableCapture(dither) },
			{ seq: 1, phase: "i", value: 1000, csv: "raw-csv-data", notable: false },
			{ seq: 2, phase: "i", value: 1500, csv: "raw-csv-data", notable: false }, // now the true last-of-phase
		];
		const shaped = shapeCapturesForDownload(captures, false);
		expect(shaped[0].csv).toBe("raw-csv-data"); // notable, kept even though not last of its phase
		expect(shaped[1].csv).toBeUndefined(); // neither notable nor last — dropped
		expect(shaped[2].csv).toBe("raw-csv-data"); // last of the phase
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
