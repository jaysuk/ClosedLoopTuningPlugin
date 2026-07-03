/**
 * Machine-scale-aware capture parameters — pure, unit-tested, so a "step jump" test move means the same
 * physical thing (a handful of whole motor steps, over roughly the same amount of time) on a coarse-pitch
 * leadscrew axis and a fine-pitch belt axis alike, instead of a fixed distance/feedrate tuned against
 * whatever machine the plugin happened to be developed on.
 */

export interface AxisScaleInfo {
	/** Steps-per-mm INCLUDING microstepping (RRF `M92` value — the object model's `axis.stepsPerMm`). */
	stepsPerMm?: number;
	/** Microstepping factor (RRF `M350` value — the object model's `axis.microstepping.value`). */
	microstepping?: number;
}

// Fallbacks for when the object model hasn't reported a value yet — a common, unremarkable 20-tooth
// GT2/80-steps-per-mm-equivalent belt axis at 16x, so a missing reading degrades to a reasonable jump
// rather than an error.
const DEFAULT_STEPS_PER_MM = 80;
const DEFAULT_MICROSTEPPING = 16;

function resolve(value: number | undefined, fallback: number): number {
	return value != null && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** mm covered by one full (whole) motor step, given the axis's configured resolution. */
export function mmPerFullStep(scale: AxisScaleInfo): number {
	const stepsPerMm = resolve(scale.stepsPerMm, DEFAULT_STEPS_PER_MM);
	const microstepping = resolve(scale.microstepping, DEFAULT_MICROSTEPPING);
	return microstepping / stepsPerMm;
}

const DEFAULT_STEP_JUMP_FULL_STEPS = 16;
const MIN_STEP_JUMP_MM = 0.1;

/** Distance (mm) covered by `fullSteps` whole motor steps — the size of a genuine "step jump" test move. */
export function stepJumpDistanceMm(scale: AxisScaleInfo, fullSteps = DEFAULT_STEP_JUMP_FULL_STEPS): number {
	return Math.max(MIN_STEP_JUMP_MM, mmPerFullStep(scale) * fullSteps);
}

const STEP_JUMP_TIME_S = 0.05;    // aim for the jump itself to take about this long, at any machine scale
const STEP_JUMP_FEED_MIN = 600;   // mm/min floor — a tiny jump still gets a sane, resolvable feedrate
const STEP_JUMP_FEED_MAX = 30000; // mm/min ceiling — stay within what a typical machine can actually reach

/**
 * Feedrate (mm/min) for a step-jump test move, scaled so the move itself takes roughly the same amount
 * of time regardless of the axis's resolution — replacing a fixed feedrate that made a coarse-pitch
 * axis's "step" move too fast to resolve in the capture window, and a fine-pitch axis's too slow to
 * look anything like a step.
 */
export function stepJumpFeedMmPerMin(distanceMm: number): number {
	const feed = (distanceMm / STEP_JUMP_TIME_S) * 60;
	return Math.min(STEP_JUMP_FEED_MAX, Math.max(STEP_JUMP_FEED_MIN, feed));
}
