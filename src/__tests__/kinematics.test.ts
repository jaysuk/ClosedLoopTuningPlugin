import { describe, expect, it } from "vitest";

import { resolveMotionCoupling } from "../model/kinematics";

const XYZ = [{ letter: "X" }, { letter: "Y" }, { letter: "Z" }];

// The reporter's exact machine (forum bug report): CoreXY, forwardMatrix reported live by RRF's object
// model for their configuration. Confirmed algebraically to be the textbook CoreXY relationship
// (motorA = X+Y, motorB = X-Y) — see PLAN-corexy-coupling.md. NOTE this matrix is SYMMETRIC, so it
// cannot distinguish row-major from column-major reading; MARK_FORGED_MATRIX below is what pins that.
const CORE_XY_MATRIX = [
	[0.5, 0.5, 0],
	[0.5, -0.5, 0],
	[0, 0, 1],
];

// markForged: RRF sets inverseMatrix = I with (1,0) = -1, i.e. motorA = X, motorB = Y - X, so the
// forward relationship is X = motorA, Y = motorA + motorB. In RRF's [motor][axis] serialisation that is
// [[1,1,0],[0,1,0],[0,0,1]] — deliberately NON-SYMMETRIC, so reading the column instead of the row
// gives a provably different (and dangerously under-constrained) answer. See kinematics.ts's INDEXING
// note for the RRF source trace.
const MARK_FORGED_MATRIX = [
	[1, 1, 0],  // motor A (the X axis's own motor) moves X by 1 AND Y by 1
	[0, 1, 0],  // motor B (the Y axis's own motor) moves Y only
	[0, 0, 1],
];

