/**
 * "Model fit" identification — treats P/A/V as a system-identification problem instead of a search.
 *
 * Field data from a real loaded axis showed P×cruiseLag and P×moveRms held CONSTANT to within ~2% over
 * a 9× range of P (30→270) before the P-term ever approached its rail. That is the signature of a
 * well-damped proportional servo: cruise needs a fixed effort, and the error is just that effort divided
 * by P. Two consequences that this module exists to fix:
 *
 *  - Ziegler–Nichols continuous cycling (ramp P looking for a sustained oscillation) and Åström–Hägglund
 *    relay feedback (a saturating limit cycle) both assume the loop's phase can be pushed toward -180°
 *    below the actuator's rail. A well-damped servo like this may never do that — "no sustained
 *    oscillation found, falling back to the conservative ramp" is the method being physically
 *    inapplicable to the plant, not a bug in the detector. No amount of tuning the detection threshold
 *    fixes this; a different identification method is needed.
 *  - V (and A) don't need a search either. `pTermCruiseMean` (the quantity V drives to zero) is
 *    approximately linear in V near the operating point — two captures (V=0 and one probe) and a
 *    straight-line solve for the zero-crossing gets the answer directly, instead of a geometric ramp
 *    that can wildly overshoot a large true value (or grind through many captures approaching it).
 *
 * P is identified by ramping (I=D=A=V=0, the same shape as the continuous-cycling search) not to find
 * an oscillation but to find where the P-term starts riding its own rail — the actuator's real ceiling —
 * then backing off a fixed fraction. This value is used directly as P (no separate "P stage" ramp
 * afterwards, so cycle 1 doesn't re-measure values this identification already has). A and V are then
 * each solved from a two-capture linear fit of their own P-term-domain target. If a probe shows no
 * measurable effect (within a noise floor derived from a real rest-noise measurement, not a guessed
 * constant), the term is honestly left at 0 and the run says so, rather than accepting whatever a ramp
 * happened to land on.
 *
 * Every side effect goes through `TuneEffects` from tuneShared.ts, and this module has no dependency on
 * autorun.ts (which calls INTO here) — kept as a leaf module for the same reason optimize.ts is one.
 */
import { P_TERM_RAIL } from "./analysis";
import { P_MAX, type SignalAttempt } from "./autotune";
import type { PidConfig } from "./m569";
import { comparableCost, describeSignal, signalUnstable, type TuneSignal } from "./signal";
import {
	captureMedian, clampTerm, SEED_START, SETTLE_DELAY_MS, verifyAccepted,
	type EnvelopeCheck, type TuneEffects,
} from "./tuneShared";

function round(v: number, dp = 2): number {
	const f = Math.pow(10, dp);
	return Math.round(v * f) / f;
}

/** Same geometric ramp shape the continuous-cycling search and ramp strategies use. */
function nextRampValue(value: number): number {
	return round(value < 100 ? value + 20 : value * 1.25);
}

// ---- P: ramp to the effort rail, then back off ----

/** Accel-phase P-term at or above this fraction of the rail counts as "onset" — the servo is starting
 * to lean on the actuator's own ceiling, which is the real, machine-specific limit on how hard P can push. */
export const MODEL_FIT_ACCEL_FRACTION = 0.85;
export const MODEL_FIT_BACKOFF_DEFAULT = 0.65;
/** Saturation duty at/above this is rail onset too — a single-capture accel PEAK is noisy run-to-run
 * (the same P read 256 one day and 180 the next on the same machine), so sat duty backs it up. */
export const MODEL_FIT_SAT_ONSET = 0.02;

/**
 * Interpret a validation capture's saturation duty against MODEL_FIT_SAT_ONSET — the same "the loop is
 * saturating" line the ramp above already uses, reused rather than inventing a second threshold for the
 * same underlying question (docs/PLAN-envelope-check.md, decision D). Pure so the judgment call lives in
 * one tested place; the host adapter only needs to measure satDuty, not decide what it means.
 */
export function evaluateEnvelope(feedMmPerMin: number, satDuty: number): EnvelopeCheck {
	return { feedMmPerMin, satDuty, holds: satDuty < MODEL_FIT_SAT_ONSET };
}
/** Enough geometric-ramp steps to go from SEED_START all the way to P_MAX (30 → … → 600 is 13 steps).
 * The previous budget of 10 expired at P=335.7 — provably one-to-two steps short of a real machine's
 * rail (~369, trend-extrapolated from its own accel-pk readings 89 → 105 → 180). */
const MODEL_FIT_MAX_ATTEMPTS = 14;

