import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseCapture } from "../model/csv";
import { buildSeries, segmentMove } from "../model/analysis";
import { tuneStats } from "../model/evaluate";
import { parseAccelCapture } from "../model/accelCsv";
import { computeVibration, VIBRATION_MIN_COVERAGE } from "../model/vibration";

/**
 * Integration tests against REAL hardware captures (docs/PLAN-accelerometer.md §12), not synthetic
 * data — a real RP2350-based closed-loop board plus a real accelerometer on a separate board, captured
 * with the combined M569.5+M956 line. Every number here is a value the implemented code actually
 * produced against this data; a mismatch means the implementation drifted, not that the number was
 * wrong — do not "fix" a failure by updating the expectation.
 */
const FIXTURES = join(__dirname, "fixtures", "accel-2026-09-05");
const load = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

describe("real capture pair (docs/PLAN-accelerometer.md §12.1/§12.2)", () => {
	const cl = parseCapture(load("closed-loop.csv"));
	const accel = parseAccelCapture(load("accelerometer.csv"));
	const series = buildSeries(cl, 1000)!;
	const seg = segmentMove(series.target, series.time, 1000);
	const v = computeVibration(accel, series.time, seg.classes);

	it("parses both files cleanly — full row counts, no errors, a valid trailer", () => {
		expect(cl.rowCount).toBe(2000);
		expect(cl.notes).toEqual([]);
		expect(accel.rowCount).toBe(1000);
		expect(accel.failed).toBe(false);
		expect(accel.rateHz).toBe(800);
		expect(accel.overflows).toBe(0);
	});

	it("segments the closed-loop capture's move to end at t=0.384s, matching the raw Target Motor Steps column", () => {
		expect(seg.moved).toBe(true);
		expect(series.time[seg.lastMoving]).toBeCloseTo(0.384, 3);
	});

	it("computeVibration correlates the two captures using nothing but a shared t=0 (item D) and produces the measured region split", () => {
		expect(v.valid).toBe(true);
		expect(v.rateHz).toBe(800);
		expect(v.overflows).toBe(0);
		expect(v.overall.samples).toBe(1000);
		expect(v.cruise.samples).toBe(121);
		expect(v.rest.samples).toBe(692);
	});

	it("shows vibration dropping sharply from cruise to rest — real evidence the two captures start together (§12.2)", () => {
		expect(v.cruise.rmsG).toBeCloseTo(0.501, 2);
		expect(v.rest.rmsG).toBeCloseTo(0.125, 2);
		expect(v.rest.rmsG).toBeLessThan(v.cruise.rmsG / 2);
	});

	it("finds a consistent 200 Hz signature in both cruise and rest, well above the strength floor", () => {
		expect(v.overall.dominantHz).toBe(200);
		expect(v.cruise.dominantHz).toBe(200);
		expect(v.cruise.strength).toBeGreaterThan(0.7);
		expect(v.rest.dominantHz).toBe(200);
		expect(v.rest.strength).toBeGreaterThan(0.6);
	});

	// That clean "200" is lag 4 at 800 Hz, and the neighbouring lags are 266.7 Hz and 160 Hz — so the real
	// claim is "roughly 178-229 Hz", not "200.0 Hz". Pinned here because the exact-looking figure above is
	// the single easiest thing in this feature to over-read, and §7.4's frequency-match tolerance has to be
	// calibrated against THIS width, not against the point value (docs/PLAN-accelerometer.md §12.5).
	it("is honest about how coarse that 200 Hz really is at this sample rate", () => {
		expect(v.overall.dominantHzLow).toBeCloseTo(177.8, 1);
		expect(v.overall.dominantHzHigh).toBeCloseTo(228.6, 1);
		// The bucket is ±13% — wider than VIBRATION_FREQ_MATCH's provisional 0.15 tolerance is meant to be.
		const halfWidth = (v.overall.dominantHzHigh! - v.overall.dominantHzLow!) / 2 / v.overall.dominantHz!;
		expect(halfWidth).toBeGreaterThan(0.12);
		// Nothing above 266.7 Hz is reachable at all here, despite a 400 Hz Nyquist limit.
		expect(v.maxReportableHz).toBeCloseTo(266.7, 1);
	});

	it("records that this capture pair only partly overlaps — 1.25 s of accelerometer against a 2 s capture", () => {
		// Real measured coverage, and the reason the sample count is now sized against a high assumed rate:
		// this pair was armed by hand, and a shorter one would have emptied the rest region entirely.
		expect(v.coverage).toBeCloseTo(0.625, 2);
		expect(v.coverage).toBeLessThan(VIBRATION_MIN_COVERAGE);
		expect(v.rest.samples).toBeGreaterThan(0); // partial coverage still caught the whole settle
	});
});

describe("closed-loop-only baseline (docs/PLAN-accelerometer.md §12.4 — does concurrent capture degrade the loop?)", () => {
	const combined = tuneStats(parseCapture(load("closed-loop.csv")), 1000);
	const baseline = tuneStats(parseCapture(load("closed-loop-baseline-no-accel.csv")), 1000);

	it("shows no degradation in the metrics that matter — bias, noise floor, ringing — between the combined and accelerometer-free runs", () => {
		expect(combined.restRing).toBe(0);
		expect(baseline.restRing).toBe(0);
		expect(combined.restNoise).toBeCloseTo(baseline.restNoise, 2);
		expect(Math.abs(combined.restBias)).toBeLessThan(0.05);
		expect(Math.abs(baseline.restBias)).toBeLessThan(0.05);
	});
});
