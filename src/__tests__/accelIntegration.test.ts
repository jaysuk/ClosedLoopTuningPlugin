import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseCapture } from "../model/csv";
import { buildSeries, segmentMove, type SegmentClass } from "../model/analysis";
import { evaluateTune, tuneStats } from "../model/evaluate";
import { planCorrections } from "../model/autorun";
import type { PidConfig } from "../model/m569";
import { parseAccelCapture } from "../model/accelCsv";
import { computeVibration, VIBRATION_MIN_COVERAGE, type Vibration } from "../model/vibration";

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
	// the single easiest thing in this feature to over-read. This coarseness is exactly why §7.4's original
	// frequency-matching design (comparing this bucket against the encoder's own, differently-quantised
	// frequency) was rejected in favour of the settle-vs-tail comparison — see docs/PLAN-accelerometer.md
	// §17.1.
	it("is honest about how coarse that 200 Hz really is at this sample rate", () => {
		expect(v.overall.dominantHzLow).toBeCloseTo(177.8, 1);
		expect(v.overall.dominantHzHigh).toBeCloseTo(228.6, 1);
		// The bucket is ±13% of the point value.
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
		// docs/PLAN-capture-integrity.md §3: restNoise now measures each capture's own settled TAIL
		// (161 samples here, not a too-small window) rather than the whole rest span. Two different real
		// runs of the same move naturally have somewhat different fine encoder fuzz — the old whole-window
		// figures (0.0348 vs 0.0350) matched closely mostly because both were dominated by the same
		// settling-transient shape, not because the fuzz itself was identical. Both tail-based values are
		// still small in absolute terms (and combined is the LOWER of the two), which is what "no
		// degradation from running M956 concurrently" actually means — not that two independent real
		// captures reproduce each other's noise floor to 2 decimal places.
		expect(combined.restNoise).toBeLessThan(0.05);
		expect(baseline.restNoise).toBeLessThan(0.05);
		expect(Math.abs(combined.restBias)).toBeLessThan(0.05);
		expect(Math.abs(baseline.restBias)).toBeLessThan(0.05);
	});
});

/**
 * Phase 3b, redesigned (docs/PLAN-accelerometer.md §17). §7.4's original frequency-matching design was
 * tested against real data and rejected (the encoder and accelerometer disagree by 50 Hz, and neither
 * figure is precise enough for that to mean anything — §17.1). This is what replaced it: comparing a
 * capture's post-move settle window against its OWN settled tail, which needs no universal threshold.
 *
 * Every number here is the shipped code's own output against real hardware — not estimates.
 */
describe("restSettle/restTail split (docs/PLAN-accelerometer.md §17.2)", () => {
	function vibrationFor(dir: string): Vibration {
		const base = join(__dirname, "fixtures", dir);
		const cl = parseCapture(readFileSync(join(base, "closed-loop.csv"), "utf8"));
		const accel = parseAccelCapture(readFileSync(join(base, "accelerometer.csv"), "utf8"));
		const series = buildSeries(cl, 1000)!;
		const seg = segmentMove(series.target, series.time, 1000);
		return computeVibration(accel, series.time, seg.classes);
	}

	it("measures 5.7x settle-over-tail on the genuinely vibrating capture", () => {
		const v = vibrationFor("accel-2026-09-05");
		expect(v.restSettle.rmsG).toBeCloseTo(0.2184, 3);
		expect(v.restTail.rmsG).toBeCloseTo(0.0383, 3);
		expect(v.restSettle.rmsG / v.restTail.rmsG).toBeCloseTo(5.70, 1);
	});

	it("measures only 2.0x on the deliberately quiet capture — below VIBRATION_RING_RATIO", () => {
		const v = vibrationFor("accel-2026-09-06-quiet");
		expect(v.restSettle.rmsG).toBeCloseTo(0.0729, 3);
		expect(v.restTail.rmsG).toBeCloseTo(0.0370, 3);
		expect(v.restSettle.rmsG / v.restTail.rmsG).toBeCloseTo(1.97, 1);
	});

	it("the two unrelated captures' settled tails agree to within 4% of each other", () => {
		// This is what makes settle-vs-tail self-calibrating instead of needing a universal g threshold —
		// two completely different moves on the same machine settle to nearly the same floor.
		const vibrating = vibrationFor("accel-2026-09-05").restTail.rmsG;
		const quiet = vibrationFor("accel-2026-09-06-quiet").restTail.rmsG;
		expect(Math.abs(vibrating - quiet) / quiet).toBeLessThan(0.04);
	});

	it("reports both regions empty rather than splitting a too-short rest span", () => {
		const accel = parseAccelCapture(readFileSync(join(__dirname, "fixtures", "accel-2026-09-05", "accelerometer.csv"), "utf8"));
		// A rest span of 10 samples is far below REST_SPLIT_MIN_SAMPLES (60).
		const n = accel.rowCount;
		const clTime = Array.from({ length: n }, (_, i) => i / 800);
		const clClasses: Array<SegmentClass> = clTime.map((_, i) => (i < n - 10 ? "cruise" : "rest"));
		const v = computeVibration(accel, clTime, clClasses);
		expect(v.rest.samples).toBe(10); // the plain rest region still reports it
		expect(v.restSettle.samples).toBe(0); // but the split correctly refuses to slice it further
		expect(v.restTail.samples).toBe(0);
	});
});