export interface ModelFitPResult {
	/** P value the rail onset was measured or extrapolated at (equals pStar for "best-measured"). */
	pRailOnset: number;
	/** The value actually used, before verification. */
	pStar: number;
	/** How pStar was arrived at — always logged, so an accepted P is never unexplained. */
	basis: "rail" | "unstable-backoff" | "extrapolated" | "best-measured";
}

export interface ModelFitPOutcome {
	result: ModelFitPResult | null;
	/** Every ramp reading, success or not — callers must reuse these instead of re-measuring the curve. */
	attempts: Array<SignalAttempt>;
}

/**
 * Extrapolate where the accel-peak trend crosses the rail-onset threshold from the tail of the ramp
 * readings. Needs the last `points` (default 3) stable readings to be strictly increasing in accel
 * peak; returns null when the tail is flat or falling (no trend to extrapolate). Pure — unit tested.
 */
export function extrapolateRailOnset(tail: Array<{ p: number; accelPeak: number }>, threshold = MODEL_FIT_ACCEL_FRACTION * P_TERM_RAIL): number | null {
	if (tail.length < 3) { return null; }
	const pts = tail.slice(-3);
	for (let i = 1; i < pts.length; i++) {
		if (pts[i].accelPeak <= pts[i - 1].accelPeak || pts[i].p <= pts[i - 1].p) { return null; }
	}
	const a = pts[pts.length - 2];
	const b = pts[pts.length - 1];
	const slope = (b.accelPeak - a.accelPeak) / (b.p - a.p);
	if (slope <= 0) { return null; }
	const onset = b.p + (threshold - b.accelPeak) / slope;
	if (!Number.isFinite(onset) || onset <= b.p) { return null; }
	return Math.min(onset, P_MAX);
}

/**
 * Ramp P (I=D=A=V=0) toward the actuator's effort rail — not toward an oscillation, which a well-damped
 * servo may never produce below saturation — then back off `backoff` (default 65%). Three graceful
 * degradations instead of a wholesale fallback (a real run's fallback re-measured the identical curve
 * three times, 26 captures for one curve):
 *  - rail found (accel peak ≥ 0.85×rail, or sat duty ≥ 2%) → P* = backoff × onset;
 *  - budget/P_MAX exhausted but the accel-peak tail is cleanly rising → P* = backoff × extrapolated
 *    onset, with the arithmetic logged;
 *  - exhausted with a flat tail → P* = the best (lowest whole-loop cost) stable reading, used directly.
 * `result` is null only when the capture itself fails or the loop is unstable before any clean reading —
 * cases where every other identification would fail identically, so the caller should skip straight to
 * the legacy P stage (primed with `attempts`) rather than re-ramping.
 */
