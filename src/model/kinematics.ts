/**
 * Kinematics-aware coupling between a tuned axis's own motor (driven directly via G1 H2, bypassing
 * kinematics) and every Cartesian axis that motor actually displaces.
 *
 * Tuning moves use G1's H2 (individual motor) mode, which drives one axis's own configured driver
 * directly and bypasses RRF's kinematics transform entirely. On a Cartesian machine that's harmless —
 * one motor is one axis. On CoreXY (and CoreXZ, CoreXYU, CoreXYUV, markForged — anything built on RRF's
 * CoreKinematics) it is not: a single motor is mechanically coupled to more than one Cartesian axis, so
 * moving it alone can move the toolhead diagonally, and — critically — the SIGN can differ from the
 * axis's own nominal direction (see the field report this module fixes: tuning "Y" on a CoreXY moved the
 * toolhead toward Y-min, not Y-max, because the Y motor's own positive direction maps to negative
 * Cartesian Y once mixed with the X motor being held still).
 *
 * RRF's object model reports a `forwardMatrix` for any CoreKinematics-based configuration (cartesian
 * included, as an identity matrix). This module reads it directly instead of hardcoding any
 * kinematics-specific belt maths, so it's correct for whatever matrix THIS machine actually reports
 * rather than a guessed convention.
 *
 * INDEXING — verified against RRF source (Duet3D/RepRapFirmware 3.6-dev), not assumed:
 *   `CoreKinematics::MotorStepsToCartesian` computes
 *       machinePos[axis] = SUM over motor of  forwardMatrix(motor, axis) * motorPos[motor]
 *   and the object model serialises that same (motor, axis) order — `CoreKinematics.cpp`'s array table
 *   evaluates `forwardMatrix(context.GetIndex(1), context.GetLastIndex())`, where `GetIndex(1)` is the
 *   OUTER index and `GetLastIndex()` the inner (see `ObjectExplorationContext::GetIndex`, which returns
 *   `indices[numIndicesCounted - n - 1]`).
 * So the JSON is **forwardMatrix[motor][axis]**: to find what the tuned axis's own motor does to every
 * Cartesian axis, read ROW `tunedAxisIndex` — NOT the column.
 *
 * This distinction is invisible on CoreXY and cartesian (both matrices are symmetric, so row == column)
 * but decisive on the non-symmetric core kinematics. On markForged (X = motorA, Y = motorA + motorB,
 * giving forwardMatrix [[1,1,0],[0,1,0],[0,0,1]]) reading the column instead of the row would report
 * tuning X as moving only X — missing a real 1:1 coupling to Y, leaving Y completely unbounds-checked.
 */

export const COUPLING_EPSILON = 1e-6;

/** Kinematics whose motor→Cartesian relationship is genuinely non-linear — no matrix exists to reason
 * about, so a G1 H2 tuning move's Cartesian effect can't be computed at all. Exact RRF KinematicsName
 * enum values (case-sensitive), confirmed against @duet3d/objectmodel. */
const NON_LINEAR_KINEMATICS = new Set([
	"delta", "Rotary delta", "Scara", "FiveBarScara", "Polar", "Hangprinter",
]);

/** Cartesian effect of moving the tuned axis's own motor by 1 mm. */
export interface CoupledAxisEffect {
	/** Index into move.axes[]. */
	index: number;
	letter: string;
	/** mm of movement on THIS axis per 1 mm of H2 motor movement on the tuned axis's own driver. */
	perUnit: number;
}

export interface MotionCoupling {
	/** Index of the tuned axis into move.axes[]. */
	index: number;
	letter: string;
	/** Every axis with a non-negligible effect, including the tuned axis itself. */
	effects: Array<CoupledAxisEffect>;
	/** False when this is the identity (independent-axis) fallback rather than a real matrix read. */
	fromMatrix: boolean;
	kinematicsName: string;
}

export type MotionCouplingResult = MotionCoupling | { error: string };

function axisLetter(axis: unknown): string | null {
	const letter = (axis as { letter?: unknown } | null | undefined)?.letter;
	return typeof letter === "string" && letter ? letter : null;
}

function independentFallback(axes: Array<unknown>, tunedAxisIndex: number, kinematicsName: string): MotionCouplingResult {
	const letter = axisLetter(axes[tunedAxisIndex]);
	if (!letter) { return { error: `No axis at index ${tunedAxisIndex}.` }; }
	return {
		index: tunedAxisIndex, letter, kinematicsName, fromMatrix: false,
		effects: [{ index: tunedAxisIndex, letter, perUnit: 1 }],
	};
}

