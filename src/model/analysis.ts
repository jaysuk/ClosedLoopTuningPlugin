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
		return { stepSize, riseTime: null, overshootPct: 0, settlingTime: null, steadyStateError, peakError, rmsError, oscillations: 0, hasStep: false };
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

	return { stepSize, riseTime, overshootPct, settlingTime, steadyStateError, peakError, rmsError, oscillations, hasStep: true };
}

/** Analyse a parsed capture in one call; null if it has no usable measured/target columns. */
export function analyzeCapture(capture: ParsedCapture, sampleRateHz: number): StepMetrics | null {
	const series = buildSeries(capture, sampleRateHz);
	return series ? analyzeStep(series) : null;
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
}

export function analyzeMove(capture: ParsedCapture, sampleRateHz: number): MoveMetrics | null {
	const target = column(capture, "Target Motor Steps");
	const pterm = column(capture, "PID P Term");
	if (!target || !pterm || target.length < 8) {
		return null;
	}
	const time = timeAxisSeconds(capture, sampleRateHz);
	const n = Math.min(target.length, pterm.length, time.length);
	const dtOf = (i: number) => (time[i] - time[i - 1]) || (sampleRateHz > 0 ? 1 / sampleRateHz : 1);

	// Velocity (steps/s) of the commanded target, and its acceleration.
	const vel: Array<number> = [];
	for (let i = 1; i < n; i++) { vel.push((target[i] - target[i - 1]) / dtOf(i)); }
	const absVel = vel.map((v) => Math.abs(v));
	const maxV = absVel.reduce((a, b) => Math.max(a, b), 0);
	if (maxV <= 1e-6) {
		return { hasMove: false, pTermAccelPeak: 0, pTermCruiseMean: 0, cruiseSamples: 0 };
	}
	const acc: Array<number> = [];
	for (let i = 1; i < vel.length; i++) { acc.push((vel[i] - vel[i - 1]) / dtOf(i + 1)); }
	const maxA = acc.reduce((a, b) => Math.max(a, Math.abs(b)), 1e-9);

	let accelPeak = 0;
	let cruiseSum = 0;
	let cruiseCount = 0;
	for (let i = 1; i < n; i++) {
		const v = absVel[i - 1];
		const a = i - 1 < acc.length ? Math.abs(acc[i - 1]) : 0;
		const p = pterm[i];
		if (!Number.isFinite(p)) { continue; }
		if (v >= 0.7 * maxV && a < 0.2 * maxA) {
			cruiseSum += p; cruiseCount++;                 // steady speed
		} else if (a >= 0.3 * maxA && v > 0.1 * maxV) {
			accelPeak = Math.max(accelPeak, Math.abs(p));  // accel / decel
		}
	}
	return { hasMove: cruiseCount >= 3, pTermAccelPeak: accelPeak, pTermCruiseMean: cruiseCount ? cruiseSum / cruiseCount : 0, cruiseSamples: cruiseCount };
}