export async function identifyModelFitP(
	effects: TuneEffects, medianOf: number, backoff: number,
): Promise<ModelFitPOutcome> {
	let value = SEED_START;
	const attempts: Array<SignalAttempt> = [];
	const railThreshold = MODEL_FIT_ACCEL_FRACTION * P_TERM_RAIL;
	/** Back off from the last clean reading. Call with `attempts` already holding only clean entries. */
	const unstableBackoff = (atValue: number): ModelFitPOutcome => {
		const lastClean = attempts.length ? attempts[attempts.length - 1].value : null;
		if (lastClean != null) {
			const pStar = round(backoff * lastClean);
			effects.log(`Model fit: P=${atValue} went unstable — using the last clean reading (P=${lastClean}) as rail onset, backing off ${(backoff * 100).toFixed(0)}% to P*=${pStar}.`);
			return { result: { pRailOnset: lastClean, pStar, basis: "unstable-backoff" }, attempts };
		}
		effects.log("Model fit: went unstable before any clean reading.");
		return { result: null, attempts };
	};
	for (let k = 0; k < MODEL_FIT_MAX_ATTEMPTS; k++) {
		if (effects.isCancelled()) { return { result: null, attempts }; }
		await effects.applyPid({ p: value, i: 0, d: 0, v: 0, a: 0 });
		await effects.delay(SETTLE_DELAY_MS);
		effects.status(`Model fit: ramping P=${value} toward the effort rail…`);
		const signal = await captureMedian(effects, medianOf);
		if (!signal) { effects.log("Model fit: capture failed."); return { result: null, attempts }; }
		effects.log(`Model fit: P=${value} → ${describeSignal(signal, { alwaysShowSat: true })}`);
		if (signalUnstable(signal)) { return unstableBackoff(value); }
		attempts.push({ value, signal });

		/** Declare the rail here. Also flags the degenerate case where it lands on the seed itself. */
		const railAt = (s: TuneSignal): ModelFitPOutcome => {
			const pStar = round(backoff * value);
			effects.log(`Model fit: rail onset at P=${value} (accel P-term ${s.pTermAccelPeak.toFixed(0)}/${P_TERM_RAIL}, sat ${(s.pTermSatDuty * 100).toFixed(0)}%) — backing off ${(backoff * 100).toFixed(0)}% to P*=${pStar}.`);
			if (value === SEED_START) {
				effects.log(`Model fit: that rail is at the seed P=${SEED_START}, so P*=${pStar} is ${(backoff * 100).toFixed(0)}% of the seed rather than anything measured about this axis — the tuning move is likely too aggressive for it (try a lower feedrate).`);
			}
			return { result: { pRailOnset: value, pStar, basis: "rail" }, attempts };
		};

		// Saturation duty is STRONG evidence — samples really are pinned at the clamp — so it stands on
		// its own reading. The accel PEAK is weak evidence: a single-capture statistic whose run-to-run
		// spread is wider than the threshold's own margin (field 2026-09: 212-219 at one P on one
		// unchanged profile, against a threshold of 212.5), and a false rail here ENDS identification,
		// collapsing P* to backoff x SEED_START. So peak-alone must be confirmed before it is believed.
		// See docs/PLAN-rail-detection.md §1.
		if (signal.pTermSatDuty >= MODEL_FIT_SAT_ONSET) { return railAt(signal); }
		if (signal.pTermAccelPeak >= railThreshold) {
			effects.log(`Model fit: P=${value} accel P-term ${signal.pTermAccelPeak.toFixed(0)} reached the rail fraction but nothing is saturating (sat ${(signal.pTermSatDuty * 100).toFixed(1)}%) — re-measuring to confirm.`);
			const confirm = await captureMedian(effects, medianOf);
			if (!confirm) { effects.log("Model fit: confirmation capture failed."); return { result: null, attempts }; }
			effects.log(`Model fit: P=${value} (confirm) → ${describeSignal(confirm, { alwaysShowSat: true })}`);
			// Record the confirming read, not the lower or the median of the pair: it is the reading the
			// ramp acts on, so the extrapolation tail stays consistent with the decision made here.
			attempts[attempts.length - 1] = { value, signal: confirm };
			if (signalUnstable(confirm)) { attempts.pop(); return unstableBackoff(value); }
			if (confirm.pTermAccelPeak >= railThreshold || confirm.pTermSatDuty >= MODEL_FIT_SAT_ONSET) {
				return railAt(confirm);
			}
			effects.log(`Model fit: not confirmed (accel P-term ${confirm.pTermAccelPeak.toFixed(0)}) — treating P=${value} as clean and continuing the ramp.`);
		}
		if (value >= P_MAX) { break; }
		value = Math.min(nextRampValue(value), P_MAX);
	}

	// Budget or P_MAX exhausted without touching the rail. First choice: extrapolate the rising tail.
	const tail = attempts.map((a) => ({ p: a.value, accelPeak: a.signal.pTermAccelPeak }));
	const onset = extrapolateRailOnset(tail);
	if (onset != null) {
		const pStar = round(Math.min(backoff * onset, P_MAX));
		const [a, b] = tail.slice(-2);
		effects.log(`Model fit: rail not reached by P=${attempts[attempts.length - 1].value}; accel-peak trend (${a.accelPeak.toFixed(0)} @ P=${a.p} → ${b.accelPeak.toFixed(0)} @ P=${b.p}) extrapolates onset to P≈${onset.toFixed(0)} — backing off ${(backoff * 100).toFixed(0)}% to P*=${pStar}.`);
		return { result: { pRailOnset: round(onset), pStar, basis: "extrapolated" }, attempts };
	}
	// Flat tail: no rail, no trend — the best stable reading IS the measurement. Use it directly.
	if (attempts.length) {
		// comparableCost, not plain signalCost: ranking a mixed set of judgeable/unjudgeable rest tails on
		// the full cost lets an unjudgeable one win purely by contributing nothing — see
		// signalCostNoEffort's doc comment and docs/PLAN-capture-window.md §3.
		const cost = comparableCost(attempts.map((a) => a.signal));
		const best = attempts.reduce((acc, a) => (cost(a.signal) < cost(acc.signal) ? a : acc), attempts[0]);
		effects.log(`Model fit: rail not reached and no rising accel-peak trend — using the best measured reading directly (P=${best.value}).`);
		return { result: { pRailOnset: best.value, pStar: best.value, basis: "best-measured" }, attempts };
	}
	return { result: null, attempts };
}

