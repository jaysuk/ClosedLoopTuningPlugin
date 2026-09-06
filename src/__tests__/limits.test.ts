import { describe, expect, it } from "vitest";

import {
	AUTO_MOVE_CAP_MM, AUTO_REST_MIN_S, AUTO_RATE_CEILING_HZ, AUTO_RATE_FLOOR_HZ, AUTO_VALUE_RATE_CEILING,
	getAxisLimits, midpoint, planCaptureProfile, planCenteredMove, rateCeilingForBoard, rateCeilingForCapture,
	planCoupledCenteredMove, planCoupledSymmetricMove, planSymmetricMove, type CoupledAxisLimits,
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
	// planCaptureProfile takes the coupled-axes array shape (see kinematics.ts); perUnit: 1 is the
	// independent-axis case every test here exercises, matching planCaptureProfile's old single-axis
	// contract exactly (see the "coupled kinematics" describe block below for perUnit !== 1 coverage).
	const coupled = (axis: { letter: string; min: number; max: number; position: number; homed: boolean }) => [{ ...axis, perUnit: 1 }];
	const centred = { letter: "X", min: 0, max: 300, position: 150, homed: true };

	it("auto mode (no maxDistanceMm) uses the longest reasonable move and derives the sample rate from it", () => {
		const plan = planCaptureProfile(coupled(centred), 6000, 2000, 2000, 2);
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
		const plan = planCaptureProfile(coupled(field), 6000, 2000, 2000, 2);
		expect(plan).not.toHaveProperty("error");
		if ("error" in plan) return;
		expect(plan.distance).toBeCloseTo(AUTO_MOVE_CAP_MM, 0);
		expect(plan.distance).toBeGreaterThan(190); // definitively more than the old ~173 mm ceiling
	});

	it("auto mode shrinks the move (never the rate) when even the floor rate can't cover the window", () => {
		// A very long clear span with a slow feed makes the derived window huge; the rate would want to
		// drop well below the floor, so the move shrinks to keep the floor's resolution instead.
		const long = { letter: "X", min: 0, max: 5000, position: 2500, homed: true };
		const plan = planCaptureProfile(coupled(long), 60, 500, 2000, 2); // 60 mm/min = 1 mm/s, only 500 samples
		expect(plan).not.toHaveProperty("error");
		if ("error" in plan) return;
		expect(plan.sampleRateHz).toBeCloseTo(AUTO_RATE_FLOOR_HZ, 5);
		expect(plan.distance).toBeLessThan(AUTO_MOVE_CAP_MM); // shrunk below the normal auto cap
	});

	it("respects an explicit distance cap and keeps the requested sample rate", () => {
		const plan = planCaptureProfile(coupled(centred), 6000, 2000, 2000, 2, { maxDistanceMm: 10 });
		expect(plan).not.toHaveProperty("error");
		if ("error" in plan) return;
		expect(plan.distance).toBeCloseTo(10, 5);
		expect(plan.sampleRateHz).toBe(2000);
	});

	it("an explicit distance also benefits from centred (full-range) planning", () => {
		const field = { letter: "X", min: 0, max: 350, position: 175, homed: true };
		const plan = planCaptureProfile(coupled(field), 6000, 2000, 2000, 2, { maxDistanceMm: 300 });
		expect(plan).not.toHaveProperty("error");
		if ("error" in plan) return;
		expect(plan.distance).toBeCloseTo(300, 0); // would have been capped ~173 mm by the old planner
	});

	it("clamps to available travel when the axis has less room than the requested distance", () => {
		const narrow = { letter: "X", min: 0, max: 50, position: 25, homed: true };
		const plan = planCaptureProfile(coupled(narrow), 6000, 2000, 2000, 2);
		expect(plan).not.toHaveProperty("error");
		if ("error" in plan) return;
		expect(plan.distance).toBeCloseTo(46, 0); // 50 - 2*2 full clear span (double the old ~23 mm one-way)
	});

	it("fails when there's not enough clear travel for even the auto-mode floor", () => {
		const cramped = { letter: "X", min: 0, max: 8, position: 4, homed: true }; // 8 - 2*2 = 4 mm clear, floor is 5
		const plan = planCaptureProfile(coupled(cramped), 6000, 2000, 2000, 2);
		expect(plan).toHaveProperty("error");
	});

	it("works without axis limits (e.g. an extruder), using the auto cap directly", () => {
		const plan = planCaptureProfile([], 6000, 2000, 2000, 2);
		expect(plan).not.toHaveProperty("error");
		if ("error" in plan) return;
		expect(plan.distance).toBeCloseTo(AUTO_MOVE_CAP_MM, 0);
	});

	it("errors when the feed rate is zero", () => {
		const plan = planCaptureProfile(coupled(centred), 0, 2000, 2000, 2);
		expect(plan).toHaveProperty("error");
	});

	describe("rate ceiling (docs/PLAN-v2.4-feedback.md follow-up: board-aware sample rate)", () => {
		// A short-travel axis: 10 mm max, 2 mm margin each side -> 6 mm clear, well under AUTO_MOVE_CAP_MM.
		// A short auto move is exactly the "5 mm move at 100 mm/s" pathological case from the field report —
		// even the general default ceiling (not a board-specific one) catches it.
		const short = { letter: "X", min: 0, max: 10, position: 5, homed: true };

		// AUTO_REST_MIN_S (docs/PLAN-capture-window.md §4) floors this move's window at moveTimeS + 0.5s
		// rather than the fractional 0.06/0.7 ≈ 0.086s it would otherwise get, which caps the derivable
		// rate at samples/0.5 — so it now takes MORE requested samples than before to reach the default
		// ceiling from this short a move (2000 no longer does; 3000 does). The point of this test — a short
		// auto move can still derive an unreasonable rate and the ceiling alone catches it — is unchanged.
		it("the default ceiling alone already catches a short auto-sized move", () => {
			const plan = planCaptureProfile(coupled(short), 6000, 3000, 2000, 2);
			expect(plan).not.toHaveProperty("error");
			if ("error" in plan) return;
			expect(plan.sampleRateHz).toBe(AUTO_RATE_CEILING_HZ);
			expect(plan.samples).toBeLessThan(3000); // fewer samples, not a longer/different move
			expect(plan.distance).toBeCloseTo(6, 5); // the move itself is untouched
		});

		it("auto mode: a tighter ceiling reduces samples, not distance/moveTime — the move can't always be lengthened (travel is what capped it)", () => {
			const withoutCeiling = planCaptureProfile(coupled(short), 6000, 2000, 2000, 2, { rateCeilingHz: Infinity });
			const withCeiling = planCaptureProfile(coupled(short), 6000, 2000, 2000, 2, { rateCeilingHz: 500 });
			if ("error" in withoutCeiling || "error" in withCeiling) throw new Error("expected both to plan");
			expect(withCeiling.sampleRateHz).toBe(500);
			expect(withCeiling.samples).toBeLessThan(withoutCeiling.samples);
			expect(withCeiling.distance).toBeCloseTo(withoutCeiling.distance, 9);
			expect(withCeiling.moveTimeS).toBeCloseTo(withoutCeiling.moveTimeS, 9);
			expect(withCeiling.startPositions).toEqual(withoutCeiling.startPositions);
		});

		it("explicit distance: a tighter ceiling grows the rest window instead, keeping samples AND the move exactly as requested", () => {
			const field = { letter: "X", min: 0, max: 300, position: 150, homed: true };
			const withoutCeiling = planCaptureProfile(coupled(field), 6000, 2000, 2000, 2, { maxDistanceMm: 10, rateCeilingHz: Infinity });
			const withCeiling = planCaptureProfile(coupled(field), 6000, 2000, 2000, 2, { maxDistanceMm: 10, rateCeilingHz: 500 });
			if ("error" in withoutCeiling || "error" in withCeiling) throw new Error("expected both to plan");
			expect(withCeiling.sampleRateHz).toBe(500);
			expect(withCeiling.samples).toBe(withoutCeiling.samples); // 2000, unchanged
			expect(withCeiling.distance).toBeCloseTo(withoutCeiling.distance, 9); // 10 mm, unchanged
			expect(withCeiling.restTimeS).toBeGreaterThan(withoutCeiling.restTimeS); // window grew instead
		});

		it("omitting rateCeilingHz defaults to AUTO_RATE_CEILING_HZ (no behaviour change for a normal move)", () => {
			const field = { letter: "X", min: 0, max: 300, position: 150, homed: true };
			const defaulted = planCaptureProfile(coupled(field), 6000, 2000, 2000, 2);
			const explicitDefault = planCaptureProfile(coupled(field), 6000, 2000, 2000, 2, { rateCeilingHz: AUTO_RATE_CEILING_HZ });
			expect(defaulted).toEqual(explicitDefault);
		});
	});
});

