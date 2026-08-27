/**
 * Step-response analysis for a closed-loop capture — the "automatic plot analysis" that turns a graph
 * the user would otherwise eyeball into numbers (rise time, overshoot, steady-state error, …). Pure
 * and unit-tested. Works on the Measured vs Target motor-step columns plus a time axis in seconds.
 */
import { column, timeAxisSeconds, type ParsedCapture } from "./csv";

export interface CaptureSeries {
	time: Array<number>;        // seconds
	measured: Array<number>;    // motor steps
	target: Array<number>;      // motor steps
}

/** Build aligned measured/target/time series from a parsed capture. Returns null if columns missing. */
export function buildSeries(capture: ParsedCapture, sampleRateHz: number): CaptureSeries | null {
	const measured = column(capture, "Measured Motor Steps");
	const target = column(capture, "Target Motor Steps");
	if (!measured || !target || measured.length < 3) {
		return null;
	}
	const n = Math.min(measured.length, target.length);
	return {
		time: timeAxisSeconds(capture, sampleRateHz).slice(0, n),
		measured: measured.slice(0, n),
		target: target.slice(0, n),
	};
}

// ---- Shared move segmentation ----
// One segmenter for every consumer (step analysis, move analysis, evaluation, tuning signal), so the
// tuner and the evaluator can never disagree about what counts as "cruise" or "at rest".

export type SegmentClass = "rest" | "cruise" | "accel" | "transition";

export interface MoveSegmentation {
	/** Any commanded motion was detected in the target. */
	moved: boolean;
	/** Index of the last sample still moving (0 when !moved); everything after is "rest". */
	lastMoving: number;
	/** Per-sample classification (same length as target). */
	classes: Array<SegmentClass>;
}

const CRUISE_VEL_FRACTION = 0.6;   // |v| ≥ this × maxV (and low accel) → steady speed
const CRUISE_ACC_FRACTION = 0.2;
const ACCEL_ACC_FRACTION = 0.3;    // |a| ≥ this × maxA (while moving) → accel/decel
const ACCEL_VEL_FRACTION = 0.1;
const MOVING_VEL_FRACTION = 0.08;  // |v| ≥ this × maxV → still part of the move

/** Classify each sample of a commanded target profile as rest / cruise / accel / transition. */
export function segmentMove(target: Array<number>, time: Array<number>, sampleRateHz: number): MoveSegmentation {
	const n = Math.min(target.length, time.length);
	const dtOf = (i: number) => (time[i] - time[i - 1]) || (sampleRateHz > 0 ? 1 / sampleRateHz : 1);
	const vel: Array<number> = [0];
	for (let i = 1; i < n; i++) { vel.push((target[i] - target[i - 1]) / dtOf(i)); }
	const absVel = vel.map(Math.abs);
	const maxV = absVel.reduce((a, b) => Math.max(a, b), 0);
	if (maxV <= 1e-6) {
		return { moved: false, lastMoving: 0, classes: new Array<SegmentClass>(n).fill("rest") };
	}
	const acc: Array<number> = [0];
	for (let i = 1; i < n; i++) { acc.push((vel[i] - vel[i - 1]) / dtOf(i)); }
	const maxA = acc.reduce((a, b) => Math.max(a, Math.abs(b)), 1e-9);
	let lastMoving = 0;
	for (let i = 0; i < n; i++) { if (absVel[i] >= MOVING_VEL_FRACTION * maxV) { lastMoving = i; } }
	const classes: Array<SegmentClass> = new Array(n);
	for (let i = 0; i < n; i++) {
		const v = absVel[i];
		const a = Math.abs(acc[i]);
		if (i > lastMoving) { classes[i] = "rest"; }
		else if (v >= CRUISE_VEL_FRACTION * maxV && a < CRUISE_ACC_FRACTION * maxA) { classes[i] = "cruise"; }
		else if (a >= ACCEL_ACC_FRACTION * maxA && v > ACCEL_VEL_FRACTION * maxV) { classes[i] = "accel"; }
		else { classes[i] = "transition"; }
	}
	return { moved: true, lastMoving, classes };
}

