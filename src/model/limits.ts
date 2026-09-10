/**
 * Travel-limit safety helpers for loaded-axis tuning.
 *
 * Tuning moves are sent with G1's H2 (individual motor) mode, which drives the motor directly and
 * bypasses RRF's kinematics — so M208 soft limits are never applied to them. With the axis now tuned
 * while still coupled to the machine, these helpers are the only thing standing between a tuning move
 * and the frame.
 */
import { COUPLING_EPSILON } from "./kinematics";

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
/**
 * General safety net on the OTHER end: a short move (travel-constrained axis, or a fast feed) can drive
 * `samples / windowS` arbitrarily high with no ceiling at all — a 5 mm move at 100 mm/s with the default
 * 2000 samples derives to ~25 kHz, which nothing has a documented capture path fast enough for. This
 * default is deliberately generous (comfortably above the UI's own 2000 Hz default) — it exists to catch
 * the pathological case, not to restrict ordinary use. `rateCeilingForBoard` below applies a much
 * tighter, per-board override where one is known to be needed.
 */
export const AUTO_RATE_CEILING_HZ = 5000;

/**
 * Minimum absolute at-rest time in an auto-planned capture window, on top of
 * CAPTURE_REST_FRACTION_DEFAULT's proportional share. A fraction alone gives a short move a short tail:
 * measured on a real forum report, a 0.344 s move left only 0.13 s of rest, in which the integrator had
 * not converged on 29 of 82 captures — so `restTailValid` came back false and those captures' rest-effort
 * term silently dropped out of every cost comparison (see `signalCostNoEffort` in signal.ts and
 * docs/PLAN-capture-window.md §3-§4).
 *
 * PROVISIONAL: this is ~4x the 0.13 s that demonstrably failed, not a measurement of how long a Duet
 * integrator actually takes to converge — no capture in hand has a long enough tail to measure that.
 * docs/PLAN-capture-window.md §4.1 has the one-off hardware capture that would replace this with a real
 * number; don't present it as measured until that's done.
 */
export const AUTO_REST_MIN_S = 0.5;

/**
 * Values/second a board can stream off its own driver over CAN without overrunning its onboard capture
 * buffer. The ceiling that matters for this is BANDWIDTH, not rate alone: a capture recording all 17
 * auto-tune variables at 4167 Hz is ~71k values/s, which intermittently truncated on a real Duet 3 1HCL
 * (10 of 82 captures in the same forum report AUTO_REST_MIN_S above is drawn from), while the same rate
 * with only 3 columns recorded is fine.
 *
 * PROVISIONAL: derived from that one data point (17 columns × 4167 Hz truncated), not bisected against
 * where truncation actually starts. docs/PLAN-capture-window.md §5.1 has the hardware sweep that would
 * replace this with a measured value.
 */
export const AUTO_VALUE_RATE_CEILING = 40000;

/**
 * Boards known to need a lower capture rate than most Duet 3 hardware, keyed by the object model's
 * `board.shortName` (stable identifier; `board.name` is a human-readable string not meant for matching).
 * 500 Hz / 500 samples confirmed stable (no longer crashes) on real MNBN17R1_5 hardware — started as a
 * conservative guess, since validated, not just guessed.
 */
const RP2350_RATE_CEILING_HZ = 500;
const RP2350_BOARD_SHORT_NAMES = new Set<string>(["MNBN17R1_5"]);

/** The safe capture-rate ceiling for a board, by its object model `shortName` — falls back to the
 * general `AUTO_RATE_CEILING_HZ` for anything not in the known-constrained list (or when the board
 * isn't known yet, e.g. `shortName` missing/null). */
export function rateCeilingForBoard(shortName: string | null | undefined): number {
	if (shortName && RP2350_BOARD_SHORT_NAMES.has(shortName)) { return RP2350_RATE_CEILING_HZ; }
	return AUTO_RATE_CEILING_HZ;
}

/**
 * Rate ceiling for a capture recording `columns` variables — the lower of the board's own rate ceiling
 * (`rateCeilingForBoard`) and what its CAN bandwidth allows for that many columns
 * (`AUTO_VALUE_RATE_CEILING`). Auto-tune records every available variable (17, at the time this was
 * written) so the chart has full overlay data afterward; a manual capture recording only a few columns
 * still gets the full board ceiling. Never goes below `AUTO_RATE_FLOOR_HZ` even for an unreasonably large
 * column count, since a capture below that floor loses resolution outright rather than trading it for
 * reliability. See docs/PLAN-capture-window.md §5.
 */
