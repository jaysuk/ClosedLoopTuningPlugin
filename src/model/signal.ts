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
import { analyzeMove, buildSeries, computeRestEffort, P_TERM_RAIL, segmentMove, type RestEffort } from "./analysis";
import type { ParsedCapture } from "./csv";
import { autocorrelationPeriod } from "./dsp";
import { tuneStats, type TuneStats } from "./evaluate";
import type { Vibration } from "./vibration";

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
	/** Peak |error| amplitude over the same window as `oscPeriod` — the "a" a relay-feedback (Åström–
	 * Hägglund) Ku estimate needs (Ku = 4d/(πa), d = the known relay/saturation half-amplitude). 0 when
	 * there's no oscillation window (nothing moved and the capture is otherwise flat). */
	oscAmplitude: number;
	/** Integral of time-weighted |error| — scalar objective for comparing captures of the same move. */
	itae: number;
	/** A commanded move with a steady-speed section was detected. */
	hasMove: boolean;
	/** Standstill control-effort ripple (P/D/output) — see analysis.ts. Distinct from postMoveOsc
	 *  above: that only counts RAILED hunting, this catches dither too small to ever rail. */
	restEffort: RestEffort;
	/** Accelerometer-measured vibration for this capture, when one was armed alongside it — see
	 *  vibration.ts / docs/PLAN-accelerometer.md. Absent (not just invalid) when vibration recording was
	 *  off or no accelerometer was available; never required by anything that reads a TuneSignal. */
	vibration?: Vibration;
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

/**
 * Peak |value| over `values[start..end)` — companion to `oscillationPeriod`, over the same window.
 * Used as the oscillation amplitude "a" in the Åström–Hägglund relay-feedback describing-function
 * estimate `Ku = 4d/(πa)` (d = the known relay/saturation half-amplitude).
 */
export function oscillationAmplitude(values: Array<number>, start: number, end: number): number {
	let peak = 0;
	for (let i = Math.max(0, start); i < end; i++) {
		const v = values[i];
		if (Number.isFinite(v)) { peak = Math.max(peak, Math.abs(v)); }
	}
	return peak;
}

/** Minimum samples a capture needs before its stats are trusted — below this (or a truncated/corrupt
 * CSV caught by the finite-value check below) `computeTuneSignal` returns null, the same as a capture
 * missing its measured/target columns entirely, so callers already treat it as a capture failure to
 * retry (see `captureMedian` in tuneShared.ts) rather than as a real (if garbage) measurement. */
export const MIN_CAPTURE_SAMPLES = 50;

/** Compute the unified tuning signal from a capture. Null if measured/target columns are missing, the
 * capture is too short, or any core stat comes out non-finite (a truncated/corrupt CSV — e.g. a race
 * with the firmware still writing the file — silently NaNs every stat that sums over the data, which
 * previously looked like a valid-but-terrible measurement instead of a capture failure). */