// ---- A / V: two-capture linear solve ----

/** Zero-crossing of the line through (0, y0) and (x1, y1). Pure — unit tested directly. 0 when the line
 * is degenerate (x1 is 0, or the fit is flat) rather than dividing by zero. */
export function solveZeroCrossing(y0: number, y1: number, x1: number): number {
	if (x1 === 0) { return 0; }
	const slope = (y1 - y0) / x1;
	if (slope === 0) { return 0; }
	return -y0 / slope;
}

/** Whether a measured change is distinguishable from P-term measurement noise. */
export function isSignificantDelta(deltaY: number, noiseFloor: number): boolean {
	return Math.abs(deltaY) > noiseFloor;
}

const FF_PROBE_1: Record<"a" | "v", number> = { a: 50000, v: 300 };
const FF_PROBE_2: Record<"a" | "v", number> = { a: 150000, v: 1500 };
/** Solved value is clamped to this many × the probe actually used — bounds a noisy/extrapolated solve
 * without needing to know the term's absolute cap up front. */
const FF_SOLVE_CLAMP = 4;
const FF_NOISE_FLOOR_MIN = 5; // P-term units — absolute floor when the rest-noise baseline reads ~0
const FF_NOISE_K = 3;

function ffMetric(term: "a" | "v", s: TuneSignal): number {
	return term === "v" ? s.pTermCruiseMean : s.pTermAccelPeak;
}
function ffLabel(term: "a" | "v"): string {
	return term === "v" ? "V (velocity feed-forward)" : "A (accel feed-forward)";
}

export interface FeedForwardSolveResult {
	/** The value left applied (0 when the term wasn't measurable or didn't verify). */
	applied: number;
	/** True when the term had a real, verified effect on this move. */
	measurable: boolean;
	/** The signal now in effect — the verified capture, or the baseline when the term stayed 0. */
	signal: TuneSignal;
}

/**
 * Two-capture linear solve for A or V: baseline (term already 0 in `pid`) + one probe, fit the P-term-
 * domain metric the term drives to zero (`pTermAccelPeak` for A, `pTermCruiseMean` for V) against the
 * probed value, and solve for the value that zeroes it. If the first probe doesn't move the metric past
 * a noise floor, tries one larger probe before concluding the term has no measurable effect on this move
 * — rather than guessing a value from noise, or ramping indefinitely toward one. `pTermNoiseFloor` should
 * be derived from a real rest-noise measurement (steps) scaled into P-term units by the caller (see
 * `restNoiseToPTermFloor`), not a hard-coded constant.
 */
export async function solveFeedForwardTerm(
	effects: TuneEffects, term: "a" | "v", pid: PidConfig, baseline: TuneSignal, medianOf: number, verifyRetries: number,
	pTermNoiseFloor: number,
): Promise<FeedForwardSolveResult> {
	const label = ffLabel(term);
	const y0 = ffMetric(term, baseline);
	const noiseFloor = Math.max(pTermNoiseFloor * FF_NOISE_K, FF_NOISE_FLOOR_MIN);

	const revertToZero = async (): Promise<FeedForwardSolveResult> => {
		pid[term] = 0;
		await effects.applyPid(pid);
		return { applied: 0, measurable: false, signal: baseline };
	};

	const probeAt = async (value: number): Promise<TuneSignal | null> => {
		pid[term] = value;
		await effects.applyPid(pid);
		await effects.delay(SETTLE_DELAY_MS);
		effects.status(`Model fit: probing ${term.toUpperCase()}=${value}…`);
		const signal = await captureMedian(effects, medianOf);
		if (signal) { effects.log(`Model fit: ${term.toUpperCase()}=${value} → ${describeSignal(signal)}`); }
		return signal;
	};

	let probeValue = FF_PROBE_1[term];
	const firstProbe = await probeAt(probeValue);
	if (!firstProbe) { effects.log(`${label}: probe capture failed — leaving ${term.toUpperCase()}=0.`); return revertToZero(); }
	if (signalUnstable(firstProbe)) {
		effects.log(`${label}: the first probe (${term.toUpperCase()}=${probeValue}) destabilised the loop — leaving ${term.toUpperCase()}=0.`);
		return revertToZero();
	}

	let probeSignal = firstProbe;
	let y1 = ffMetric(term, probeSignal);
	if (!isSignificantDelta(y1 - y0, noiseFloor)) {
		// One bigger probe before giving up — a small first step may just be below the noise floor on a
		// machine whose true operating point is far out (this is exactly what happened in the field: the
		// true V was ~1400, and a 300-unit probe alone would have looked like "no effect").
		const secondValue = FF_PROBE_2[term];
		const secondProbe = await probeAt(secondValue);
		if (secondProbe && !signalUnstable(secondProbe)) {
			probeValue = secondValue;
			probeSignal = secondProbe;
			y1 = ffMetric(term, secondProbe);
		}
	}

	if (!isSignificantDelta(y1 - y0, noiseFloor)) {
		effects.log(`${label}: no measurable effect on this move (Δ${(y1 - y0).toFixed(1)}, noise floor ${noiseFloor.toFixed(1)}) — leaving ${term.toUpperCase()}=0.`);
		return revertToZero();
	}

	const solvedRaw = solveZeroCrossing(y0, y1, probeValue);
	const solved = clampTerm(term, round(Math.max(0, Math.min(solvedRaw, probeValue * FF_SOLVE_CLAMP))));
	effects.log(`Model fit: ${term.toUpperCase()} solve — ${y0.toFixed(1)} at 0, ${y1.toFixed(1)} at ${probeValue} → ${term.toUpperCase()}=${solved.toFixed(0)}.`);

	const verified = await verifyAccepted(effects, term, pid, solved, medianOf, verifyRetries);
	if (!verified.ok) {
		effects.log(`${label}: ${verified.reason} — leaving ${term.toUpperCase()}=0.`);
		return revertToZero();
	}
	pid[term] = verified.value;
	await effects.applyPid(pid);
	return { applied: verified.value, measurable: true, signal: verified.signal };
}