export interface StepMetrics {
	/** Commanded step size in motor steps (final − initial target). */
	stepSize: number;
	/** Time (s) for the response to go 10%→90% of the step. null if not a clear step. */
	riseTime: number | null;
	/** Peak overshoot beyond the final target, as a percentage of the step size. */
	overshootPct: number;
	/** Time (s) after the step for the error to stay within the settle band. null if never settles. */
	settlingTime: number | null;
	/** Mean signed error over the final settled portion (motor steps). */
	steadyStateError: number;
	/** Largest absolute error over the whole capture (motor steps). */
	peakError: number;
	/** RMS of the error over the whole capture (motor steps). */
	rmsError: number;
	/** Rough oscillation count after the step (sign changes of the post-step error). */
	oscillations: number;
	/** Whether a clear commanded step was detected at all. */
	hasStep: boolean;
	/**
	 * Fraction [0,1] of samples whose PID P term is railed (saturated). 0 when the capture didn't
	 * record the P term. High duty means the loop is saturating — an instability signal independent
	 * of the rise/overshoot metrics, which a saturated response can silently distort.
	 */
	pTermSatDuty: number;
	/** Standstill control-effort ripple (see computeRestEffort below) — attached post-hoc in
	 *  analyzeCapture the same way pTermSatDuty is, since analyzeStep only has the series, not the
	 *  raw capture columns it needs. Defaults to the all-zero/invalid EMPTY_REST_EFFORT shape. */
	restEffort: RestEffort;
}

const SETTLE_BAND_FRACTION = 0.05;   // ±5% of the step
const SETTLE_BAND_FLOOR = 0.05;      // …but at least this many steps (encoder resolution floor)

/** Index where the target first moves meaningfully from its initial value. */
function stepStartIndex(target: Array<number>): number {
	const initial = target[0];
	const finalV = target[target.length - 1];
	const span = Math.abs(finalV - initial);
	if (span < 1e-6) {
		return -1;
	}
	const threshold = initial + (finalV - initial) * 0.01;
	for (let i = 1; i < target.length; i++) {
		if ((finalV > initial && target[i] >= threshold) || (finalV < initial && target[i] <= threshold)) {
			return i;
		}
	}
	return -1;
}

export function analyzeStep(series: CaptureSeries): StepMetrics {
	const { time, measured, target } = series;
	const n = measured.length;
	const error = measured.map((m, i) => m - target[i]);

	// Whole-capture error stats (meaningful for any move, not just a step).
	let peakError = 0;
	let sumSq = 0;
	for (const e of error) {
		const ae = Math.abs(e);
		if (ae > peakError) { peakError = ae; }
		sumSq += e * e;
	}
	const rmsError = Math.sqrt(sumSq / Math.max(1, n));

	const startIdx = stepStartIndex(target);
	const baseline = measured[Math.max(0, startIdx >= 0 ? startIdx - 1 : 0)];
	const finalTarget = target[n - 1];
	const stepSize = finalTarget - target[0];
	const absStep = Math.abs(stepSize);

	// Steady-state: mean signed error over the final 20% of samples.
	const tailStart = Math.floor(n * 0.8);
	let tailSum = 0;
	let tailCount = 0;
	for (let i = tailStart; i < n; i++) { tailSum += error[i]; tailCount++; }
	const steadyStateError = tailCount ? tailSum / tailCount : 0;

	if (startIdx < 0 || absStep < 1e-6) {
		return { stepSize, riseTime: null, overshootPct: 0, settlingTime: null, steadyStateError, peakError, rmsError, oscillations: 0, hasStep: false, pTermSatDuty: 0, restEffort: EMPTY_REST_EFFORT };
	}

	const dir = Math.sign(stepSize);
	const rel = (v: number): number => (v - baseline) * dir;        // progress toward target, +ve
	const relTarget = (finalTarget - baseline) * dir;

	// Rise time: 10% → 90% of the step.
	let t10: number | null = null;
	let t90: number | null = null;
	for (let i = startIdx; i < n; i++) {
		const r = rel(measured[i]);
		if (t10 === null && r >= 0.1 * relTarget) { t10 = time[i]; }
		if (t90 === null && r >= 0.9 * relTarget) { t90 = time[i]; break; }
	}
	const riseTime = t10 !== null && t90 !== null ? Math.max(0, t90 - t10) : null;

	// Overshoot beyond the final target.
	let maxRel = 0;
	for (let i = startIdx; i < n; i++) { maxRel = Math.max(maxRel, rel(measured[i])); }
	const overshootPct = relTarget > 0 ? Math.max(0, (maxRel - relTarget) / relTarget) * 100 : 0;

	// Settling time: last time |error| leaves the settle band, measured from the step start.
	const band = Math.max(absStep * SETTLE_BAND_FRACTION, SETTLE_BAND_FLOOR);
	let lastOutside = -1;
	for (let i = startIdx; i < n; i++) {
		if (Math.abs(error[i]) > band) { lastOutside = i; }
	}
	const settlingTime = lastOutside >= 0 && lastOutside < n - 1 ? Math.max(0, time[lastOutside] - time[startIdx]) : (lastOutside < 0 ? 0 : null);

	// Oscillation count: zero-crossings of the error, but only counting a crossing when the half-cycle
	// before it had a real amplitude. Encoder noise jitters ±a fraction of a step around zero, which
	// would otherwise register as hundreds of "oscillations" and wrongly flag a stable gain as ringing.
	const oscThreshold = Math.max(0.5, absStep * 0.05);
	let oscillations = 0;
	let prevSign = 0;
	let halfCyclePeak = 0;
	for (let i = startIdx; i < n; i++) {
		const e = error[i];
		halfCyclePeak = Math.max(halfCyclePeak, Math.abs(e));
		const s = Math.sign(e);
		if (s !== 0 && prevSign !== 0 && s !== prevSign) {
			if (halfCyclePeak >= oscThreshold) { oscillations++; }
			halfCyclePeak = 0;
		}
		if (s !== 0) { prevSign = s; }
	}

	return { stepSize, riseTime, overshootPct, settlingTime, steadyStateError, peakError, rmsError, oscillations, hasStep: true, pTermSatDuty: 0, restEffort: EMPTY_REST_EFFORT };
}

