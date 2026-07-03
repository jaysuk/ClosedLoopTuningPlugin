import { describe, expect, it } from "vitest";

import { mmPerFullStep, stepJumpDistanceMm, stepJumpFeedMmPerMin } from "../model/scale";

describe("mmPerFullStep", () => {
	it("computes mm-per-full-step from steps-per-mm (incl. microstepping) and the microstepping factor", () => {
		// 1280 steps/mm at 16x microstepping = 80 full steps/mm = 0.0125 mm per full step.
		expect(mmPerFullStep({ stepsPerMm: 1280, microstepping: 16 })).toBeCloseTo(0.0125, 6);
	});
	it("falls back to a sane default when the object model hasn't reported values yet", () => {
		expect(mmPerFullStep({})).toBeCloseTo(16 / 80, 6);
		expect(mmPerFullStep({ stepsPerMm: 0, microstepping: undefined })).toBeCloseTo(16 / 80, 6);
	});
	it("ignores non-finite or non-positive readings and falls back", () => {
		expect(mmPerFullStep({ stepsPerMm: Number.NaN, microstepping: -5 })).toBeCloseTo(16 / 80, 6);
	});
});

describe("stepJumpDistanceMm", () => {
	it("scales with the axis resolution — a coarser axis needs a bigger jump for the same step count", () => {
		const fine = stepJumpDistanceMm({ stepsPerMm: 1280, microstepping: 16 });   // 80 full steps/mm
		const coarse = stepJumpDistanceMm({ stepsPerMm: 160, microstepping: 16 });  // 10 full steps/mm
		expect(coarse).toBeGreaterThan(fine);
		expect(coarse).toBeCloseTo(fine * 8, 6); // 8x coarser pitch → 8x the distance for the same step count
	});
	it("never returns a distance below the floor, even at extreme resolution", () => {
		expect(stepJumpDistanceMm({ stepsPerMm: 100000, microstepping: 1 })).toBeGreaterThanOrEqual(0.1);
	});
	it("defaults to 16 full steps, but honours an explicit step count", () => {
		const scale = { stepsPerMm: 1280, microstepping: 16 };
		expect(stepJumpDistanceMm(scale, 32)).toBeCloseTo(stepJumpDistanceMm(scale, 16) * 2, 6);
	});
});

describe("stepJumpFeedMmPerMin", () => {
	it("scales feed with distance so the move takes roughly the same time regardless of scale", () => {
		const small = stepJumpFeedMmPerMin(0.2);
		const large = stepJumpFeedMmPerMin(2.0);
		expect(large).toBeGreaterThan(small);
	});
	it("clamps to a sane floor for a tiny distance", () => {
		expect(stepJumpFeedMmPerMin(0.001)).toBeGreaterThanOrEqual(600);
	});
	it("clamps to a sane ceiling for a large distance", () => {
		expect(stepJumpFeedMmPerMin(1000)).toBeLessThanOrEqual(30000);
	});
});
