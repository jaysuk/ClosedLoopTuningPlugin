import { describe, expect, it } from "vitest";

import { getAxisLimits, midpoint, planSymmetricMove } from "../model/limits";

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
