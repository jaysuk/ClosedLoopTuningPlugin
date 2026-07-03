/**
 * Travel-limit safety helpers for loaded-axis tuning.
 *
 * Tuning moves are sent with G1's H2 (individual motor) mode, which drives the motor directly and
 * bypasses RRF's kinematics — so M208 soft limits are never applied to them. With the axis now tuned
 * while still coupled to the machine, these helpers are the only thing standing between a tuning move
 * and the frame.
 */

export interface AxisLimits {
	letter: string;
	min: number;
	max: number;
	position: number;
	homed: boolean;
}

export interface MovePlan {
	/** mm, positive magnitude */
	distance: number;
	sign: 1 | -1;
}

export type MovePlanResult = MovePlan | { error: string };

export const DEFAULT_MARGIN_MM = 2;
export const CENTER_TOLERANCE_MM = 0.5;
export const CENTERING_FEED_MM_MIN = 3000;

/** Number(...), but null/undefined stay null instead of coercing to 0 — needed since machinePosition is null when unknown. */
function toFiniteNumber(v: unknown): number | null {
	if (v === null || v === undefined) { return null; }
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

/**
 * Pull usable travel-limit info out of an object-model axis entry. Returns null if it isn't a real,
 * positioned axis (e.g. an extruder, or the model hasn't reported a position/limits yet) — callers
 * should skip limit checks entirely in that case rather than guessing.
 */
export function getAxisLimits(axis: unknown): AxisLimits | null {
	const a = axis as { letter?: string; min?: unknown; max?: unknown; machinePosition?: unknown; homed?: unknown } | null | undefined;
	if (!a?.letter) { return null; }
	const min = toFiniteNumber(a.min);
	const max = toFiniteNumber(a.max);
	const position = toFiniteNumber(a.machinePosition);
	if (min === null || max === null || position === null || max <= min) { return null; }
	return { letter: a.letter, min, max, position, homed: !!a.homed };
}

export function midpoint(limits: AxisLimits): number {
	return (limits.min + limits.max) / 2;
}

/**
 * Plan a symmetric out-and-back tuning move: pick whichever direction has more clear travel once the
 * safety margin is reserved at both limits, and clamp the distance to what's actually available.
 * Fails (returns an error) if neither direction has at least minDistance of clear travel.
 */
export function planSymmetricMove(limits: AxisLimits, desiredDistance: number, marginMm: number, minDistance: number): MovePlanResult {
	const headroomPos = limits.max - marginMm - limits.position;
	const headroomNeg = limits.position - (limits.min + marginMm);
	const useMax = headroomPos >= headroomNeg;
	const best = useMax ? headroomPos : headroomNeg;
	if (best < minDistance) {
		return {
			error: `${limits.letter}: only ${Math.max(best, 0).toFixed(2)} mm clear of the ${useMax ? "max" : "min"} limit `
				+ `(incl. ${marginMm} mm margin) — need at least ${minDistance.toFixed(2)} mm.`,
		};
	}
	return { distance: Math.min(desiredDistance, best), sign: useMax ? 1 : -1 };
}

export interface CaptureProfile {
	/** mm, positive magnitude */
	distance: number;
	sign: 1 | -1;
	/** Seconds the move itself takes at the given feed. */
	moveTimeS: number;
	/** Seconds of the capture window left over after the move — the at-rest tail I/D/ring metrics need. */
	restTimeS: number;
}

const CAPTURE_REST_FRACTION_DEFAULT = 0.3;   // reserve this fraction of the capture window for the at-rest tail
const CAPTURE_MIN_DISTANCE_FRACTION = 0.25;  // ...but still require this fraction of the desired distance

/**
 * Size a single trapezoid tuning move so its capture window has both a real accel/cruise/decel section
 * AND a meaningful at-rest tail afterward — one capture serving every P/D/I/A/V decision instead of a
 * separate "step" move and "A/V" move. Distance is derived from the feed and the sample window (so it
 * scales with the capture settings), then clamped to whatever travel `planSymmetricMove` finds safe.
 */
export function planCaptureProfile(
	limits: AxisLimits | null,
	feedMmPerMin: number,
	samples: number,
	sampleRateHz: number,
	marginMm: number,
	opts: { restFraction?: number; maxDistanceMm?: number; minDistanceFloorMm?: number } = {},
): CaptureProfile | { error: string } {
	const restFraction = opts.restFraction ?? CAPTURE_REST_FRACTION_DEFAULT;
	const windowS = sampleRateHz > 0 ? samples / sampleRateHz : 4;
	const feedMmPerS = feedMmPerMin / 60;
	let desired = windowS * (1 - restFraction) * feedMmPerS;
	if (opts.maxDistanceMm != null) { desired = Math.min(desired, opts.maxDistanceMm); }
	if (!(desired > 0) || !(feedMmPerS > 0)) {
		return { error: "Feed rate or capture window is too small to plan a tuning move." };
	}
	if (!limits) {
		return { distance: desired, sign: 1, moveTimeS: desired / feedMmPerS, restTimeS: Math.max(0, windowS - desired / feedMmPerS) };
	}
	const minDistance = Math.max(opts.minDistanceFloorMm ?? 0.05, desired * CAPTURE_MIN_DISTANCE_FRACTION);
	const plan = planSymmetricMove(limits, desired, marginMm, minDistance);
	if ("error" in plan) { return plan; }
	const moveTimeS = plan.distance / feedMmPerS;
	return { distance: plan.distance, sign: plan.sign, moveTimeS, restTimeS: Math.max(0, windowS - moveTimeS) };
}