describe("resolveMotionCoupling", () => {
	it("cartesian (identity matrix) resolves to a single independent-axis effect", () => {
		const identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
		const result = resolveMotionCoupling({ name: "cartesian", forwardMatrix: identity }, XYZ, 0);
		expect(result).not.toHaveProperty("error");
		if ("error" in result) return;
		expect(result.fromMatrix).toBe(true);
		expect(result.effects).toEqual([{ index: 0, letter: "X", perUnit: 1 }]);
	});

	it("coreXY tuning Y: reproduces the reporter's exact bug — X moves +0.5, Y moves -0.5 per mm of Y motor travel", () => {
		const result = resolveMotionCoupling({ name: "coreXY", forwardMatrix: CORE_XY_MATRIX }, XYZ, 1);
		expect(result).not.toHaveProperty("error");
		if ("error" in result) return;
		expect(result.letter).toBe("Y");
		expect(result.fromMatrix).toBe(true);
		expect(result.effects).toEqual([
			{ index: 0, letter: "X", perUnit: 0.5 },
			{ index: 1, letter: "Y", perUnit: -0.5 },
		]);
		// The tuned axis's own perUnit is NEGATIVE — this single number is the whole bug: a positive H2
		// move on the Y motor moves Cartesian Y in the negative direction.
		const ownEffect = result.effects.find((e) => e.index === 1)!;
		expect(ownEffect.perUnit).toBeLessThan(0);
	});

	it("coreXY tuning X: both axes move +0.5 per mm (no sign inversion on this column)", () => {
		const result = resolveMotionCoupling({ name: "coreXY", forwardMatrix: CORE_XY_MATRIX }, XYZ, 0);
		expect(result).not.toHaveProperty("error");
		if ("error" in result) return;
		expect(result.effects).toEqual([
			{ index: 0, letter: "X", perUnit: 0.5 },
			{ index: 1, letter: "Y", perUnit: 0.5 },
		]);
	});

	// --- Non-symmetric matrix: these are the tests that pin the [motor][axis] row-major convention.
	// A column-major (transposed) read passes every CoreXY test above but fails all three of these.

	it("markForged tuning X: reports the 1:1 coupling to Y that a transposed read would miss entirely", () => {
		const result = resolveMotionCoupling({ name: "markForged", forwardMatrix: MARK_FORGED_MATRIX }, XYZ, 0);
		expect(result).not.toHaveProperty("error");
		if ("error" in result) return;
		// Row 0 = [1,1,0]: motor A moves BOTH axes. Reading column 0 ([1,0,0]) would say "X only" and
		// leave Y completely unbounds-checked — the exact failure class this module exists to prevent.
		expect(result.effects).toEqual([
			{ index: 0, letter: "X", perUnit: 1 },
			{ index: 1, letter: "Y", perUnit: 1 },
		]);
	});

	it("markForged tuning Y: reports Y only, not a phantom coupling to X", () => {
		const result = resolveMotionCoupling({ name: "markForged", forwardMatrix: MARK_FORGED_MATRIX }, XYZ, 1);
		expect(result).not.toHaveProperty("error");
		if ("error" in result) return;
		// Row 1 = [0,1,0]. A transposed read (column 1 = [1,1,0]) would invent an X coupling that
		// doesn't exist, needlessly shrinking the usable move.
		expect(result.effects).toEqual([{ index: 1, letter: "Y", perUnit: 1 }]);
	});

	it("regression: row-major and column-major disagree on a non-symmetric matrix (guards the convention)", () => {
		// Belt-and-braces: assert the two readings genuinely differ here, so this fixture can never
		// silently stop discriminating between the conventions if the matrix is ever edited.
		const asRow = MARK_FORGED_MATRIX[0];
		const asColumn = MARK_FORGED_MATRIX.map((r) => r[0]);
		expect(asRow).not.toEqual(asColumn);
	});

	it("coreXY tuning Z: independent of X/Y on this kinematics", () => {
		const result = resolveMotionCoupling({ name: "coreXY", forwardMatrix: CORE_XY_MATRIX }, XYZ, 2);
		expect(result).not.toHaveProperty("error");
		if ("error" in result) return;
		expect(result.effects).toEqual([{ index: 2, letter: "Z", perUnit: 1 }]);
	});

	it("axis index beyond the matrix's own dimensions falls back to independent", () => {
		const axes = [{ letter: "X" }, { letter: "Y" }, { letter: "Z" }, { letter: "U" }];
		const result = resolveMotionCoupling({ name: "coreXYU", forwardMatrix: CORE_XY_MATRIX }, axes, 3);
		expect(result).not.toHaveProperty("error");
		if ("error" in result) return;
		expect(result.fromMatrix).toBe(false);
		expect(result.effects).toEqual([{ index: 3, letter: "U", perUnit: 1 }]);
	});

	it("no matrix, cartesian name -> independent-axis fallback", () => {
		const result = resolveMotionCoupling({ name: "cartesian" }, XYZ, 0);
		expect(result).not.toHaveProperty("error");
		if ("error" in result) return;
		expect(result.fromMatrix).toBe(false);
		expect(result.effects).toEqual([{ index: 0, letter: "X", perUnit: 1 }]);
	});

	for (const name of ["delta", "Rotary delta", "Scara", "FiveBarScara", "Polar", "Hangprinter"]) {
		it(`refuses ${name} (no linear motor-to-Cartesian relationship)`, () => {
			const result = resolveMotionCoupling({ name }, XYZ, 0);
			expect(result).toHaveProperty("error");
		});
	}

	it("refuses an unrecognised kinematics name with no matrix, rather than guessing independence", () => {
		const result = resolveMotionCoupling({ name: "someFutureKinematics" }, XYZ, 0);
		expect(result).toHaveProperty("error");
	});

	it("refuses when kinematics is entirely missing", () => {
		const result = resolveMotionCoupling(null, XYZ, 0);
		expect(result).toHaveProperty("error");
	});

	it("refuses a ragged/malformed matrix instead of computing a bogus coupling", () => {
		const ragged = [[0.5, 0.5, 0], [0.5], [0, 0, 1]]; // row 1 too short
		const result = resolveMotionCoupling({ name: "coreXY", forwardMatrix: ragged }, XYZ, 1);
		expect(result).toHaveProperty("error");
	});

	it("refuses a non-numeric matrix entry even when it's outside the row being read", () => {
		// The bad entry is in row 0 while we read row 1 — the whole matrix is validated, because a
		// matrix RRF garbled anywhere shouldn't be trusted for a travel-limit safety decision.
		const bad = [[0.5, "oops", 0], [0.5, -0.5, 0], [0, 0, 1]];
		const result = resolveMotionCoupling({ name: "coreXY", forwardMatrix: bad }, XYZ, 1);
		expect(result).toHaveProperty("error");
	});

	it("refuses a null matrix entry rather than silently reading it as zero coupling", () => {
		// Number(null) === 0, so a lax cast would treat this as "this motor doesn't move that axis".
		const withNull = [[0.5, 0.5, 0], [0.5, null, 0], [0, 0, 1]];
		const result = resolveMotionCoupling({ name: "coreXY", forwardMatrix: withNull }, XYZ, 1);
		expect(result).toHaveProperty("error");
	});

	it("refuses when the tuned motor's row has no effect on any axis", () => {
		const allZero = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
		const result = resolveMotionCoupling({ name: "coreXY", forwardMatrix: allZero }, XYZ, 0);
		expect(result).toHaveProperty("error");
	});

	it("an empty matrix array is treated as no matrix (falls through to the name-based rules)", () => {
		const result = resolveMotionCoupling({ name: "cartesian", forwardMatrix: [] }, XYZ, 0);
		expect(result).not.toHaveProperty("error");
		if ("error" in result) return;
		expect(result.fromMatrix).toBe(false);
	});

	it("errors when the tuned axis index itself doesn't exist", () => {
		const result = resolveMotionCoupling({ name: "cartesian" }, XYZ, 9);
		expect(result).toHaveProperty("error");
	});
});