/**
 * Resolve which Cartesian axes a G1 H2 move on `tunedAxisIndex`'s own motor actually displaces, and by
 * how much per mm of motor travel. Never guesses: an unrecognised kinematics with no usable matrix
 * returns an error rather than assuming independent (Cartesian-style) axes.
 *
 * Resolution order:
 *  1. A well-formed `forwardMatrix` with `tunedAxisIndex` inside its bounds → read ROW
 *     `tunedAxisIndex` directly (covers cartesian, coreXY, coreXZ, coreXYU, coreXYUV, markForged — every
 *     CoreKinematics-based configuration, cartesian included since it reports an identity matrix).
 *  2. `tunedAxisIndex` beyond the matrix's own dimensions (e.g. a U axis on a 3x3 coreXY matrix) → that
 *     motor has no row in the matrix, so it's independent by construction.
 *  3. No matrix at all, kinematics name is "cartesian" → independent-axis fallback (belt-and-braces;
 *     rule 1 already covers cartesian machines that DO report their identity matrix).
 *  4. No matrix, name is a known non-linear kinematics (delta, Scara, Polar, Hangprinter, ...) → error.
 *     These have no linear motor↔Cartesian relationship; there is no safe distance to compute.
 *  5. Anything else → error, conservatively.
 */
export function resolveMotionCoupling(kinematics: unknown, axes: Array<unknown>, tunedAxisIndex: number): MotionCouplingResult {
	const letter = axisLetter(axes[tunedAxisIndex]);
	if (!letter) { return { error: `No axis at index ${tunedAxisIndex}.` }; }

	const k = kinematics as { name?: unknown; forwardMatrix?: unknown } | null | undefined;
	const name = typeof k?.name === "string" && k.name ? k.name : "unknown";
	const matrix = k?.forwardMatrix;

	if (Array.isArray(matrix) && matrix.length > 0) {
		if (tunedAxisIndex >= matrix.length) {
			return independentFallback(axes, tunedAxisIndex, name);
		}
		// Validate the WHOLE matrix before trusting any of it: this feeds a travel-limit safety decision,
		// so a matrix with garbage anywhere in it (ragged rows, non-numeric or null entries) is rejected
		// outright rather than partially believed. Note `Number(null)` and `Number("")` are both 0, which
		// would silently read as "no coupling" — hence the strict typeof check rather than a Number() cast.
		const cols = Array.isArray(matrix[0]) ? (matrix[0] as Array<unknown>).length : -1;
		if (cols <= 0) { return { error: `${name}: forwardMatrix row 0 is malformed.` }; }
		for (let r = 0; r < matrix.length; r++) {
			const mrow = matrix[r];
			if (!Array.isArray(mrow) || mrow.length !== cols) {
				return { error: `${name}: forwardMatrix row ${r} is malformed (expected ${cols} entries).` };
			}
			for (let c = 0; c < mrow.length; c++) {
				if (typeof mrow[c] !== "number" || !Number.isFinite(mrow[c])) {
					return { error: `${name}: forwardMatrix[${r}][${c}] is not a finite number.` };
				}
			}
		}

		// forwardMatrix is [motor][axis] (see the INDEXING note above) and motor index == axis index for
		// core kinematics, so the tuned axis's own motor is ROW `tunedAxisIndex`, whose elements are the
		// per-mm effect on each Cartesian axis in turn.
		const row = matrix[tunedAxisIndex] as Array<number>;
		const effects: Array<CoupledAxisEffect> = [];
		for (let i = 0; i < row.length && i < axes.length; i++) {
			const perUnit = row[i];
			if (Math.abs(perUnit) > COUPLING_EPSILON) {
				const axisL = axisLetter(axes[i]);
				if (!axisL) { return { error: `No axis at index ${i}.` }; }
				effects.push({ index: i, letter: axisL, perUnit });
			}
		}
		if (effects.length === 0) {
			return { error: `${name}: forwardMatrix row ${tunedAxisIndex} (${letter}) has no effect on any axis — can't plan a tuning move.` };
		}
		return { index: tunedAxisIndex, letter, kinematicsName: name, fromMatrix: true, effects };
	}

	if (name === "cartesian") {
		return independentFallback(axes, tunedAxisIndex, name);
	}
	if (NON_LINEAR_KINEMATICS.has(name)) {
		return { error: `${name} kinematics has no linear motor-to-Cartesian relationship — closed-loop tuning moves aren't supported on this kinematics yet.` };
	}
	return { error: `Unrecognised kinematics "${name}" with no forwardMatrix reported — can't safely plan a tuning move. Please report this kinematics name so support can be added.` };
}
