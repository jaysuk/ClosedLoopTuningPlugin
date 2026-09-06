import { describe, expect, it } from "vitest";

import type { SegmentClass } from "../model/analysis";
import type { AccelCapture } from "../model/accelCsv";
import { computeVibration, VIBRATION_MIN_COVERAGE } from "../model/vibration";

const RATE = 1000;
const N = 300;

/** A 50 Hz tone on a 1 g gravity offset — the plan's base fixture (docs/PLAN-accelerometer.md §9). */
function toneCapture(freqHz: number, over: Partial<AccelCapture> = {}): AccelCapture {
	const x: Array<number> = [];
	for (let i = 0; i < N; i++) { x.push(Math.sin((2 * Math.PI * freqHz * i) / RATE) + 1.0); }
	return { axes: { X: x }, rowCount: N, rateHz: RATE, overflows: 0, failed: false, notes: [], ...over };
}

/** 100 accel / 100 cruise / 100 rest, aligned 1:1 with the tone's own sample index (clTime[i] = i/RATE). */
function segmentation(): { clTime: Array<number>; clClasses: Array<SegmentClass> } {
	const clTime: Array<number> = [], clClasses: Array<SegmentClass> = [];
	for (let i = 0; i < N; i++) {
		clTime.push(i / RATE);
		clClasses.push(i < 100 ? "accel" : i < 200 ? "cruise" : "rest");
	}
	return { clTime, clClasses };
}

