import { describe, expect, it } from "vitest";

import {
	AUTO_MOVE_CAP_MM, AUTO_RATE_FLOOR_HZ, getAxisLimits, midpoint, planCaptureProfile, planCenteredMove,
	planSymmetricMove,
} from "../model/limits";

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

describe("planCenteredMove", () => {
	// Jay's field report: a 350 mm axis, homed and sitting at its 175 mm midpoint. The OLD
	// planSymmetricMove-based approach centred the AXIS then moved one-way FROM there, capping the move
	// at ~half the travel (~175 mm) even though ~346 mm was actually clear on both sides.
	const field = { letter: "X", min: 0, max: 350, position: 175, homed: true };

	it("doubles the usable distance vs. moving one-way from the (already-centred) current position", () => {
		const plan = planCenteredMove(field, 300, 2, 1);
		expect(plan).not.toHaveProperty("error");
		if ("error" in plan) return;
		// Full clear travel: 350 - 2*2 = 346 mm, vs. planSymmetricMove's ~173 mm one-way from the middle.
		expect(plan.distance).toBeCloseTo(300, 5); // requested distance fits well within the full range
		expect(plan.sign).toBe(1);
	});

	it("is always symmetric about the midpoint regardless of the axis's current position", () => {
		// planCenteredMove doesn't even look at `position` — every centred plan pre-positions first.
		const elsewhere = { ...field, position: 10 };
		const plan = planCenteredMove(elsewhere, 100, 2, 1);
		expect(plan).not.toHaveProperty("error");
		if ("error" in plan) return;
		expect(plan.startPosition).toBeCloseTo(midpoint(field) - 50, 5);
	});

	it("clamps distance to the full clear span when the request exceeds it", () => {
		const plan = planCenteredMove(field, 1000, 2, 1);
		expect(plan).not.toHaveProperty("error");
		if ("error" in plan) return;
		expect(plan.distance).toBeCloseTo(346, 5); // 350 - 2*2
	});

	it("start + distance stays within the margin on both ends", () => {
		const plan = planCenteredMove(field, 300, 2, 1);
		if ("error" in plan) throw new Error("expected a plan");
		expect(plan.startPosition).toBeGreaterThanOrEqual(field.min + 2 - 1e-9);
		expect(plan.startPosition + plan.distance).toBeLessThanOrEqual(field.max - 2 + 1e-9);
	});

	it("fails when the total clear span is below the minimum", () => {
		const cramped = { letter: "X", min: 0, max: 10, position: 5, homed: true };
		const plan = planCenteredMove(cramped, 50, 2, 8); // 6 mm clear total, needs 8
		expect(plan).toHaveProperty("error");
		expect((plan as { error: string }).error).toContain("X:");
	});
});

describe("planCaptureProfile", () => {
	const centred = { letter: "X", min: 0, max: 300, position: 150, homed: true };

	it("auto mode (no maxDistanceMm) uses the longest reasonable move and derives the sample rate from it", () => {
		const plan = planCaptureProfile(centred, 6000, 2000, 2000, 2);
		expect(plan).not.toHaveProperty("error");
		if ("error" in plan) return;
		// 300 mm axis, 2 mm margin each side -> 296 mm clear, capped at AUTO_MOVE_CAP_MM (200).
		expect(plan.distance).toBeCloseTo(AUTO_MOVE_CAP_MM, 0);
		expect(plan.moveTimeS).toBeCloseTo(AUTO_MOVE_CAP_MM / 100, 2); // feed 6000 mm/min = 100 mm/s
		expect(plan.sampleRateHz).toBeGreaterThan(AUTO_RATE_FLOOR_HZ);
		expect(plan.restTimeS).toBeGreaterThan(0);
	});

	it("auto mode doubles the usable distance vs. the old one-way-from-centre planning on a wide axis", () => {
		// A 350 mm axis, position already at its midpoint — this is Jay's exact field report. The old
		// planSymmetricMove-based plan would cap around ~173 mm (half the travel); centred planning
		// allows up to AUTO_MOVE_CAP_MM (200) since the full ~346 mm is clear.
		const field = { letter: "X", min: 0, max: 350, position: 175, homed: true };
		const plan = planCaptureProfile(field, 6000, 2000, 2000, 2);
		expect(plan).not.toHaveProperty("error");
		if ("error" in plan) return;
		expect(plan.distance).toBeCloseTo(AUTO_MOVE_CAP_MM, 0);
		expect(plan.distance).toBeGreaterThan(190); // definitively more than the old ~173 mm ceiling
	});

	it("auto mode shrinks the move (never the rate) when even the floor rate can't cover the window", () => {
		// A very long clear span with a slow feed makes the derived window huge; the rate would want to
		// drop well below the floor, so the move shrinks to keep the floor's resolution instead.
		const long = { letter: "X", min: 0, max: 5000, position: 2500, homed: true };
		const plan = planCaptureProfile(long, 60, 500, 2000, 2); // 60 mm/min = 1 mm/s, only 500 samples
		expect(plan).not.toHaveProperty("error");
		if ("error" in plan) return;
		expect(plan.sampleRateHz).toBeCloseTo(AUTO_RATE_FLOOR_HZ, 5);
		expect(plan.distance).toBeLessThan(AUTO_MOVE_CAP_MM); // shrunk below the normal auto cap
	});

	it("respects an explicit distance cap and keeps the requested sample rate", () => {
		const plan = planCaptureProfile(centred, 6000, 2000, 2000, 2, { maxDistanceMm: 10 });
		expect(plan).not.toHaveProperty("error");
		if ("error" in plan) return;
		expect(plan.distance).toBeCloseTo(10, 5);
		expect(plan.sampleRateHz).toBe(2000);
	});

	it("an explicit distance also benefits from centred (full-range) planning", () => {
		const field = { letter: "X", min: 0, max: 350, position: 175, homed: true };
		const plan = planCaptureProfile(field, 6000, 2000, 2000, 2, { maxDistanceMm: 300 });
		expect(plan).not.toHaveProperty("error");
		if ("error" in plan) return;
		expect(plan.distance).toBeCloseTo(300, 0); // would have been capped ~173 mm by the old planner
	});

	it("clamps to available travel when the axis has less room than the requested distance", () => {
		const narrow = { letter: "X", min: 0, max: 50, position: 25, homed: true };
		const plan = planCaptureProfile(narrow, 6000, 2000, 2000, 2);
		expect(plan).not.toHaveProperty("error");
		if ("error" in plan) return;
		expect(plan.distance).toBeCloseTo(46, 0); // 50 - 2*2 full clear span (double the old ~23 mm one-way)
	});

	it("fails when there's not enough clear travel for even the auto-mode floor", () => {
		const cramped = { letter: "X", min: 0, max: 8, position: 4, homed: true }; // 8 - 2*2 = 4 mm clear, floor is 5
		const plan = planCaptureProfile(cramped, 6000, 2000, 2000, 2);
		expect(plan).toHaveProperty("error");
	});

	it("works without axis limits (e.g. an extruder), using the auto cap directly", () => {
		const plan = planCaptureProfile(null, 6000, 2000, 2000, 2);
		expect(plan).not.toHaveProperty("error");
		if ("error" in plan) return;
		expect(plan.distance).toBeCloseTo(AUTO_MOVE_CAP_MM, 0);
	});

	it("errors when the feed rate is zero", () => {
		const plan = planCaptureProfile(centred, 0, 2000, 2000, 2);
		expect(plan).toHaveProperty("error");
	});
});
