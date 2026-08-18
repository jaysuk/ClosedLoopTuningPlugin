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
 * One axis's travel limits plus how much a tuned motor's H2 movement displaces it — see kinematics.ts.
 * `perUnit: 1` is the independent-axis case (Cartesian, or the tuned axis itself on any kinematics).
 */
export interface CoupledAxisLimits extends AxisLimits {
	/** mm of movement on this axis per 1 mm of H2 motor movement on the tuned axis's own driver. */
	perUnit: number;
}

/**
 * Coupled-aware version of `planSymmetricMove`: picks whichever motor-space direction leaves EVERY
 * axis a tuned motor displaces with the most clear travel, accounting for each one's `perUnit` sign — a
 * negative `perUnit` means increasing motor-space position moves that axis toward its MIN, not its max.
 * `planSymmetricMove` is the single-axis (`perUnit: 1`) special case of this.
 */
export function planCoupledSymmetricMove(axes: Array<CoupledAxisLimits>, desiredDistance: number, marginMm: number, minDistance: number): MovePlanResult {
	let plus = Infinity;
	let minus = Infinity;
	let plusLimiter: CoupledAxisLimits | null = null;
	let minusLimiter: CoupledAxisLimits | null = null;
	for (const a of axes) {
		const headroomToMax = (a.max - marginMm) - a.position;
		const headroomToMin = a.position - (a.min + marginMm);
		// +1 mm of motor movement moves this axis by perUnit mm: toward max if perUnit>0, toward min if perUnit<0.
		const towardMax = a.perUnit > 0 ? headroomToMax / a.perUnit : headroomToMin / -a.perUnit;
		const towardMin = a.perUnit > 0 ? headroomToMin / a.perUnit : headroomToMax / -a.perUnit;
		if (towardMax < plus) { plus = towardMax; plusLimiter = a; }
		if (towardMin < minus) { minus = towardMin; minusLimiter = a; }
	}
	plus = Math.max(0, plus);
	minus = Math.max(0, minus);
	const useMax = plus >= minus;
	const best = useMax ? plus : minus;
	const limiter = useMax ? plusLimiter : minusLimiter;
	if (best < minDistance) {
		const who = limiter ? limiter.letter : "?";
		return {
			error: `${who}: only ${best.toFixed(2)} mm of motor travel clear toward the ${useMax ? "positive" : "negative"} `
				+ `direction (incl. ${marginMm} mm margin) — need at least ${minDistance.toFixed(2)} mm.`,
		};
	}
	return { distance: Math.min(desiredDistance, best), sign: useMax ? 1 : -1 };
}

/**
 * Plan a symmetric out-and-back tuning move: pick whichever direction has more clear travel once the
 * safety margin is reserved at both limits, and clamp the distance to what's actually available.
 * Fails (returns an error) if neither direction has at least minDistance of clear travel.
 *
 * Single-axis (`perUnit: 1`) special case of `planCoupledSymmetricMove` — kept as its own entry point
 * since most callers (and every existing test) only ever deal with one independent axis.
 */