/** Convert a rest-noise (motor steps) baseline into a P-term-domain noise floor at a given P gain —
 * P-term ≈ P × error, so P-term noise ≈ P × step noise. Exported so the orchestrator (autorun.ts) can
 * compute it once from the preflight probe's own measured rest noise instead of guessing a constant. */
export function restNoiseToPTermFloor(restNoiseSteps: number, pGain: number): number {
	return restNoiseSteps * pGain;
}

// ---- Full P → A → V identification ----

export interface ModelFitResult {
	pStar: number;
	/** How P* was arrived at (rail / extrapolated / best-measured / unstable-backoff). */
	pBasis: ModelFitPResult["basis"];
	a: FeedForwardSolveResult;
	v: FeedForwardSolveResult;
	/** The last capture taken (after A and V are both set) — feeds ITAE tracking / D-I baselining. */
	finalSignal: TuneSignal;
}

export interface ModelFitOutcome {
	fit: ModelFitResult | null;
	/** The P-ramp readings, kept on failure too — the caller primes the legacy P stage with these
	 * instead of re-ramping the identical curve (a real fallback run measured it three times). */
	pRampAttempts: Array<SignalAttempt>;
}

/**
 * Full P → A → V model-fit identification for cycle 1. Mutates `pid` in place (p, a, v — leaves i, d
 * untouched for the existing D/I ramp stages to seed from 0 as usual). `fit` is null only when the
 * P ramp couldn't measure at all (capture failure / instability before any clean reading / P* failing
 * verification) — cases where re-ramping via another identification method would fail identically, so
 * the caller should go straight to the legacy P stage primed with `pRampAttempts`.
 */
export async function runModelFitIdentification(
	effects: TuneEffects, pid: PidConfig, medianOf: number, verifyRetries: number, backoff: number,
): Promise<ModelFitOutcome> {
	const { result: pResult, attempts: pRampAttempts } = await identifyModelFitP(effects, medianOf, backoff);
	if (!pResult) { return { fit: null, pRampAttempts }; }

	const verifiedP = await verifyAccepted(effects, "p", pid, pResult.pStar, medianOf, verifyRetries);
	if (!verifiedP.ok) {
		effects.log(`Model fit: ${verifiedP.reason}`);
		return { fit: null, pRampAttempts };
	}
	pid.p = verifiedP.value;
	await effects.applyPid(pid);

	const pTermNoiseFloor = restNoiseToPTermFloor(verifiedP.signal.stats.restNoise, pid.p);

	const a = await solveFeedForwardTerm(effects, "a", pid, verifiedP.signal, medianOf, verifyRetries, pTermNoiseFloor);
	const v = await solveFeedForwardTerm(effects, "v", pid, a.signal, medianOf, verifyRetries, pTermNoiseFloor);

	return { fit: { pStar: verifiedP.value, pBasis: pResult.basis, a, v, finalSignal: v.signal }, pRampAttempts };
}
