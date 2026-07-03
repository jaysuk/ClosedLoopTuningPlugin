/**
 * Unified tuning signal — the ONE metric set every axis-tuning decision consumes.
 *
 * The old tuner judged trapezoid G1 moves with step-response metrics (rise time, overshoot as a % of
 * the whole move), which are dominated by the commanded motion profile rather than the loop gains —
 * under load it kept "improving" rise time until the loop went violently unstable. TuneSignal instead
 * combines the error-domain region statistics from evaluate.ts (rest/cruise/accel, in motor steps)
 * with the PID-P-term effort metrics from analysis.ts, plus two new whole-capture measures:
 *
 *  - oscPeriod: the dominant oscillation period of the post-move error, for ultimate-gain (Ku/Tu)
 *    identification (Ziegler–Nichols / Tyreus–Luyben seeding);
 *  - itae: time-weighted absolute error — a single scalar objective to compare whole captures.
 *
 * Pure and unit-tested against real captures (see src/__tests__/fixtures).
 */
import { analyzeMove, buildSeries, segmentMove } from "./analysis";
import type { ParsedCapture } from "./csv";
import { tuneStats, type TuneStats } from "./evaluate";

export interface TuneSignal {
	/** Error statistics per move region (motor steps) — see evaluate.ts. */
	stats: TuneStats;
	/** Peak |PID P term| during accel/decel (A reduces this). 0 when the P term wasn't recorded. */
	pTermAccelPeak: number;
	/** Mean PID P term at steady speed (V brings this toward zero). */
	pTermCruiseMean: number;
	/** Fraction [0,1] of samples with a railed (saturated) P term — primary instability signal. */
	pTermSatDuty: number;
	/** Railed P-term oscillation cycles after the move stops (hunting at rest). */
	postMoveOsc: number;
	/** Dominant oscillation period (s) of the post-move error; null when there's no clear oscillation. */
	oscPeriod: number | null;
	/** Integral of time-weighted |error| — scalar objective for comparing captures of the same move. */
	itae: number;
	/** A commanded move with a steady-speed section was detected. */
	hasMove: boolean;
}

// Stability limits (exported for tests + transparency).
export const SAT_DUTY_LIMIT = 0.12;   // >12% of the capture railed → the loop is saturating
export const HUNT_OSC_LIMIT = 6;      // railed P-term swings after the move → limit cycle / hunting
export const RING_HARD = 8;           // error oscillation cycles at rest that mean ringing, not noise
export const RUNAWAY_STEPS = 48;      // |error| beyond this many motor steps is a runaway, full stop
export const DIVERGE_FACTOR = 2;      // moveRms worse than this × the best seen → diverging
export const DIVERGE_FLOOR = 0.5;     // …but only above this absolute rms (don't trip on noise)

/** Minimum amplitude-gated crossings needed before an oscillation period is trusted. */
const OSC_PERIOD_MIN_CROSSINGS = 4;

/**
 * Dominant oscillation period of `values[start..end)` from amplitude-gated zero crossings.
 * Returns null unless there are enough real (above-threshold) crossings to trust the estimate.
 */
export function oscillationPeriod(values: Array<number>, time: Array<number>, start: number, end: number, threshold: number): number | null {
	const crossings: Array<number> = [];
	let prevSign = 0;
	let halfPeak = 0;
	for (let i = Math.max(0, start); i < end; i++) {
		const v = values[i];
		if (!Number.isFinite(v)) { continue; }
		halfPeak = Math.max(halfPeak, Math.abs(v));
		const s = Math.sign(v);
		if (s !== 0 && prevSign !== 0 && s !== prevSign) {
			if (halfPeak >= threshold) { crossings.push(time[i]); }
			halfPeak = 0;
		}
		if (s !== 0) { prevSign = s; }
	}
	if (crossings.length < OSC_PERIOD_MIN_CROSSINGS) { return null; }
	// Each gated crossing is half a cycle; the mean gap × 2 is the period.
	const span = crossings[crossings.length - 1] - crossings[0];
	const halfCycles = crossings.length - 1;
	return span > 0 ? (2 * span) / halfCycles : null;
}