describe("rateCeilingForBoard", () => {
	it("returns the known-lower ceiling for the reported RP2350-based board", () => {
		expect(rateCeilingForBoard("MNBN17R1_5")).toBeLessThan(AUTO_RATE_CEILING_HZ);
	});
	it("falls back to the general ceiling for any other board shortName", () => {
		expect(rateCeilingForBoard("MB6HC")).toBe(AUTO_RATE_CEILING_HZ);
	});
	it("falls back to the general ceiling when the board (or its shortName) isn't known yet", () => {
		expect(rateCeilingForBoard(null)).toBe(AUTO_RATE_CEILING_HZ);
		expect(rateCeilingForBoard(undefined)).toBe(AUTO_RATE_CEILING_HZ);
	});
});

// docs/PLAN-capture-window.md §4 — a real forum report: a 0.344s auto-planned move left only 0.13s of
// rest, in which the integrator hadn't converged on 29 of 82 captures. These numbers are measured against
// the real report's own move, not invented.
describe("planCaptureProfile — AUTO_REST_MIN_S floor (docs/PLAN-capture-window.md §4)", () => {
	const coupled = (axis: { letter: string; min: number; max: number; position: number; homed: boolean }) => [{ ...axis, perUnit: 1 }];
	// AUTO mode only derives its rate from the move's own duration when maxDistanceMm is omitted/0 — passing
	// a positive maxDistanceMm switches to EXPLICIT mode, a different formula entirely (see the branch in
	// planCaptureProfile). Every test below controls the auto-derived move length via axis TRAVEL instead.

	it("gives a short auto move at least AUTO_REST_MIN_S of rest, not just the fractional 30% share", () => {
		// 50 mm clear travel, 6000 mm/min -> a 46 mm move (2 mm margin each side), 0.46s. The fractional
		// share alone would give 0.46/0.7*0.3 ≈ 0.197s — well under AUTO_REST_MIN_S.
		const shortAxis = { letter: "Y", min: 0, max: 50, position: 25, homed: true };
		const plan = planCaptureProfile(coupled(shortAxis), 6000, 2000, 2000, 2);
		if ("error" in plan) throw new Error("expected a plan");
		// >= in intent; floating-point division can land a hair under AUTO_REST_MIN_S (0.49999999999999994).
		expect(plan.restTimeS).toBeGreaterThanOrEqual(AUTO_REST_MIN_S - 1e-9);
	});

	it("still uses the larger fractional share once the move is long enough to need it", () => {
		// Enough clear travel to reach AUTO_MOVE_CAP_MM's 200 mm cap, long enough that its own 30% rest
		// share already exceeds AUTO_REST_MIN_S — the floor must not shrink it back down.
		const longAxis = { letter: "Y", min: 0, max: 400, position: 200, homed: true };
		const plan = planCaptureProfile(coupled(longAxis), 6000, 2000, 2000, 2);
		if ("error" in plan) throw new Error("expected a plan");
		const fractionalOnly = plan.moveTimeS / 0.7 - plan.moveTimeS; // the 30% share alone would have given
		expect(fractionalOnly).toBeGreaterThan(AUTO_REST_MIN_S);
		expect(plan.restTimeS).toBeCloseTo(fractionalOnly, 6);
	});

	it("lowers the derived rate as a result — the knock-on that also reduces truncation risk (§5)", () => {
		const shortAxis = { letter: "Y", min: 0, max: 50, position: 25, homed: true };
		const withFloor = planCaptureProfile(coupled(shortAxis), 6000, 2000, 2000, 2);
		if ("error" in withFloor) throw new Error("expected a plan");
		// Without AUTO_REST_MIN_S the fractional-only window would derive a much higher rate for the same
		// move; recompute it directly rather than re-deriving the constant, to avoid asserting a tautology.
		const fractionalWindowS = withFloor.moveTimeS / 0.7;
		const fractionalOnlyRate = 2000 / fractionalWindowS;
		expect(withFloor.sampleRateHz).toBeLessThan(fractionalOnlyRate);
	});
});

