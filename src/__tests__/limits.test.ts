import { describe, expect, it } from "vitest";

import { getAxisLimits, midpoint, planCaptureProfile, planSymmetricMove } from "../model/limits";

describe("getAxisLimits", () => {
	it("extracts min/max/position/homed from an object-model axis", () => {
		const axis = { letter: "X", min: 0, max: 300, machinePosition: 150, homed: true };
		expect(getAxisLimits(axis)).toEqual({ letter: "X", min: 0, max: 300, position: 150, homed: true });
	});
	it("returns null for an extruder (no letter)", () => {
		expect(getAxisLimits({ min: 0, max: 300, machinePosition: 0 })).toBeNull();
	});
	it("returns null when position is unknown", () => {
		expect(getAxisLimits({ letter: "X", min: 0, max: 300, machinePosition: null, homed: false })).toBeNull();
	});
	it("returns null when min/max are missing or degenerate", () => {
		expect(getAxisLimits({ letter: "X", machinePosition: 10, homed: true })).toBeNull();
		expect(getAxisLimits({ letter: "X", min: 100, max: 100, machinePosition: 10, homed: true })).toBeNull();
	});
	it("reports homed: false as-is", () => {
		const axis = { letter: "X", min: 0, max: 300, machinePosition: 150, homed: false };
		expect(getAxisLimits(axis)?.homed).toBe(false);
	});
});

describe("midpoint", () => {
	it("averages min and max", () => {
		expect(midpoint({ letter: "X", min: 0, max: 300, position: 0, homed: true })).toBe(150);
		expect(midpoint({ letter: "Z", min: -5, max: 5, position: 0, homed: true })).toBe(0);
	});
});

describe("planSymmetricMove", () => {
	const centred = { letter: "X", min: 0, max: 300, position: 150, homed: true };

	it("picks the positive direction when there's more room that way", () => {
		const near = { ...centred, position: 10 };
		const plan = planSymmetricMove(near, 50, 2, 0.1);
		expect(plan).toEqual({ distance: 50, sign: 1 });
	});
	it("picks the negative direction when there's more room that way", () => {
		const near = { ...centred, position: 290 };
		const plan = planSymmetricMove(near, 50, 2, 0.1);
		expect(plan).toEqual({ distance: 50, sign: -1 });
	});
	it("clamps distance to the available headroom minus the margin", () => {
		const near = { ...centred, position: 10 };
		const plan = planSymmetricMove(near, 50, 2, 0.1);
		// headroom positive = 300 - 2 - 10 = 288, headroom negative = 10 - (0 + 2) = 8 -> negative smaller, positive picked
		expect(plan).toEqual({ distance: 50, sign: 1 });

		const tight = { ...centred, position: 295 };
		const tightPlan = planSymmetricMove(tight, 50, 2, 0.1);
		// headroom positive = 300 - 2 - 295 = 3, headroom negative = 295 - 2 = 293 -> negative picked, clamps to 50 (< 293)
		expect(tightPlan).toEqual({ distance: 50, sign: -1 });
	});
	it("fails when neither direction has enough clear travel", () => {
		const cramped = { letter: "X", min: 0, max: 10, position: 5, homed: true };
		const plan = planSymmetricMove(cramped, 50, 2, 5); // only 3 mm clear each way, needs 5
		expect(plan).toHaveProperty("error");
		expect((plan as { error: string }).error).toContain("X:");
	});
	it("uses exactly the requested distance when it fits", () => {
		const plan = planSymmetricMove(centred, 5, 2, 0.1);
		expect(plan).toEqual({ distance: 5, sign: 1 }); // tie goes to positive (>=)
	});
});

describe("planCaptureProfile", () => {
	const centred = { letter: "X", min: 0, max: 300, position: 150, homed: true };

	it("sizes the move so the capture window still has a rest tail", () => {
		// 2000 samples @ 2000 Hz = 1 s window; default 30% rest tail → 0.7 s of move at 6000 mm/min (100 mm/s).
		const plan = planCaptureProfile(centred, 6000, 2000, 2000, 2);
		expect(plan).not.toHaveProperty("error");
		if ("error" in plan) return;
		expect(plan.distance).toBeCloseTo(70, 0);
		expect(plan.moveTimeS).toBeCloseTo(0.7, 1);
		expect(plan.restTimeS).toBeCloseTo(0.3, 1);
	});

	it("respects an explicit distance cap", () => {
		const plan = planCaptureProfile(centred, 6000, 2000, 2000, 2, { maxDistanceMm: 10 });
		expect(plan).not.toHaveProperty("error");
		if ("error" in plan) return;
		expect(plan.distance).toBeLessThanOrEqual(10);
	});

	it("clamps to available travel when the axis has less room than the desired distance", () => {
		const narrow = { letter: "X", min: 0, max: 50, position: 25, homed: true };
		const plan = planCaptureProfile(narrow, 6000, 2000, 2000, 2);
		expect(plan).not.toHaveProperty("error");
		if ("error" in plan) return;
		expect(plan.distance).toBeLessThan(70);
		expect(plan.distance).toBeCloseTo(23, 0); // 50 - 2 - 25 headroom either way
	});

	it("fails when there's not enough clear travel either way", () => {
		const cramped = { letter: "X", min: 0, max: 10, position: 5, homed: true };
		const plan = planCaptureProfile(cramped, 6000, 2000, 2000, 2);
		expect(plan).toHaveProperty("error");
	});

	it("works without axis limits (e.g. an extruder), sizing purely from feed and window", () => {
		const plan = planCaptureProfile(null, 6000, 2000, 2000, 2);
		expect(plan).not.toHaveProperty("error");
		if ("error" in plan) return;
		expect(plan.distance).toBeCloseTo(70, 0);
	});

	it("errors when the feed rate is zero", () => {
		const plan = planCaptureProfile(centred, 0, 2000, 2000, 2);
		expect(plan).toHaveProperty("error");
	});
});