describe("evaluateTune with real vibration (docs/PLAN-accelerometer.md §17.4)", () => {
	function load2(dir: string, name: string) { return readFileSync(join(__dirname, "fixtures", dir, name), "utf8"); }
	function vibrationAndCapture(dir: string) {
		const cl = parseCapture(load2(dir, "closed-loop.csv"));
		const accel = parseAccelCapture(load2(dir, "accelerometer.csv"));
		const series = buildSeries(cl, 1000)!;
		const seg = segmentMove(series.target, series.time, 1000);
		return { cl, vibration: computeVibration(accel, series.time, seg.classes) };
	}

	it("calls out post-move vibration the encoder's own restRing missed entirely", () => {
		const { cl, vibration } = vibrationAndCapture("accel-2026-09-05");
		const stats = tuneStats(cl, 1000);
		expect(stats.restRing).toBe(0); // confirms the encoder really did miss it (see §17.2)

		const ev = evaluateTune(cl, 1000, vibration);
		const f = ev.findings.find((x) => x.title === "Vibration after stopping (accelerometer)");
		expect(f).toBeDefined();
		expect(f!.severity).toBe("info");
		expect(f!.detail).toContain("5.7x");
		expect(f!.detail).toContain("too coarse");
	});

	it("does not fire on the quiet capture (1.97x, below VIBRATION_RING_RATIO)", () => {
		const { cl, vibration } = vibrationAndCapture("accel-2026-09-06-quiet");
		const ev = evaluateTune(cl, 1000, vibration);
		expect(ev.findings.some((x) => x.title.includes("accelerometer"))).toBe(false);
	});

	// The safety property this whole design turns on: an encoder-derived grade must never move because of
	// a sensor outside the control loop.
	it("leaves the score and grade byte-identical whether vibration is supplied or not", () => {
		const { cl, vibration } = vibrationAndCapture("accel-2026-09-05");
		const without = evaluateTune(cl, 1000);
		const withVibration = evaluateTune(cl, 1000, vibration);
		expect(withVibration.score).toBe(without.score);
		expect(withVibration.grade).toBe(without.grade);
		expect(withVibration.findings.length).toBe(without.findings.length + 1);
	});

	it("adds nothing when vibration is omitted, undefined, or invalid — never throws", () => {
		const { cl } = vibrationAndCapture("accel-2026-09-05");
		expect(() => evaluateTune(cl, 1000, undefined)).not.toThrow();
		const invalid: Vibration = { ...vibrationAndCapture("accel-2026-09-05").vibration, valid: false };
		const ev = evaluateTune(cl, 1000, invalid);
		expect(ev.findings.some((x) => x.title.includes("accelerometer"))).toBe(false);
	});

	// A ratio is only as meaningful as its denominator: a degenerate/stuck sensor channel with a
	// near-silent tail would otherwise divide into an enormous, spurious ratio. Not reachable with real
	// hardware (quietest real tail measured: 0.0029 g, motor off) — this pins the guard anyway.
	it("refuses to compute a ratio against a pathologically quiet tail", () => {
		const { cl, vibration } = vibrationAndCapture("accel-2026-09-05");
		const degenerate: Vibration = {
			...vibration,
			restTail: { ...vibration.restTail, rmsG: 1e-9 }, // would give a ratio of ~2e8
		};
		const ev = evaluateTune(cl, 1000, degenerate);
		expect(ev.findings.some((x) => x.title.includes("accelerometer"))).toBe(false);
	});

	/**
	 * The correction pass derives real PID changes from `evaluation.findings`. The accelerometer finding
	 * must never reach it — it is a measurement from outside the control loop. It is currently excluded
	 * twice over (no `term`/`direction`, and severity is `info` not warn/bad), but nothing else locks that
	 * in: giving this finding a `term` later (e.g. "which axis is shaking") is a plausible enhancement
	 * that would silently start feeding accelerometer data into PID corrections. This test is the lock.
	 */
	it("never contributes a PID correction, however the finding is worded", () => {
		const { cl, vibration } = vibrationAndCapture("accel-2026-09-05");
		const ev = evaluateTune(cl, 1000, vibration);
		expect(ev.findings.some((x) => x.title.includes("accelerometer"))).toBe(true); // it IS present

		const pid: PidConfig = { p: 100, i: 500, d: 0.05, v: 100, a: 1000 };
		const withVibration = planCorrections(ev, pid);
		const withoutVibration = planCorrections(evaluateTune(cl, 1000), pid);
		expect(withVibration).toEqual(withoutVibration);
	});
});