describe("rateCeilingForCapture (docs/PLAN-capture-window.md §5)", () => {
	it("matches the board ceiling exactly for a single-column capture", () => {
		expect(rateCeilingForCapture("MB6HC", 1)).toBe(AUTO_RATE_CEILING_HZ);
	});

	// The real failure this exists to prevent: 17 columns at ~4167 Hz (~71k values/s) truncated
	// intermittently on a real Duet 3 1HCL — a rate the board's own ceiling alone would have allowed.
	it("lowers the ceiling for a full auto-tune capture (17 columns) below the board's own rate ceiling", () => {
		const ceiling = rateCeilingForCapture("MB6HC", 17);
		expect(ceiling).toBeLessThan(AUTO_RATE_CEILING_HZ);
		expect(ceiling).toBeCloseTo(AUTO_VALUE_RATE_CEILING / 17, 5);
	});

	it("never drops the ceiling below AUTO_RATE_FLOOR_HZ, however many columns are requested", () => {
		expect(rateCeilingForCapture("MB6HC", 1000)).toBe(AUTO_RATE_FLOOR_HZ);
	});

	it("still applies the board's own (lower) ceiling first when that's the tighter constraint", () => {
		// RP2350's 500 Hz ceiling is already below what 3 columns' bandwidth allows, so it should win.
		expect(rateCeilingForCapture("MNBN17R1_5", 3)).toBe(rateCeilingForBoard("MNBN17R1_5"));
	});

	it("treats zero/negative columns as no bandwidth constraint — just the board's own ceiling", () => {
		expect(rateCeilingForCapture("MB6HC", 0)).toBe(AUTO_RATE_CEILING_HZ);
	});
});