describe("computeVibration", () => {
	it("removes the gravity/DC offset from RMS and finds the fundamental, not a harmonic", () => {
		const { clTime, clClasses } = segmentation();
		const v = computeVibration(toneCapture(50), clTime, clClasses);
		expect(v.valid).toBe(true);
		expect(v.overall.rmsG).toBeCloseTo(0.7071, 3);
		expect(v.overall.dominantHz).not.toBeNull();
		expect(v.overall.dominantHz!).toBeCloseTo(50, 0);
	});

	it("splits region sample counts to match the closed-loop segmentation exactly", () => {
		const { clTime, clClasses } = segmentation();
		const v = computeVibration(toneCapture(50), clTime, clClasses);
		expect(v.overall.samples).toBe(300);
		expect(v.cruise.samples).toBe(100);
		expect(v.rest.samples).toBe(100);
	});

	it("is invalid (never guesses) when the trailer rate is missing", () => {
		const { clTime, clClasses } = segmentation();
		const v = computeVibration(toneCapture(50, { rateHz: null }), clTime, clClasses);
		expect(v.valid).toBe(false);
		expect(v.overall.samples).toBe(0);
		expect(v.cruise.samples).toBe(0);
		expect(v.rest.samples).toBe(0);
	});

	it("is invalid when the accelerometer failed to start", () => {
		const { clTime, clClasses } = segmentation();
		const v = computeVibration(toneCapture(50, { failed: true }), clTime, clClasses);
		expect(v.valid).toBe(false);
	});

	it("finds no dominant frequency in white noise", () => {
		const { clTime, clClasses } = segmentation();
		const x: Array<number> = [];
		for (let i = 0; i < N; i++) { x.push(Math.random() * 2 - 1); }
		const v = computeVibration({ axes: { X: x }, rowCount: N, rateHz: RATE, overflows: 0, failed: false, notes: [] }, clTime, clClasses);
		expect(v.overall.dominantHz).toBeNull();
		expect(v.cruise.dominantHz).toBeNull();
		expect(v.rest.dominantHz).toBeNull();
	});

	it("quantises to an integer sample lag — a 120 Hz tone at 1 kHz reads as 125 Hz, not 120", () => {
		// Documents the accuracy limit rather than hiding it: dominantHz is indicative, not exact, and
		// this pins the exact rounding rather than letting it silently drift.
		const { clTime, clClasses } = segmentation();
		const v = computeVibration(toneCapture(120), clTime, clClasses);
		expect(v.overall.dominantHz).toBeCloseTo(125, 0);
	});

	it("regression guard: rectifying the signal (sqrt(x^2)) must NOT reproduce the true frequency", () => {
		// Pins the trap documented in vibration.ts's module doc — if this ever starts passing with the
		// rectified value equal to the true frequency, computeVibration has regressed to using magnitude.
		const rectified: Array<number> = [];
		for (let i = 0; i < N; i++) { rectified.push(Math.abs(Math.sin((2 * Math.PI * 50 * i) / RATE))); }
		const { clTime, clClasses } = segmentation();
		const v = computeVibration({ axes: { X: rectified }, rowCount: N, rateHz: RATE, overflows: 0, failed: false, notes: [] }, clTime, clClasses);
		expect(v.overall.dominantHz).not.toBeNull();
		expect(Math.abs(v.overall.dominantHz! - 50)).toBeGreaterThan(5);
	});

	it("carries overflows through from the capture", () => {
		const { clTime, clClasses } = segmentation();
		const v = computeVibration(toneCapture(50, { overflows: 3 }), clTime, clClasses);
		expect(v.overflows).toBe(3);
	});

	it("reports the frequency bucket around dominantHz, not just the point value", () => {
		// 120 Hz reads as 125 Hz (lag 8) above. The honest answer is the whole bucket the lag stands for:
		// 1000/8.5 = 117.6 Hz to 1000/7.5 = 133.3 Hz — which does contain the true 120 Hz.
		const { clTime, clClasses } = segmentation();
		const v = computeVibration(toneCapture(120), clTime, clClasses);
		expect(v.overall.dominantHzLow).toBeCloseTo(117.6, 1);
		expect(v.overall.dominantHzHigh).toBeCloseTo(133.3, 1);
		expect(v.overall.dominantHzLow!).toBeLessThan(120);
		expect(v.overall.dominantHzHigh!).toBeGreaterThan(120);
	});

	it("states the highest frequency it could report at all", () => {
		const { clTime, clClasses } = segmentation();
		expect(computeVibration(toneCapture(50), clTime, clClasses).maxReportableHz).toBeCloseTo(1000 / 3, 3);
		expect(computeVibration(toneCapture(50, { rateHz: null }), clTime, clClasses).maxReportableHz).toBeNull();
	});

	// The silent-wrong-answer case: M956 takes a sample COUNT, so an accelerometer faster than the count
	// was sized for stops before the move does. The rest region then comes back EMPTY, and 0 g reads as a
	// perfectly still machine — the best possible result — rather than as missing data.
	it("reports partial coverage when the accelerometer capture ends before the closed-loop one", () => {
		const { clTime, clClasses } = segmentation();
		const short = toneCapture(50);
		short.axes.X = short.axes.X!.slice(0, 150);
		short.rowCount = 150; // 0.15 s of a 0.3 s closed-loop capture

		const v = computeVibration(short, clTime, clClasses);
		expect(v.valid).toBe(true); // what it did capture is still real
		expect(v.coverage).toBeCloseTo(0.5, 2);
		expect(v.coverage).toBeLessThan(VIBRATION_MIN_COVERAGE);
		// The rest region is not "0 g of vibration" — it is no data at all, and samples is how you tell.
		expect(v.rest.samples).toBe(0);
		expect(v.rest.rmsG).toBe(0);
		expect(v.cruise.samples).toBeGreaterThan(0);
	});

	it("reports full coverage for a capture that spans the whole closed-loop window", () => {
		const { clTime, clClasses } = segmentation();
		expect(computeVibration(toneCapture(50), clTime, clClasses).coverage).toBeCloseTo(1, 3);
	});

	it("never reports coverage above 1, however long the accelerometer ran", () => {
		const { clTime, clClasses } = segmentation();
		const long = toneCapture(50);
		long.axes.X = [...long.axes.X!, ...long.axes.X!];
		long.rowCount = 600;
		expect(computeVibration(long, clTime, clClasses).coverage).toBe(1);
	});

	it("has zero coverage, not full coverage, when the capture is unusable", () => {
		const { clTime, clClasses } = segmentation();
		expect(computeVibration(toneCapture(50, { failed: true }), clTime, clClasses).coverage).toBe(0);
	});
});