export function computeTuneSignal(capture: ParsedCapture, sampleRateHz: number): TuneSignal | null {
	const series = buildSeries(capture, sampleRateHz);
	if (!series) { return null; }
	const { time, measured, target } = series;
	const n = measured.length;
	if (n < MIN_CAPTURE_SAMPLES) { return null; }
	const error = measured.map((m, i) => m - target[i]);

	const stats = tuneStats(capture, sampleRateHz);
	// A capture that never reached rest measures NOTHING about settling: restBias/restNoise/restRing/
	// settleOvershoot all fall out of empty arrays as 0 — the best attainable value of each — so such a
	// capture outscores every real one on four of signalCost's six terms. Measured on a real report: an
	// A-term capture with restSamples 0 scored a finite 3.0094 and its value became the run's final A.
	// Rejecting returns null, which captureMedian already retries (CAPTURE_RETRIES) — see
	// docs/PLAN-capture-integrity.md §1.
	//
	// NOT the same as rejecting truncated captures, which docs/PLAN-capture-window.md §7 explicitly
	// forbids and which this must not become: truncated captures with real rest data are perfectly
	// usable (this same report has them with 95-988 rest samples) and are deliberately still accepted.
	// The condition is "no at-rest data at all", never "the firmware flagged Data lost".
	if (stats.moved && stats.restSamples === 0) { return null; }
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
	// restNoiseFull, NOT restNoise: this gates a zero-crossing oscillation detector, structurally the same
	// job as evaluate.ts's restRing/cruiseRing gate — a tail-based (smaller) floor here would make ordinary
	// settling itself register as "oscillation" and corrupt the Ku/Tu period this feeds into. See
	// evaluate.ts's TuneStats.restNoiseFull doc comment and docs/PLAN-capture-integrity.md §3.
	const oscThreshold = Math.max(0.3, 3 * stats.restNoiseFull);
	let oscPeriod = oscillationPeriod(error, time, oscStart, n, oscThreshold);
	// Second chance: a small, decaying oscillation can have a clear periodic shape without ever
	// completing enough full-amplitude half-cycles to clear the zero-crossing gate above. Autocorrelation
	// sees the periodicity directly instead of counting crossings — conservatively gated (dsp.ts) so
	// noise can't masquerade as a resonance.
	if (oscPeriod == null) {
		const auto = autocorrelationPeriod(error, oscStart, n);
		if (auto) {
			const windowSamples = n - oscStart;
			const avgDt = windowSamples > 1 ? (time[n - 1] - time[oscStart]) / (windowSamples - 1) : 0;
			if (avgDt > 0) { oscPeriod = auto.lagSamples * avgDt; }
		}
	}
	const oscAmplitude = oscillationAmplitude(error, oscStart, n);

	const pTermAccelPeak = move?.pTermAccelPeak ?? 0;
	const pTermCruiseMean = move?.pTermCruiseMean ?? 0;
	const pTermSatDuty = move?.pTermSatDuty ?? 0;
	if (!Number.isFinite(stats.moveRms) || !Number.isFinite(stats.restBias) || !Number.isFinite(stats.cruiseLag)
		|| !Number.isFinite(stats.settleOvershoot) || !Number.isFinite(itae)
		|| !Number.isFinite(pTermAccelPeak) || !Number.isFinite(pTermCruiseMean) || !Number.isFinite(pTermSatDuty)) {
		return null;
	}

	return {
		stats,
		pTermAccelPeak,
		pTermCruiseMean,
		pTermSatDuty,
		postMoveOsc: move?.postMoveOsc ?? 0,
		oscPeriod,
		oscAmplitude,
		itae,
		hasMove: stats.moved && stats.cruiseSamples >= 3,
		restEffort: computeRestEffort(capture, sampleRateHz),
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

// ---- Whole-loop scalar objective ----
// A single number for "is the WHOLE loop better", not just one term's metric — the basis for judging
// a capture across every term at once (package/joint tuning) instead of one metric per strategy.
// Weights are in motor-step-equivalent units, biased toward the errors a position loop cares about
// most: standing error (lost position) and tracking rms, with overshoot/lag/ringing as secondary terms.

export const COST_WEIGHT_OVERSHOOT = 0.5;
export const COST_WEIGHT_BIAS = 1.0;
export const COST_WEIGHT_LAG = 0.5;
export const COST_WEIGHT_RING = 0.25;
export const COST_RING_FREE = 1; // ring cycles below this are ordinary settling, not penalised
/** Standstill control-effort dither (restEffort.pTermRestRipple, normalised to the 250 P-term rail so
 *  it's a fraction like the other terms below). Package/refine judges every term through THIS cost
 *  alone — unlike the sequential ramp strategies, it had no P-term/effort data in it at all, so it
 *  could jointly optimise straight past a small encoder-scale limit cycle that never moves restBias
 *  enough to matter and never rails. Sized to break ties and penalise dither, not dominate tracking:
 *  contributes ~0.20 for a real dithering capture, ~0.02 for a real settled one — same order as the
 *  restBias term above (1.0 × ~0.11 on those same two captures). See docs/PLAN-standstill-effort.md. */
export const COST_WEIGHT_REST_EFFORT = 1.5;

/** Whole-capture cost — lower is better; Infinity for any attempt the stability veto rejects. */
export function signalCost(s: TuneSignal): number {
	if (signalUnstable(s)) { return Infinity; }
	const { stats, restEffort } = s;
	// restTailValid false (too-short tail, or the integrator was still converging) means the ripple
	// number isn't trustworthy — contribute nothing rather than penalise an attempt that can't be judged.
	const effortCost = restEffort.restTailValid ? restEffort.pTermRestRipple / P_TERM_RAIL : 0;
	return stats.moveRms
		+ COST_WEIGHT_OVERSHOOT * stats.settleOvershoot
		+ COST_WEIGHT_BIAS * Math.abs(stats.restBias)
		+ COST_WEIGHT_LAG * Math.abs(stats.cruiseLag)
		+ COST_WEIGHT_RING * Math.max(0, stats.restRing - COST_RING_FREE)
		+ COST_WEIGHT_REST_EFFORT * effortCost;
}

/**
 * Whole-capture cost EXCLUDING the standstill rest-effort term — the same ordering `signalCost` gives when
 * no candidate has a measurable rest tail.
 *
 * Exists because substituting 0 for an unmeasurable tail (which is what `signalCost` does) is not neutral
 * in a COMPARISON: 0 is the best attainable value of that term, so a capture whose tail could not be
 * judged outscores one that was measured and found perfectly settled. Verified against a real dithering
 * capture (`hold-dither-i0.csv`): marking its own tail unjudgeable made `signalCost` read a 38% apparent
 * improvement — well past `COST_RELATIVE_PLATEAU` — with nothing physically different about the capture.
 * See docs/PLAN-capture-window.md §3.
 */
export function signalCostNoEffort(s: TuneSignal): number {
	if (signalUnstable(s)) { return Infinity; }
	const { stats } = s;
	return stats.moveRms
		+ COST_WEIGHT_OVERSHOOT * stats.settleOvershoot
		+ COST_WEIGHT_BIAS * Math.abs(stats.restBias)
		+ COST_WEIGHT_LAG * Math.abs(stats.cruiseLag)
		+ COST_WEIGHT_RING * Math.max(0, stats.restRing - COST_RING_FREE);
}

/**
 * The cost function to use when ranking `candidates` against each other: the full `signalCost` when every
 * candidate has a measurable rest tail, and the effort-free variant when any of them does not. Ranking a
 * mixed set on the full cost is what lets an unmeasurable capture win on a term it never earned — see
 * `signalCostNoEffort`'s doc comment and docs/PLAN-capture-window.md §3.
 */
export function comparableCost(candidates: Array<TuneSignal>): (s: TuneSignal) => number {
	return candidates.every((c) => c.restEffort.restTailValid) ? signalCost : signalCostNoEffort;
}

export const COST_RELATIVE_PLATEAU = 0.05;  // minimum fractional improvement to count as real
export const COST_NOISE_K = 2;              // …or this many noise floors, whichever threshold is larger
const COST_NOISE_FLOOR_MIN = 0.05;          // absolute floor (steps) when restNoise reads ~0

function costNoiseFloor(s: TuneSignal): number {
	return Math.max(s.stats.restNoise, COST_NOISE_FLOOR_MIN);
}

/**
 * True when `cur` is a meaningfully lower-cost attempt than `prev` under `costFn` — the improvement must
 * clear both a relative plateau threshold and the capture's own encoder-noise floor, so two noisy
 * captures of the same gains are never mistaken for one being "better" than the other.
 */
export function significantlyBetterBy(costFn: (s: TuneSignal) => number, prev: TuneSignal, cur: TuneSignal): boolean {
	const prevCost = costFn(prev);
	const curCost = costFn(cur);
	if (!Number.isFinite(curCost)) { return false; }
	if (!Number.isFinite(prevCost)) { return true; }
	const improvement = prevCost - curCost;
	if (improvement <= 0) { return false; }
	const threshold = Math.max(COST_RELATIVE_PLATEAU * prevCost, COST_NOISE_K * costNoiseFloor(cur));
	return improvement > threshold;
}

/** `significantlyBetterBy` against the whole-loop `signalCost` — the default comparator. Uses
 *  `comparableCost` rather than `signalCost` directly so an unjudgeable rest tail on either side can't
 *  manufacture an apparent improvement — see `signalCostNoEffort`. */
export function significantlyBetter(prev: TuneSignal, cur: TuneSignal): boolean {
	return significantlyBetterBy(comparableCost([prev, cur]), prev, cur);
}

/** Neither attempt is a significant improvement over the other — treat them as tied. */
export function withinNoise(a: TuneSignal, b: TuneSignal): boolean {
	return !significantlyBetter(a, b) && !significantlyBetter(b, a);
}

// ---- Per-term cost augmentation (feed-forward blind-spot fix) ----
// `signalCost` is a whole-loop number, but A and V each have their own real target that it can't see:
// A drives `pTermAccelPeak` toward zero, V drives `pTermCruiseMean` toward zero. Neither quantity is a
// motor-step error, so plain `signalCost` has NO visibility into them — during refinement/package
// optimisation (which judge every term by `signalCost` alone) this let V wander to absurd values
// (thousands, well past V_MAX/2) because raising it further sometimes nudged `cruiseLag` a hair's
// breadth better on pure noise while `pTermCruiseMean` had long since overshot past zero and grown
// again on the other side — invisible to the cost function judging the change. `termAwareCost` folds
// each term's own P-term-domain objective back in, scaled by the same saturation rail every P-term
// metric is measured against, so a probe that makes a term's OWN target worse can't look like a win.
const TERM_COST_WEIGHT = 2;

/** @param base whole-loop cost to fold the term's own objective into — defaults to `signalCost` for a
 *  single capture, but `significantlyBetterForTerm` passes `comparableCost([prev, cur])` so a pairwise
 *  comparison can't be won by an unjudgeable rest tail (see `signalCostNoEffort`). */
export function termAwareCost(term: string, s: TuneSignal, base: (x: TuneSignal) => number = signalCost): number {
	const cost = base(s);
	if (!Number.isFinite(cost)) { return cost; }
	if (term === "v") { return cost + TERM_COST_WEIGHT * (Math.abs(s.pTermCruiseMean) / P_TERM_RAIL); }
	if (term === "a") { return cost + TERM_COST_WEIGHT * (s.pTermAccelPeak / P_TERM_RAIL); }
	return cost;
}

/** `significantlyBetterBy` against `termAwareCost` for the given term — use during refinement/package
 * optimisation so A/V can't drift on noise once their own real objective is at (or past) its optimum. */
export function significantlyBetterForTerm(term: string, prev: TuneSignal, cur: TuneSignal): boolean {
	const base = comparableCost([prev, cur]);
	return significantlyBetterBy((s) => termAwareCost(term, s, base), prev, cur);
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
			restNoiseFull: stat((s) => s.restNoiseFull),
			restRing: stat((s) => s.restRing),
			cruiseRing: stat((s) => s.cruiseRing),
			settleOvershoot: stat((s) => s.settleOvershoot),
			cruiseLag: stat((s) => s.cruiseLag),
			cruiseSpread: stat((s) => s.cruiseSpread),
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
		oscAmplitude: median(signals.map((s) => s.oscAmplitude)),
		itae: median(signals.map((s) => s.itae)),
		hasMove: signals.filter((s) => s.hasMove).length * 2 > signals.length,
		restEffort: {
			pTermRestRipple: median(signals.map((s) => s.restEffort.pTermRestRipple)),
			pTermRestRms: median(signals.map((s) => s.restEffort.pTermRestRms)),
			dTermRestRipple: median(signals.map((s) => s.restEffort.dTermRestRipple)),
			outputRestRipple: median(signals.map((s) => s.restEffort.outputRestRipple)),
			restTailSamples: median(signals.map((s) => s.restEffort.restTailSamples)),
			// Majority vote, same pattern as `moved`/`hasMove` above — a median across a mix of valid
			// and invalid measurements would itself be untrustworthy, so require most captures agree.
			restTailValid: signals.filter((s) => s.restEffort.restTailValid).length * 2 > signals.length,
		},
		// Vibration is a report-only diagnostic overlay, never a decision input (docs/PLAN-accelerometer.md
		// §11) — there's no meaningful way to "median" a whole region-split Vibration object across N
		// repeated captures, so this just carries the first one that exists rather than combining them.
		vibration: signals.find((s) => s.vibration)?.vibration,
	};
}

/** One-line summary for the auto-tune log. Includes `cruise-P` (pTermCruiseMean) — the actual quantity
 * V's decision is based on — so a V ramp/solve's log is legible instead of only showing `lag`, which
 * tracks it but isn't the number being judged. */
export function describeSignal(s: TuneSignal, opts: { alwaysShowSat?: boolean } = {}): string {
	const parts = [
		`rms ${s.stats.moveRms.toFixed(2)}`,
		`bias ${s.stats.restBias.toFixed(2)}`,
		`overshoot ${s.stats.settleOvershoot.toFixed(2)}`,
		`lag ${s.stats.cruiseLag.toFixed(2)}`,
		`accel pk ${s.pTermAccelPeak.toFixed(0)}`,
		`cruise-P ${s.pTermCruiseMean.toFixed(1)}`,
	];
	// The model-fit ramp decides on sat duty, so its log lines must distinguish "0%" from "not shown"
	// — the default elision below made a 0% reading and a 1.4% one look identical in a field report,
	// which is what made docs/PLAN-rail-detection.md §1 hard to diagnose. One decimal, always printed.
	if (opts.alwaysShowSat) { parts.push(`sat ${(s.pTermSatDuty * 100).toFixed(1)}%`); }
	else if (s.pTermSatDuty > 0.01) { parts.push(`sat ${(s.pTermSatDuty * 100).toFixed(0)}%`); }
	if (s.postMoveOsc > 0) { parts.push(`${s.postMoveOsc} hunt`); }
	if (s.stats.restRing > 0) { parts.push(`${s.stats.restRing} ring`); }
	// Standstill P-term ripple (see analysis.ts computeRestEffort) — only shown when measured, so a
	// too-short/still-converging capture (restTailValid: false) doesn't clutter the log with a number
	// that isn't trustworthy.
	if (s.restEffort.restTailValid && s.restEffort.pTermRestRipple > 0) { parts.push(`rest-ripple ${s.restEffort.pTermRestRipple.toFixed(1)}`); }
	return parts.join(", ");
}