/** |PID P term| at or above this is actuator saturation — the firmware clamps the term around ±256. */
export const P_TERM_RAIL = 250;

/** Fraction of finite samples with a railed (saturated) PID P term. */
export function satDuty(pterm: Array<number>): number {
	let sat = 0;
	let finite = 0;
	for (const p of pterm) {
		if (!Number.isFinite(p)) { continue; }
		finite++;
		if (Math.abs(p) >= P_TERM_RAIL) { sat++; }
	}
	return finite ? sat / finite : 0;
}

/** Analyse a parsed capture in one call; null if it has no usable measured/target columns. */
export function analyzeCapture(capture: ParsedCapture, sampleRateHz: number): StepMetrics | null {
	const series = buildSeries(capture, sampleRateHz);
	if (!series) { return null; }
	const metrics = analyzeStep(series);
	// Saturation duty from the PID P term when the capture recorded it (the step recipe does).
	const pterm = column(capture, "PID P Term");
	if (pterm) { metrics.pTermSatDuty = satDuty(pterm); }
	metrics.restEffort = computeRestEffort(capture, sampleRateHz);
	return metrics;
}

// ---- Feed-forward (A / V) analysis from a G1 MOVE capture ----
// A and V only act during motion, so they're judged on the PID P term during a real move: the A term
// should flatten the P-term peaks in the accelerate/decelerate segments, and V should bring the mean
// P-term in the steady-speed segment toward zero. Segments are derived from the target-step velocity.

export interface MoveMetrics {
	/** A clear move with a steady-speed (cruise) section was detected. */
	hasMove: boolean;
	/** Peak |PID P term| during the accelerate/decelerate segments (A reduces this). */
	pTermAccelPeak: number;
	/** Mean PID P term during the steady-speed segment (V brings this toward zero). */
	pTermCruiseMean: number;
	/** Number of samples classed as steady-speed (confidence). */
	cruiseSamples: number;
	/**
	 * Fraction [0,1] of samples whose PID P term is railed (saturated). A stable move only rails briefly
	 * during accel; a loop pushed into a limit cycle by too much feed-forward rails almost continuously,
	 * so this is the primary "the FF push destabilised it" signal.
	 */
	pTermSatDuty: number;
	/** Amplitude-gated oscillation cycles of the P term after the commanded move stops (hunting at rest). */
	postMoveOsc: number;
}

