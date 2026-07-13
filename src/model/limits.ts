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
/** Cap on the "auto" (longest-reasonable) tuning move, so capture windows stay sane on a very long axis. */
export const AUTO_MOVE_CAP_MM = 200;
/** Never derive a sample rate below this for an auto-sized move — preserves capture resolution; the
 * move shrinks instead of sampling slower than this. */
export const AUTO_RATE_FLOOR_HZ = 250;

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

export interface CenteredMovePlan {
	/** mm, positive magnitude — the H2 tuning move's own length. */
	distance: number;
	/** Always +1: a centred move is symmetric about the midpoint, so both directions have identical
	 * clear travel by construction — there's no "which way has more room" choice to make. Kept for
	 * shape-compatibility with `planSymmetricMove`. */
	sign: 1;
	/** Machine position (mm) to pre-position to via a normal (soft-limit-respecting) G1 move before the
	 * H2 tuning move runs. The H2 move then covers `distance`, ending at `startPosition + distance`. */
	startPosition: number;
}

export type CenteredMovePlanResult = CenteredMovePlan | { error: string };

/**
 * Plan a tuning move CENTRED on the middle of the axis's travel: pre-position to `mid − d/2`, then the
 * H2 move covers `d`, ending at `mid + d/2`. This uses nearly the full clear travel
 * (`max − min − 2·margin`) as available distance — `planSymmetricMove` centres the AXIS first and then
 * moves one-way FROM there, so on a 350 mm axis sitting at its 175 mm midpoint it could only ever move
 * ~175 mm even though ~346 mm (minus margins) was actually clear on both sides.
 */
export function planCenteredMove(limits: AxisLimits, desiredDistance: number, marginMm: number, minDistance: number): CenteredMovePlanResult {
	const available = (limits.max - marginMm) - (limits.min + marginMm);
	if (available < minDistance) {
		return {
			error: `${limits.letter}: only ${Math.max(available, 0).toFixed(2)} mm clear between the travel limits `
				+ `(incl. ${marginMm} mm margin each side) — need at least ${minDistance.toFixed(2)} mm.`,
		};
	}
	const distance = Math.min(desiredDistance, available);
	return { distance, sign: 1, startPosition: midpoint(limits) - distance / 2 };
}

export interface CaptureProfile {
	/** mm, positive magnitude */
	distance: number;
	sign: 1 | -1;
	/** Machine position (mm) to pre-position to before the H2 move — 0 when there's no axis to centre on. */
	startPosition: number;
	/** Seconds the move itself takes at the given feed. */
	moveTimeS: number;
	/** Seconds of the capture window left over after the move — the at-rest tail I/D/ring metrics need. */
	restTimeS: number;
	/** Sample rate to actually use for the capture — the requested rate in explicit-distance mode, or
	 * one derived from the move's own duration in "auto" (longest) mode. */
	sampleRateHz: number;
}

const CAPTURE_REST_FRACTION_DEFAULT = 0.3;   // reserve this fraction of the capture window for the at-rest tail
const CAPTURE_MIN_DISTANCE_FRACTION = 0.25;  // explicit mode: still require this fraction of the requested distance
const AUTO_MIN_DISTANCE_MM = 5;              // auto mode: a small absolute floor, not a fraction of the 200 mm cap

/**
 * Size a single trapezoid tuning move so its capture window has both a real accel/cruise/decel section
 * AND a meaningful at-rest tail afterward — one capture serving every P/D/I/A/V decision instead of a
 * separate "step" move and "A/V" move. Move is centred on the axis's midpoint (`planCenteredMove`), not
 * one-way from wherever the axis happens to be, so the full clear travel is available.
 *
 * Two modes, selected by `opts.maxDistanceMm`:
 *  - **explicit** (a positive value): that's the target distance (clamped to what's clear), and the
 *    capture window is `samples / sampleRateHz` as given — unchanged contract from before.
 *  - **auto** (0, undefined, or omitted): use the longest reasonable move (up to `AUTO_MOVE_CAP_MM`),
 *    and DERIVE the sample rate from its duration instead of the other way around — a longer cruise
 *    section measures V/A more reliably than a short one at a fixed rate. The derived rate is floored
 *    at `AUTO_RATE_FLOOR_HZ`; if even that floor can't stretch `samples` across the window, the move
 *    shrinks instead of losing resolution.
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
	const feedMmPerS = feedMmPerMin / 60;
	if (!(feedMmPerS > 0)) { return { error: "Feed rate is too small to plan a tuning move." }; }

	const auto = opts.maxDistanceMm == null || opts.maxDistanceMm <= 0;
	const targetDistance = auto ? AUTO_MOVE_CAP_MM : opts.maxDistanceMm!;

	let distance = targetDistance;
	let startPosition = 0;
	if (limits) {
		// Auto mode's target is a CAP ("as long as reasonable"), not a real request, so its floor is a
		// small absolute distance — scaling by 25% of a 200 mm cap would reject a perfectly usable 46 mm
		// move on a short axis. Explicit mode's target IS a real request, so 25% of it is the right floor.
		const minDistance = auto
			? (opts.minDistanceFloorMm ?? AUTO_MIN_DISTANCE_MM)
			: Math.max(opts.minDistanceFloorMm ?? 0.05, targetDistance * CAPTURE_MIN_DISTANCE_FRACTION);
		const plan = planCenteredMove(limits, targetDistance, marginMm, minDistance);
		if ("error" in plan) { return plan; }
		distance = plan.distance;
		startPosition = plan.startPosition;
	}

	let moveTimeS = distance / feedMmPerS;
	let effectiveRate = sampleRateHz > 0 ? sampleRateHz : AUTO_RATE_FLOOR_HZ;
	let windowS: number;

	if (auto) {
		windowS = moveTimeS / (1 - restFraction);
		effectiveRate = samples / windowS;
		if (effectiveRate < AUTO_RATE_FLOOR_HZ) {
			// Even the floor rate can't stretch `samples` across this long a move's window — shrink the
			// move instead of sampling slower than the floor.
			effectiveRate = AUTO_RATE_FLOOR_HZ;
			windowS = samples / effectiveRate;
			moveTimeS = windowS * (1 - restFraction);
			distance = moveTimeS * feedMmPerS;
			if (limits) { startPosition = midpoint(limits) - distance / 2; }
		}
	} else {
		windowS = effectiveRate > 0 ? samples / effectiveRate : 4;
	}

	if (!(distance > 0)) { return { error: "Feed rate or capture window is too small to plan a tuning move." }; }
	return { distance, sign: 1, startPosition, moveTimeS, restTimeS: Math.max(0, windowS - moveTimeS), sampleRateHz: effectiveRate };
}