export function rateCeilingForCapture(shortName: string | null | undefined, columns: number): number {
	const byBoard = rateCeilingForBoard(shortName);
	const byBandwidth = columns > 0 ? AUTO_VALUE_RATE_CEILING / columns : byBoard;
	return Math.max(AUTO_RATE_FLOOR_HZ, Math.min(byBoard, byBandwidth));
}

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
	 * one derived from the move's own duration in "auto" (longest) mode. Never exceeds the ceiling
	 * passed in (`opts.rateCeilingHz`, default `AUTO_RATE_CEILING_HZ`). */
	sampleRateHz: number;
	/** Sample COUNT to actually request — equal to the `samples` argument, unless the rate ceiling
	 * forced it down (auto mode only: the move can't always be lengthened to compensate, since its
	 * distance may already be everything the axis's travel allows, so fewer samples over the same
	 * window is the only always-safe way to bring the rate down). Callers must use this, not their
	 * own `samples` value, when building the capture command. */
	samples: number;
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
export interface EnvelopeSpeedInput {
	letter: string;
	/** mm of this axis's Cartesian travel per 1 mm of the tuned motor's H2 travel (see kinematics.ts). */
	perUnit: number;
	/**
	 * This axis's own configured max speed, **mm/min** — the object model's `move.axes[].speed` reports
	 * M203 already in mm/min (RRF `Move.cpp`: `InverseConvertSpeedToMmPerMin(MaxFeedrate(...))`), the same
	 * unit a G1 F parameter takes. It is NOT mm/s; treating it as mm/s and converting was a real bug
	 * (v2.6.3 ran the envelope capture at 60x the intended feed — F5760000 instead of F96000 on a field
	 * machine with M203 Y48000 and 0.5 CoreXY coupling).
	 */
	speedMmPerMin: number;
}

/**
 * Motor-space feed (mm/min) at which the FIRST coupled axis to reach its own configured M203 does so —
 * the speed at which a G1 H2 tuning move's real-world Cartesian speed first touches any coupled axis's
 * configured ceiling. On a Cartesian machine there is exactly one coupled axis with perUnit=1, so this
 * reduces to that axis's own M203. On CoreXY (and other CoreKinematics) the tuned axis's own perUnit is
 * NOT 1.0 — a field capture showed 0.5/-0.5 on both coupled axes — so either one's configured max can be
 * the real limiting factor, not just the nominal tuned axis's own M203. Same "every coupled axis's own
 * limit, take the conservative one" reasoning `planCoupledCenteredMove` already applies to distance,
 * applied here to speed. null when no axis has a non-negligible coupling (nothing to check against).
 * See docs/PLAN-envelope-check.md.
 */
export function envelopeFeedMmPerMin(axes: Array<EnvelopeSpeedInput>): number | null {
	const candidates = axes
		.filter((a) => Math.abs(a.perUnit) > COUPLING_EPSILON && a.speedMmPerMin > 0)
		.map((a) => a.speedMmPerMin / Math.abs(a.perUnit));
	if (!candidates.length) { return null; }
	return Math.min(...candidates);
}

export function planCaptureProfile(
	axes: Array<CoupledAxisLimits>,
	feedMmPerMin: number,
	samples: number,
	sampleRateHz: number,
	marginMm: number,
	opts: { restFraction?: number; maxDistanceMm?: number; minDistanceFloorMm?: number; rateCeilingHz?: number } = {},
): CaptureProfile | { error: string } {
	const restFraction = opts.restFraction ?? CAPTURE_REST_FRACTION_DEFAULT;
	const rateCeilingHz = opts.rateCeilingHz ?? AUTO_RATE_CEILING_HZ;
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
	let effectiveSamples = samples;
	let windowS: number;

	if (auto) {
		// AUTO_REST_MIN_S is a floor on top of the fractional share, not instead of it — a fraction alone
		// gives a short move a short (possibly integrator-unconverged) tail; see its doc comment.
		windowS = Math.max(moveTimeS / (1 - restFraction), moveTimeS + AUTO_REST_MIN_S);
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
		} else if (effectiveRate > rateCeilingHz) {
			// The opposite problem: a short move (often because travel is what capped `distance` above,
			// not choice) needs the same `samples` squeezed into a short window, deriving an unreasonably
			// high rate. Unlike the floor case, the move can't always just be lengthened to compensate —
			// there may be no more travel to give it — so the always-safe fix is fewer samples over the
			// SAME window (distance/moveTimeS/startPositions untouched) instead.
			effectiveRate = rateCeilingHz;
			effectiveSamples = Math.max(1, Math.round(rateCeilingHz * windowS));
		}
	} else {
		// Explicit distance: the window is however long `samples` at `effectiveRate` takes, independent
		// of the move's own duration (the axis simply sits at rest for any window time past moveTimeS).
		// So clamping the rate down here just makes the capture run longer, never shorter than the move
		// — no travel implication, so `samples` itself never needs to change in this branch.
		effectiveRate = Math.min(effectiveRate, rateCeilingHz);
		windowS = effectiveRate > 0 ? samples / effectiveRate : 4;
	}

	if (!(distance > 0)) { return { error: "Feed rate or capture window is too small to plan a tuning move." }; }
	return { distance, sign: 1, startPositions, moveTimeS, restTimeS: Math.max(0, windowS - moveTimeS), sampleRateHz: effectiveRate, samples: effectiveSamples, limitedBy };
}