/** Compute the unified tuning signal from a capture. Null if measured/target columns are missing. */
export function computeTuneSignal(capture: ParsedCapture, sampleRateHz: number): TuneSignal | null {
	const series = buildSeries(capture, sampleRateHz);
	if (!series) { return null; }
	const { time, measured, target } = series;
	const n = measured.length;
	const error = measured.map((m, i) => m - target[i]);

	const stats = tuneStats(capture, sampleRateHz);
	// P-term effort metrics; zeros when the capture didn't record the PID P term.
	const move = analyzeMove(capture, sampleRateHz);

	// ITAE over the whole capture (time from the capture start). Only comparable between captures of
	// the same commanded move — which is exactly how the tuner uses it.
	let itae = 0;
	for (let i = 1; i < n; i++) {
		const dt = time[i] - time[i - 1];
		if (dt > 0 && Number.isFinite(error[i])) { itae += Math.abs(error[i]) * (time[i] - time[0]) * dt; }
	}

	// Oscillation period of the error after the move stops (whole capture when nothing moved) —
	// the measurement a Ku/Tu ultimate-gain search needs.
	const seg = segmentMove(target, time, sampleRateHz);
	const oscStart = seg.moved ? seg.lastMoving + 1 : 0;
	const oscThreshold = Math.max(0.3, 3 * stats.restNoise);
	const oscPeriod = oscillationPeriod(error, time, oscStart, n, oscThreshold);

	return {
		stats,
		pTermAccelPeak: move?.pTermAccelPeak ?? 0,
		pTermCruiseMean: move?.pTermCruiseMean ?? 0,
		pTermSatDuty: move?.pTermSatDuty ?? 0,
		postMoveOsc: move?.postMoveOsc ?? 0,
		oscPeriod,
		itae,
		hasMove: stats.moved && stats.cruiseSamples >= 3,
	};
}

/**
 * Hard instability veto shared by every tuning stage: the loop is saturating, hunting at rest,
 * ringing hard, or the error has run away. No gain that produces this may ever be accepted.
 */
export function signalUnstable(s: TuneSignal): boolean {
	return s.pTermSatDuty >= SAT_DUTY_LIMIT
		|| s.postMoveOsc >= HUNT_OSC_LIMIT
		|| s.stats.restRing >= RING_HARD
		|| s.stats.movePeak >= RUNAWAY_STEPS;
}

/** Tracking error grew far beyond the best attempt so far — the ramp is making things worse. */
export function signalDiverging(best: TuneSignal, current: TuneSignal): boolean {
	return current.stats.moveRms > Math.max(DIVERGE_FLOOR, DIVERGE_FACTOR * best.stats.moveRms);
}

function median(values: Array<number>): number {
	const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
	if (!sorted.length) { return 0; }
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Field-wise median of several signals from repeat captures — rejects one-off noise/glitches. */
export function medianSignal(signals: Array<TuneSignal>): TuneSignal {
	if (signals.length === 1) { return signals[0]; }
	const stat = (f: (s: TuneStats) => number) => median(signals.map((s) => f(s.stats)));
	const periods = signals.map((s) => s.oscPeriod).filter((p): p is number => p !== null);
	return {
		stats: {
			restBias: stat((s) => s.restBias),
			restNoise: stat((s) => s.restNoise),
			restRing: stat((s) => s.restRing),
			settleOvershoot: stat((s) => s.settleOvershoot),
			cruiseLag: stat((s) => s.cruiseLag),
			accelPeak: stat((s) => s.accelPeak),
			movePeak: stat((s) => s.movePeak),
			moveRms: stat((s) => s.moveRms),
			cruiseSamples: stat((s) => s.cruiseSamples),
			restSamples: stat((s) => s.restSamples),
			moved: signals.filter((s) => s.stats.moved).length * 2 > signals.length,
		},
		pTermAccelPeak: median(signals.map((s) => s.pTermAccelPeak)),
		pTermCruiseMean: median(signals.map((s) => s.pTermCruiseMean)),
		pTermSatDuty: median(signals.map((s) => s.pTermSatDuty)),
		postMoveOsc: median(signals.map((s) => s.postMoveOsc)),
		oscPeriod: periods.length * 2 > signals.length ? median(periods) : null,
		itae: median(signals.map((s) => s.itae)),
		hasMove: signals.filter((s) => s.hasMove).length * 2 > signals.length,
	};
}

/** One-line summary for the auto-tune log. */
export function describeSignal(s: TuneSignal): string {
	const parts = [
		`rms ${s.stats.moveRms.toFixed(2)}`,
		`bias ${s.stats.restBias.toFixed(2)}`,
		`overshoot ${s.stats.settleOvershoot.toFixed(2)}`,
		`lag ${s.stats.cruiseLag.toFixed(2)}`,
		`accel pk ${s.pTermAccelPeak.toFixed(0)}`,
	];
	if (s.pTermSatDuty > 0.01) { parts.push(`sat ${(s.pTermSatDuty * 100).toFixed(0)}%`); }
	if (s.postMoveOsc > 0) { parts.push(`${s.postMoveOsc} hunt`); }
	if (s.stats.restRing > 0) { parts.push(`${s.stats.restRing} ring`); }
	return parts.join(", ");
}