/**
 * Amplitude-gated sign-change count of a signal over [start, end) — a half-cycle only counts once it has
 * swung past `threshold`, so encoder/PID jitter around zero isn't mistaken for a real oscillation.
 */
export function countGatedOscillations(values: Array<number>, start: number, end: number, threshold: number): number {
	let count = 0;
	let prevSign = 0;
	let halfPeak = 0;
	for (let i = Math.max(0, start); i < end; i++) {
		const v = values[i];
		if (!Number.isFinite(v)) { continue; }
		halfPeak = Math.max(halfPeak, Math.abs(v));
		const s = Math.sign(v);
		if (s !== 0 && prevSign !== 0 && s !== prevSign) {
			if (halfPeak >= threshold) { count++; }
			halfPeak = 0;
		}
		if (s !== 0) { prevSign = s; }
	}
	return count;
}

export function analyzeMove(capture: ParsedCapture, sampleRateHz: number): MoveMetrics | null {
	const target = column(capture, "Target Motor Steps");
	const pterm = column(capture, "PID P Term");
	if (!target || !pterm || target.length < 8) {
		return null;
	}
	const time = timeAxisSeconds(capture, sampleRateHz);
	const n = Math.min(target.length, pterm.length, time.length);

	// Saturation duty over the whole capture — the primary instability signal, and independent of
	// segmentation so it's meaningful even when no clear move is found (a standstill limit cycle).
	const pTermSatDuty = satDuty(pterm.slice(0, n));

	const seg = segmentMove(target.slice(0, n), time, sampleRateHz);
	if (!seg.moved) {
		// No commanded motion — but still report saturation/hunting so an at-rest limit cycle is visible.
		return { hasMove: false, pTermAccelPeak: 0, pTermCruiseMean: 0, cruiseSamples: 0, pTermSatDuty, postMoveOsc: countGatedOscillations(pterm, 0, n, P_TERM_RAIL * 0.5) };
	}
	let accelPeak = 0;
	let cruiseSum = 0;
	let cruiseCount = 0;
	for (let i = 1; i < n; i++) {
		const p = pterm[i];
		if (!Number.isFinite(p)) { continue; }
		if (seg.classes[i] === "cruise") { cruiseSum += p; cruiseCount++; }
		else if (seg.classes[i] === "accel") { accelPeak = Math.max(accelPeak, Math.abs(p)); }
	}
	// Hunting after the move stops: the ±rail limit cycle in the stationary tail, which the accel/cruise
	// segments above never look at (they're keyed off the commanded velocity, which is zero here).
	const postMoveOsc = countGatedOscillations(pterm, seg.lastMoving + 1, n, P_TERM_RAIL * 0.5);
	return { hasMove: cruiseCount >= 3, pTermAccelPeak: accelPeak, pTermCruiseMean: cruiseCount ? cruiseSum / cruiseCount : 0, cruiseSamples: cruiseCount, pTermSatDuty, postMoveOsc };
}

// ---- Standstill control-effort ripple ----
// Distinct from postMoveOsc above: that counts RAILED hunting (gated at half the effort rail, P_TERM_
// RAIL * 0.5 = 125), which catches gross limit cycles but is blind to a much smaller, still mechanically
// noticeable standstill dither — a fraction of a single encoder count can swing the P term by tens of
// units when P is large, without ever railing or moving the mean position error enough to trip restBias
// or restRing (evaluate.ts). Field case + calibration data: docs/PLAN-standstill-effort.md.

/** Fraction of the rest window (measured from the end) judged as "settled" — long enough after a move
 *  stops for a genuine settling transient to have died out before ripple is judged as persistent. */
export const REST_TAIL_FRACTION = 0.10;
/** Below this many samples in the tail, ripple can't be measured meaningfully — skip the gate. */
export const REST_TAIL_MIN_SAMPLES = 25;
/** The integrator is "converged" once every tail sample stays within this fraction of its own final
 *  value — the guard that stops a still-settling transient from reading as persistent dither (a
 *  transient can swing the P term just as hard as a real limit cycle while I is still climbing). */
export const I_SETTLED_TOL_FRACTION = 0.01;