export function planSymmetricMove(limits: AxisLimits, desiredDistance: number, marginMm: number, minDistance: number): MovePlanResult {
	return planCoupledSymmetricMove([{ ...limits, perUnit: 1 }], desiredDistance, marginMm, minDistance);
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

export interface CoupledCenteredMovePlan {
	/** mm, positive magnitude — MOTOR-space length of the H2 move (not the Cartesian displacement any
	 * one coupled axis sees, which is `perUnit * distance`). */
	distance: number;
	sign: 1;
	/** Machine position (mm) to pre-position EACH affected axis to, via one normal (soft-limit-
	 * respecting) multi-axis G1 move, before the H2 tuning move runs. */
	startPositions: Array<{ letter: string; position: number }>;
	/** Which coupled axis's clear travel capped the distance below `desiredDistance`, or null if the
	 * requested distance fit everywhere without any axis being the binding constraint. */
	limitedBy: string | null;
}

export type CoupledCenteredMovePlanResult = CoupledCenteredMovePlan | { error: string };

/**
 * Coupled-aware version of `planCenteredMove`: centres a MOTOR-space H2 move so that EVERY axis it
 * actually displaces (per `perUnit`, from kinematics.ts) stays within its own margin-clamped travel.
 * `planCenteredMove` is the single-axis (`perUnit: 1`) special case of this.
 */
export function planCoupledCenteredMove(
	axes: Array<CoupledAxisLimits>, desiredDistance: number, marginMm: number, minDistance: number,
): CoupledCenteredMovePlanResult {
	let distance = desiredDistance;
	let limitingAxis: CoupledAxisLimits | null = null;
	for (const a of axes) {
		const available = (a.max - marginMm) - (a.min + marginMm);
		if (available <= 0) {
			return { error: `${a.letter}: no clear travel once the ${marginMm} mm margin is reserved each side.` };
		}
		const cap = available / Math.abs(a.perUnit);
		if (cap < distance) { distance = cap; limitingAxis = a; }
	}
	if (distance < minDistance) {
		const who = limitingAxis ? limitingAxis.letter : "?";
		return {
			error: `${who}: only ${Math.max(distance, 0).toFixed(2)} mm of motor travel clear `
				+ `(incl. ${marginMm} mm margin) — need at least ${minDistance.toFixed(2)} mm.`,
		};
	}
	return {
		distance, sign: 1, limitedBy: limitingAxis?.letter ?? null,
		startPositions: axes.map((a) => ({ letter: a.letter, position: midpoint(a) - a.perUnit * distance / 2 })),
	};
}

/**
 * Plan a tuning move CENTRED on the middle of the axis's travel: pre-position to `mid − d/2`, then the
 * H2 move covers `d`, ending at `mid + d/2`. This uses nearly the full clear travel
 * (`max − min − 2·margin`) as available distance — `planSymmetricMove` centres the AXIS first and then
 * moves one-way FROM there, so on a 350 mm axis sitting at its 175 mm midpoint it could only ever move
 * ~175 mm even though ~346 mm (minus margins) was actually clear on both sides.
 *
 * Single-axis (`perUnit: 1`) special case of `planCoupledCenteredMove` — kept as its own entry point
 * since most callers (and every existing test) only ever deal with one independent axis.
 */
export function planCenteredMove(limits: AxisLimits, desiredDistance: number, marginMm: number, minDistance: number): CenteredMovePlanResult {
	const result = planCoupledCenteredMove([{ ...limits, perUnit: 1 }], desiredDistance, marginMm, minDistance);
	if ("error" in result) { return result; }
	return { distance: result.distance, sign: 1, startPosition: result.startPositions[0].position };
}

export interface CaptureProfile {
	/** mm, positive magnitude — MOTOR-space length of the H2 move. */
	distance: number;
	sign: 1 | -1;
	/** Machine positions (mm) to pre-position every affected axis to before the H2 move — empty when
	 * there's no axis to centre on (e.g. an extruder). */
	startPositions: Array<{ letter: string; position: number }>;
	/** Seconds the move itself takes at the given feed. */
	moveTimeS: number;
	/** Seconds of the capture window left over after the move — the at-rest tail I/D/ring metrics need. */
	restTimeS: number;
	/** Sample rate to actually use for the capture — the requested rate in explicit-distance mode, or
	 * one derived from the move's own duration in "auto" (longest) mode. */
	sampleRateHz: number;
	/** Which coupled axis's clear travel capped the distance, or null if nothing did. */
	limitedBy: string | null;
}

const CAPTURE_REST_FRACTION_DEFAULT = 0.3;   // reserve this fraction of the capture window for the at-rest tail
const CAPTURE_MIN_DISTANCE_FRACTION = 0.25;  // explicit mode: still require this fraction of the requested distance
const AUTO_MIN_DISTANCE_MM = 5;              // auto mode: a small absolute floor, not a fraction of the 200 mm cap

/**
 * Size a single trapezoid tuning move so its capture window has both a real accel/cruise/decel section
 * AND a meaningful at-rest tail afterward — one capture serving every P/D/I/A/V decision instead of a
 * separate "step" move and "A/V" move. Move is centred on every coupled axis's own midpoint
 * (`planCoupledCenteredMove`), not one-way from wherever the axes happen to be, so the full clear travel
 * is available on every axis the tuned motor actually displaces (see kinematics.ts) — not just the
 * nominal one.
 *
 * Two modes, selected by `opts.maxDistanceMm`:
 *  - **explicit** (a positive value): that's the target MOTOR-space distance (clamped to what's clear),
 *    and the capture window is `samples / sampleRateHz` as given — unchanged contract from before.
 *  - **auto** (0, undefined, or omitted): use the longest reasonable move (up to `AUTO_MOVE_CAP_MM`),
 *    and DERIVE the sample rate from its duration instead of the other way around — a longer cruise
 *    section measures V/A more reliably than a short one at a fixed rate. The derived rate is floored
 *    at `AUTO_RATE_FLOOR_HZ`; if even that floor can't stretch `samples` across the window, the move
 *    shrinks instead of losing resolution.
 */
export function planCaptureProfile(
	axes: Array<CoupledAxisLimits>,
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
	let startPositions: Array<{ letter: string; position: number }> = [];
	let limitedBy: string | null = null;
	if (axes.length > 0) {
		// Auto mode's target is a CAP ("as long as reasonable"), not a real request, so its floor is a
		// small absolute distance — scaling by 25% of a 200 mm cap would reject a perfectly usable 46 mm
		// move on a short axis. Explicit mode's target IS a real request, so 25% of it is the right floor.
		const minDistance = auto
			? (opts.minDistanceFloorMm ?? AUTO_MIN_DISTANCE_MM)
			: Math.max(opts.minDistanceFloorMm ?? 0.05, targetDistance * CAPTURE_MIN_DISTANCE_FRACTION);
		const plan = planCoupledCenteredMove(axes, targetDistance, marginMm, minDistance);
		if ("error" in plan) { return plan; }
		distance = plan.distance;
		startPositions = plan.startPositions;
		limitedBy = plan.limitedBy;
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
			if (axes.length > 0) {
				startPositions = axes.map((a) => ({ letter: a.letter, position: midpoint(a) - a.perUnit * distance / 2 }));
			}
		}
	} else {
		windowS = effectiveRate > 0 ? samples / effectiveRate : 4;
	}

	if (!(distance > 0)) { return { error: "Feed rate or capture window is too small to plan a tuning move." }; }
	return { distance, sign: 1, startPositions, moveTimeS, restTimeS: Math.max(0, windowS - moveTimeS), sampleRateHz: effectiveRate, limitedBy };
}