describe("coupled kinematics (CoreXY etc.)", () => {
	// The reporter's exact machine (forum bug report): CoreXY, X: 0-230 (pos 15), Y: 0-246 (pos 123),
	// forwardMatrix [[0.5,0.5,0],[0.5,-0.5,0],[0,0,1]] -> tuning Y moves X by +0.5 and Y by -0.5 per mm
	// of motor travel (see kinematics.test.ts for the matrix-reading side of this).
	const xAxis: CoupledAxisLimits = { letter: "X", min: 0, max: 230, position: 15, homed: true, perUnit: 0.5 };
	const yAxis: CoupledAxisLimits = { letter: "Y", min: 0, max: 246, position: 123, homed: true, perUnit: -0.5 };

	it("regression: reproduces the fix for the CoreXY forum report exactly", () => {
		// Before this fix, tuning Y used single-axis planning (perUnit implicitly 1): start Y=23, and
		// the H2 move would have continued toward Y=223 in the planner's own (wrong) frame — but the
		// REAL Cartesian result (via the actual forwardMatrix) was Y=-77 (well past Y-min=0) and X=115
		// (never checked at all, since the old planner only ever looked at the nominal axis).
		const plan = planCoupledCenteredMove([xAxis, yAxis], 200, 2, 5);
		expect(plan).not.toHaveProperty("error");
		if ("error" in plan) return;
		expect(plan.distance).toBeCloseTo(200, 5);

		const xStart = plan.startPositions.find((p) => p.letter === "X")!.position;
		const yStart = plan.startPositions.find((p) => p.letter === "Y")!.position;
		expect(xStart).toBeCloseTo(65, 5);
		expect(yStart).toBeCloseTo(173, 5); // ABOVE Y's midpoint (123) — the reporter's own intuition

		// End positions (start + perUnit*distance) must stay inside both axes' margin-clamped travel.
		const xEnd = xStart + xAxis.perUnit * plan.distance;
		const yEnd = yStart + yAxis.perUnit * plan.distance;
		expect(xEnd).toBeCloseTo(165, 5);
		expect(yEnd).toBeCloseTo(73, 5);
		expect(Math.min(xStart, xEnd)).toBeGreaterThanOrEqual(xAxis.min + 2 - 1e-9);
		expect(Math.max(xStart, xEnd)).toBeLessThanOrEqual(xAxis.max - 2 + 1e-9);
		expect(Math.min(yStart, yEnd)).toBeGreaterThanOrEqual(yAxis.min + 2 - 1e-9);
		expect(Math.max(yStart, yEnd)).toBeLessThanOrEqual(yAxis.max - 2 + 1e-9);
	});

	it("end-to-end via planCaptureProfile: auto mode plans the same safe, coupling-aware move", () => {
		const plan = planCaptureProfile([xAxis, yAxis], 6000, 2000, 2000, 2);
		expect(plan).not.toHaveProperty("error");
		if ("error" in plan) return;
		expect(plan.distance).toBeCloseTo(200, 0);
		const yStart = plan.startPositions.find((p) => p.letter === "Y")!.position;
		expect(yStart).toBeCloseTo(173, 0); // above Y's own midpoint, not below it
	});

	it("clamps distance when the COUPLED axis (not the tuned one) has less room", () => {
		// Y itself has plenty of room, but X (coupled, perUnit 0.5) is narrow.
		const narrowX: CoupledAxisLimits = { letter: "X", min: 0, max: 40, position: 20, homed: true, perUnit: 0.5 };
		const wideY: CoupledAxisLimits = { letter: "Y", min: 0, max: 1000, position: 500, homed: true, perUnit: -0.5 };
		const plan = planCoupledCenteredMove([narrowX, wideY], 200, 2, 5);
		expect(plan).not.toHaveProperty("error");
		if ("error" in plan) return;
		// X: available = 40-2-2=36, cap = 36/0.5 = 72. Y: available=1000-4=996, cap=996/0.5=1992. X limits.
		expect(plan.distance).toBeCloseTo(72, 5);
		expect(plan.limitedBy).toBe("X");
	});

	it("centred-plan error names the limiting coupled axis when even the floor doesn't fit", () => {
		const tinyX: CoupledAxisLimits = { letter: "X", min: 0, max: 5, position: 2.5, homed: true, perUnit: 0.5 };
		const wideY: CoupledAxisLimits = { letter: "Y", min: 0, max: 1000, position: 500, homed: true, perUnit: -0.5 };
		const plan = planCoupledCenteredMove([tinyX, wideY], 200, 2, 10);
		expect(plan).toHaveProperty("error");
		expect((plan as { error: string }).error).toContain("X:");
	});

	it("symmetric plan picks the motor direction with more room, accounting for a negative perUnit", () => {
		// Y sits near its OWN max (243 of 246) but perUnit is negative, so moving the motor in the
		// POSITIVE direction actually moves Y toward its min (plenty of room), while the NEGATIVE motor
		// direction would push Y toward its max (almost none left). X (perUnit +0.5) is centred either way.
		const yNearMax: CoupledAxisLimits = { letter: "Y", min: 0, max: 246, position: 243, homed: true, perUnit: -0.5 };
		const xCentred: CoupledAxisLimits = { letter: "X", min: 0, max: 230, position: 115, homed: true, perUnit: 0.5 };
		const plan = planCoupledSymmetricMove([xCentred, yNearMax], 50, 2, 1);
		expect(plan).not.toHaveProperty("error");
		if ("error" in plan) return;
		expect(plan.sign).toBe(1); // positive motor direction -> Y moves toward min (safe), not max (unsafe)
	});

	it("symmetric plan fails cleanly when neither motor direction has enough combined clearance", () => {
		const tinyX: CoupledAxisLimits = { letter: "X", min: 0, max: 5, position: 2.5, homed: true, perUnit: 0.5 };
		const wideY: CoupledAxisLimits = { letter: "Y", min: 0, max: 1000, position: 500, homed: true, perUnit: -0.5 };
		const plan = planCoupledSymmetricMove([tinyX, wideY], 50, 2, 10);
		expect(plan).toHaveProperty("error");
		expect((plan as { error: string }).error).toContain("X:");
	});
});