export interface RestEffort {
	/** Peak-to-peak PID P term over the settled tail of the rest window — the primary dither signal. */
	pTermRestRipple: number;
	/** RMS about the mean over the same window (outlier-resistant companion to p2p). */
	pTermRestRms: number;
	/** Peak-to-peak PID D term over the same window. 0 when the capture didn't record it. Reported for
	 *  the tuning report only — no field data yet to calibrate a D threshold against. */
	dTermRestRipple: number;
	/** Peak-to-peak PID Control Signal (total output) over the same window. 0 when not recorded. */
	outputRestRipple: number;
	/** Samples actually measured in the tail window. */
	restTailSamples: number;
	/**
	 * The ripple numbers above are trustworthy. False when the tail was too short, or the integrator
	 * had not converged by the start of the tail (still mid settling-transient, not yet dithering).
	 * MUST only ever skip a decision that depends on it — never a rejection, never a cost penalty.
	 */
	restTailValid: boolean;
}

/** The all-zero/"not measured" shape — always `restTailValid: false`, so it can never accidentally
 *  gate a decision. Exported for test fixtures that build a StepMetrics/TuneSignal by hand. */
export const EMPTY_REST_EFFORT: RestEffort = {
	pTermRestRipple: 0, pTermRestRms: 0, dTermRestRipple: 0, outputRestRipple: 0,
	restTailSamples: 0, restTailValid: false,
};

function peakToPeak(a: Array<number>): number {
	if (a.length === 0) { return 0; }
	let min = Infinity;
	let max = -Infinity;
	for (const v of a) {
		if (v < min) { min = v; }
		if (v > max) { max = v; }
	}
	return max - min;
}

function rmsAboutMean(a: Array<number>): number {
	if (a.length === 0) { return 0; }
	const mean = a.reduce((s, v) => s + v, 0) / a.length;
	return Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / a.length);
}

/**
 * Measure control-effort dither over the SETTLED tail of a capture's rest window. Complements the
 * position-error stats (restBias/restRing in evaluate.ts), which a limit cycle small enough can clear
 * without ever tripping — see the module comment above.
 */
export function computeRestEffort(capture: ParsedCapture, sampleRateHz: number): RestEffort {
	const target = column(capture, "Target Motor Steps");
	const pterm = column(capture, "PID P Term");
	if (!target || !pterm) { return EMPTY_REST_EFFORT; }
	const time = timeAxisSeconds(capture, sampleRateHz);
	const n = Math.min(target.length, pterm.length, time.length);
	if (n < 2) { return EMPTY_REST_EFFORT; }

	const seg = segmentMove(target.slice(0, n), time, sampleRateHz);
	const restStart = seg.moved ? seg.lastMoving + 1 : 0;
	const restLen = n - restStart;
	if (restLen <= 0) { return EMPTY_REST_EFFORT; }

	const tailLen = Math.min(restLen, Math.max(REST_TAIL_MIN_SAMPLES, Math.floor(restLen * REST_TAIL_FRACTION)));
	const tailStart = n - tailLen;
	const tailOf = (a: Array<number>) => a.slice(tailStart, n).filter(Number.isFinite);

	const pTail = tailOf(pterm);
	const dcol = column(capture, "PID D Term");
	const outcol = column(capture, "PID Control Signal");
	const dTail = dcol ? tailOf(dcol) : [];
	const outTail = outcol ? tailOf(outcol) : [];

	// Converged unless the I column is present, has samples in the tail, AND those samples visibly
	// vary — a genuinely constant I (including I=0, no integrator to converge) needs no wait at all.
	const icol = column(capture, "PID I Term");
	let iConverged = true;
	if (icol) {
		const iTail = icol.slice(tailStart, n).filter(Number.isFinite);
		if (iTail.length > 0) {
			const iFinal = iTail[iTail.length - 1];
			const tol = Math.max(1e-6, I_SETTLED_TOL_FRACTION * Math.abs(iFinal));
			iConverged = iTail.every((v) => Math.abs(v - iFinal) <= tol);
		}
	}

	return {
		pTermRestRipple: peakToPeak(pTail),
		pTermRestRms: rmsAboutMean(pTail),
		dTermRestRipple: peakToPeak(dTail),
		outputRestRipple: peakToPeak(outTail),
		restTailSamples: pTail.length,
		restTailValid: pTail.length >= REST_TAIL_MIN_SAMPLES && iConverged,
	};
}
