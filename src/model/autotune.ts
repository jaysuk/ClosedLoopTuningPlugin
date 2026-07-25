/**
 * Automatic PID tuning controller (pure decision logic — unit-tested).
 *
 * Duet removed their auto-tuner, so this drives the documented manual procedure automatically: for
 * each term in turn it repeatedly sets a value, runs a capture, reads the analysis metrics, and
 * decides whether to increase, accept, or back off. The UI supplies the capture+analysis side effect;
 * this module only decides the next move, so it's deterministic and testable.
 *
 * Two strategy families, selected once per run by capture kind:
 *  - SignalStrategy (SIGNAL_* / AUTOTUNE_SIGNAL_SEQUENCE): for drivers with an axis, judged on the
 *    unified TuneSignal from a trapezoid G1 move — error-domain region stats + PID-P-term effort.
 *    This is the primary path: step-response metrics are meaningless for trapezoid moves (they're
 *    dominated by the commanded profile), which is how the old tuner destabilized loaded axes.
 *  - TermStrategy (P/D/I_STRATEGY / AUTOTUNE_SEQUENCE): legacy step-response path for extruders,
 *    where the firmware V64 step manoeuvre applies a genuine step and StepMetrics are valid.
 *
 * Every strategy is bounded (value caps + max attempts) and vetoes instability before anything else.
 */
import type { StepMetrics } from "./analysis";
import { OVERSHOOT_GOOD, REST_GOOD, RING_WARN } from "./evaluate";
import { SAT_DUTY_LIMIT, signalDiverging, signalUnstable, type TuneSignal } from "./signal";
import type { PidTerm } from "./wizard";

export interface Attempt {
	value: number;
	metrics: StepMetrics;
}

export type AutoDecision =
	| { kind: "set"; value: number; note: string }
	| { kind: "accept"; value: number; note: string }
	| { kind: "fail"; reason: string };

export interface TermStrategy {
	term: PidTerm;
	label: string;
	/** Value to try first. */
	start: number;
	/** Hard cap on attempts for this term. */
	maxAttempts: number;
	/** Decide the next move given all attempts so far (latest last). */
	decide(attempts: Array<Attempt>): AutoDecision;
}

// Thresholds / bounds (exported for tests + transparency).
export const P_OSC_LIMIT = 8;        // oscillation count that means P is too high
export const P_MAX = 600;
export const P_RISE_PLATEAU = 0.05;  // <5% rise-time improvement → stop raising P
export const D_OVERSHOOT_OK = 8;     // % overshoot considered critically damped
export const D_OSC_LIMIT = 14;       // ringing/noise that means D is too high
export const D_MAX = 0.6;
export const I_SSE_OK = 0.1;         // steady-state error (steps) considered settled
export const I_OSC_LIMIT = 14;
export const I_MAX = 60000;

function round(v: number, dp = 2): number {
	const f = Math.pow(10, dp);
	return Math.round(v * f) / f;
}

/** A step attempt whose loop is saturating or oscillating — never acceptable, always back off. */
function stepUnstable(m: StepMetrics): boolean {
	return m.pTermSatDuty >= SAT_DUTY_LIMIT || m.oscillations >= P_OSC_LIMIT || m.overshootPct > 60;
}

/** The fastest (lowest rise time) attempt that wasn't oscillating. */
function bestStable(attempts: Array<Attempt>): Attempt | null {
	let best: Attempt | null = null;
	for (const a of attempts) {
		if (!a.metrics.hasStep || stepUnstable(a.metrics)) { continue; }
		if (a.metrics.riseTime == null) { continue; }
		if (!best || (best.metrics.riseTime != null && a.metrics.riseTime < best.metrics.riseTime)) { best = a; }
	}
	return best;
}

const noStep: AutoDecision = { kind: "fail", reason: "No clear step detected — check the driver is in closed/assisted mode, calibrated, and that the axis can move." };

export const P_STRATEGY: TermStrategy = {
	term: "p",
	label: "P (proportional)",
	start: 30,
	maxAttempts: 12,
	decide(attempts) {
		const last = attempts[attempts.length - 1];
		if (!last.metrics.hasStep) { return noStep; }
		// Oscillating / saturating / large overshoot → P too high; fall back to the last stable value.
		if (stepUnstable(last.metrics)) {
			const prior = [...attempts].slice(0, -1).reverse().find((a) => !stepUnstable(a.metrics));
			const v = prior ? prior.value : round(last.value * 0.6);
			return { kind: "accept", value: v, note: `P=${last.value} oscillated — backed off to ${v}.` };
		}
		// Diminishing returns on rise time → settle.
		if (attempts.length >= 2) {
			const prev = attempts[attempts.length - 2];
			const pr = prev.metrics.riseTime;
			const cr = last.metrics.riseTime;
			if (pr != null && cr != null && pr > 0 && (pr - cr) / pr < P_RISE_PLATEAU) {
				return { kind: "accept", value: last.value, note: `Rise time plateaued at ${(cr * 1000).toFixed(0)} ms.` };
			}
		}
		const next = round(last.value < 100 ? last.value + 20 : last.value * 1.25);
		if (next > P_MAX) { return { kind: "accept", value: last.value, note: `Reached the P limit (${P_MAX}).` }; }
		if (attempts.length >= this.maxAttempts) {
			const best = bestStable(attempts);
			return { kind: "accept", value: best?.value ?? last.value, note: "Max attempts reached." };
		}
		return { kind: "set", value: next, note: `Increasing P to ${next}.` };
	},
};

export const D_STRATEGY: TermStrategy = {
	term: "d",
	label: "D (derivative)",
	start: 0,
	maxAttempts: 16,
	decide(attempts) {
		const last = attempts[attempts.length - 1];
		if (!last.metrics.hasStep) { return noStep; }
		// Saturation first: a railing loop invalidates every other metric.
		if (last.metrics.pTermSatDuty >= SAT_DUTY_LIMIT || last.metrics.oscillations >= D_OSC_LIMIT) {
			const v = attempts.length >= 2 ? attempts[attempts.length - 2].value : round(Math.max(0, last.value - 0.05), 3);
			return { kind: "accept", value: v, note: `D=${last.value} caused ringing — backed off to ${v}.` };
		}
		if (last.metrics.overshootPct <= D_OVERSHOOT_OK) {
			return { kind: "accept", value: last.value, note: `Overshoot ${last.metrics.overshootPct.toFixed(0)}% — critically damped.` };
		}
		const next = round(last.value + (last.value < 0.5 ? 0.01 : 0.025), 3);
		if (next > D_MAX) { return { kind: "accept", value: last.value, note: `Reached the D limit (${D_MAX}).` }; }
		if (attempts.length >= this.maxAttempts) { return { kind: "accept", value: last.value, note: "Max attempts reached." }; }
		return { kind: "set", value: next, note: `Increasing D to ${next}.` };
	},
};

export const I_STRATEGY: TermStrategy = {
	term: "i",
	label: "I (integral)",
	start: 0,
	maxAttempts: 12,
	decide(attempts) {
		const last = attempts[attempts.length - 1];
		if (!last.metrics.hasStep) { return noStep; }
		// Saturation / oscillation first (integral windup rails the loop long before SSE looks bad).
		if (last.metrics.pTermSatDuty >= SAT_DUTY_LIMIT || last.metrics.oscillations >= I_OSC_LIMIT) {
			const v = attempts.length >= 2 ? attempts[attempts.length - 2].value : round(last.value * 0.6);
			return { kind: "accept", value: v, note: `I=${last.value} caused oscillation — backed off to ${v}.` };
		}
		if (Math.abs(last.metrics.steadyStateError) <= I_SSE_OK) {
			return { kind: "accept", value: last.value, note: `Steady-state error ${last.metrics.steadyStateError.toFixed(2)} — settled.` };
		}
		const next = round(last.value <= 0 ? 1000 : last.value * 1.5);
		if (next > I_MAX) { return { kind: "accept", value: last.value, note: `Reached the I limit (${I_MAX}).` }; }
		if (attempts.length >= this.maxAttempts) { return { kind: "accept", value: last.value, note: "Max attempts reached." }; }
		return { kind: "set", value: next, note: `Increasing I to ${next}.` };
	},
};

/** Legacy step-response auto-tune sequence (extruders / V64 step manoeuvre): P, then D, then I. */
export const AUTOTUNE_SEQUENCE: Array<TermStrategy> = [P_STRATEGY, D_STRATEGY, I_STRATEGY];

/** One-line summary of a step capture's metrics for the auto-tune log. */
export function describeMetrics(m: StepMetrics): string {
	const rise = m.riseTime == null ? "—" : `${(m.riseTime * 1000).toFixed(0)}ms`;
	const sat = m.pTermSatDuty > 0.01 ? `, sat ${(m.pTermSatDuty * 100).toFixed(0)}%` : "";
	return `rise ${rise}, overshoot ${m.overshootPct.toFixed(0)}%, ss-err ${m.steadyStateError.toFixed(2)}, osc ${m.oscillations}${sat}`;
}

// ---- Unified TuneSignal strategies (drivers with an axis; trapezoid G1 move captures) ----

export interface SignalAttempt {
	value: number;
	signal: TuneSignal;
}

export interface SignalStrategy {
	term: PidTerm;
	label: string;
	start: number;
	maxAttempts: number;
	decide(attempts: Array<SignalAttempt>): AutoDecision;
}

export const A_MAX = 2_000_000;
export const V_MAX = 10000;
export const AV_PLATEAU = 0.05;       // <5% improvement → stop raising (push further before settling)
export const V_CRUISE_OK = 3;         // |mean P term| in cruise considered ~zero
export const P_RMS_PLATEAU = 0.05;    // <5% tracking-error improvement → stop raising P
/**
 * moveRms within this × the MEASURED encoder noise floor → done. Deliberately no absolute minimum:
 * the old `P_NOISE_FLOOR_MIN = 0.15` constant manufactured a fake 0.45-step floor on machines whose
 * real rest noise was ~0.11, accepting P at half the value the same run's own data supported. With
 * perfect tracking moveRms bottoms out at ≈1× the rest noise, so 1.5× is "close enough to perfect
 * that raising P further only buys noise amplification".
 */
export const P_NOISE_FLOOR_K = 1.5;
export const D_RING_WORSE = 2;        // ring cycles added vs the previous attempt → D is amplifying noise
/** A's accel-peak change (vs A=0) below this fraction of the A=0 peak is indistinguishable from
 * capture noise — accept A=0 rather than whatever value the ramp happened to be on. */
export const A_NO_EFFECT_FRACTION = 0.1;

const noMove: AutoDecision = { kind: "fail", reason: "No steady-speed move detected — increase the test move length or speed so the axis reaches cruise." };

/** Highest stable attempt (values ramp monotonically, so this is the safe value to fall back to). */
function lastStable(attempts: Array<SignalAttempt>): SignalAttempt | null {
	let best: SignalAttempt | null = null;
	for (const a of attempts) { if (!signalUnstable(a.signal)) { best = a; } }
	return best;
}

/** Smallest-metric attempt (e.g. rms / accel peak / |cruise mean|), ignoring any that went unstable. */
function bestBy(attempts: Array<SignalAttempt>, metric: (s: TuneSignal) => number): SignalAttempt {
	const stable = attempts.filter((a) => !signalUnstable(a.signal));
	const pool = stable.length ? stable : attempts;
	return pool.reduce((best, a) => (metric(a.signal) < metric(best.signal) ? a : best), pool[0]);
}

/** Shared "this value destabilised the loop — revert" decision. */
function backOff(attempts: Array<SignalAttempt>, term: string, fallback: number): AutoDecision {
	const last = attempts[attempts.length - 1];
	const stable = lastStable(attempts.slice(0, -1));
	const v = stable ? stable.value : fallback;
	const why = `sat ${(last.signal.pTermSatDuty * 100).toFixed(0)}%, ${last.signal.postMoveOsc} hunt, ${last.signal.stats.restRing} ring`;
	return { kind: "accept", value: v, note: `${term}=${last.value} destabilised the loop (${why}) — backed off to ${v}.` };
}

export const SIGNAL_P_STRATEGY: SignalStrategy = {
	term: "p",
	label: "P (proportional)",
	start: 30,
	maxAttempts: 12,
	decide(attempts) {
		const last = attempts[attempts.length - 1];
		// Stability veto before anything else — a saturating/hunting capture can swamp the move so
		// badly that no cruise is even detected, so this must precede the has-move check.
		if (signalUnstable(last.signal)) { return backOff(attempts, "P", round(last.value * 0.5)); }
		const best = bestBy(attempts, (s) => s.stats.moveRms);
		if (attempts.length >= 2 && signalDiverging(best.signal, last.signal)) {
			return { kind: "accept", value: best.value, note: `Tracking error diverging at P=${last.value} — settled on ${best.value}.` };
		}
		if (!last.signal.hasMove) { return noMove; }
		// Tracking error at the (measured) encoder noise floor → raising P further only amplifies noise.
		const floor = P_NOISE_FLOOR_K * last.signal.stats.restNoise;
		if (floor > 0 && last.signal.stats.moveRms <= floor) {
			return { kind: "accept", value: last.value, note: `Tracking error ${last.signal.stats.moveRms.toFixed(2)} step rms — at the noise floor (${floor.toFixed(2)}).` };
		}
		// Diminishing returns on tracking error → settle on the best attempt.
		if (attempts.length >= 2) {
			const prevRms = attempts[attempts.length - 2].signal.stats.moveRms;
			const curRms = last.signal.stats.moveRms;
			if (prevRms > 0 && (prevRms - curRms) / prevRms < P_RMS_PLATEAU) {
				return { kind: "accept", value: best.value, note: `Tracking error plateaued (~${curRms.toFixed(2)} step rms).` };
			}
		}
		const next = round(last.value < 100 ? last.value + 20 : last.value * 1.25);
		if (next > P_MAX) { return { kind: "accept", value: last.value, note: `Reached the P limit (${P_MAX}).` }; }
		if (attempts.length >= this.maxAttempts) {
			return { kind: "accept", value: best.value, note: "Max attempts reached." };
		}
		return { kind: "set", value: next, note: `Increasing P to ${next}.` };
	},
};

export const SIGNAL_D_STRATEGY: SignalStrategy = {
	term: "d",
	label: "D (derivative)",
	start: 0,
	maxAttempts: 16,
	decide(attempts) {
		const last = attempts[attempts.length - 1];
		if (signalUnstable(last.signal)) { return backOff(attempts, "D", 0); }
		if (!last.signal.hasMove) { return noMove; }
		const s = last.signal.stats;
		// Critically damped: no real overshoot at the stop and no ringing.
		if (s.settleOvershoot <= OVERSHOOT_GOOD && s.restRing < RING_WARN) {
			return { kind: "accept", value: last.value, note: `Overshoot ${s.settleOvershoot.toFixed(2)} step, ${s.restRing} ring — critically damped.` };
		}
		// D amplifying encoder noise into ring → the previous value was better.
		if (attempts.length >= 2) {
			const prev = attempts[attempts.length - 2];
			if (s.restRing >= RING_WARN && s.restRing > prev.signal.stats.restRing + D_RING_WORSE) {
				return { kind: "accept", value: prev.value, note: `D=${last.value} increased ringing (${s.restRing} cycles) — backed off to ${prev.value}.` };
			}
		}
		const next = round(last.value + (last.value < 0.5 ? 0.01 : 0.025), 3);
		if (next > D_MAX) { return { kind: "accept", value: last.value, note: `Reached the D limit (${D_MAX}).` }; }
		if (attempts.length >= this.maxAttempts) {
			return { kind: "accept", value: bestBy(attempts, (sig) => sig.stats.settleOvershoot).value, note: "Max attempts reached." };
		}
		return { kind: "set", value: next, note: `Increasing D to ${next}.` };
	},
};

export const SIGNAL_I_STRATEGY: SignalStrategy = {
	term: "i",
	label: "I (integral)",
	start: 0,
	maxAttempts: 12,
	decide(attempts) {
		const last = attempts[attempts.length - 1];
		// Integral windup shows up as hunting/ring — vetoed before the bias check.
		if (signalUnstable(last.signal)) { return backOff(attempts, "I", 0); }
		if (!last.signal.hasMove) { return noMove; }
		if (Math.abs(last.signal.stats.restBias) <= REST_GOOD) {
			return { kind: "accept", value: last.value, note: `Standing error ${last.signal.stats.restBias.toFixed(2)} step — settled.` };
		}
		const next = round(last.value <= 0 ? 1000 : last.value * 1.5);
		if (next > I_MAX) { return { kind: "accept", value: last.value, note: `Reached the I limit (${I_MAX}).` }; }
		if (attempts.length >= this.maxAttempts) {
			return { kind: "accept", value: bestBy(attempts, (s) => Math.abs(s.stats.restBias)).value, note: "Max attempts reached." };
		}
		return { kind: "set", value: next, note: `Increasing I to ${next}.` };
	},
};

export const SIGNAL_A_STRATEGY: SignalStrategy = {
	term: "a",
	label: "A (accel feed-forward)",
	start: 0,
	maxAttempts: 10,
	decide(attempts) {
		const last = attempts[attempts.length - 1];
		if (signalUnstable(last.signal)) { return backOff(attempts, "A", 0); }
		if (!last.signal.hasMove) { return noMove; }
		if (attempts.length >= 2) {
			const prev = attempts[attempts.length - 2];
			const pp = prev.signal.pTermAccelPeak;
			const cp = last.signal.pTermAccelPeak;
			if (pp > 0 && (pp - cp) / pp < AV_PLATEAU) {
				// Plateau — but before accepting a non-zero A, check A did anything AT ALL relative to the
				// A=0 baseline. Accepting 50000 because "69 vs 69 plateaued" is a value with zero supporting
				// evidence; if the whole ramp never moved the accel peak past noise, the honest answer is 0.
				const baselinePeak = attempts[0].value === 0 ? attempts[0].signal.pTermAccelPeak : null;
				const bestPeak = Math.min(pp, cp);
				if (baselinePeak != null && baselinePeak > 0 && (baselinePeak - bestPeak) / baselinePeak < A_NO_EFFECT_FRACTION) {
					return { kind: "accept", value: 0, note: `A had no measurable effect on this move (accel peak ${baselinePeak.toFixed(0)} → ${bestPeak.toFixed(0)}) — keeping A=0.` };
				}
				const best = pp <= cp ? prev : last;
				return { kind: "accept", value: best.value, note: `Accel P-term peak plateaued (~${cp.toFixed(0)}).` };
			}
		}
		const next = round(last.value <= 0 ? 50000 : last.value * 1.5);
		if (next > A_MAX) { return { kind: "accept", value: last.value, note: `Reached the A limit (${A_MAX}).` }; }
		if (attempts.length >= this.maxAttempts) {
			return { kind: "accept", value: bestBy(attempts, (s) => s.pTermAccelPeak).value, note: "Max attempts reached." };
		}
		return { kind: "set", value: next, note: `Increasing A to ${next}.` };
	},
};

/** Linear interpolation of the V where cruise-P crosses zero, from two attempts that bracket it. */
export function interpolateVZero(prevValue: number, prevCruise: number, lastValue: number, lastCruise: number): number {
	const denom = Math.abs(prevCruise) + Math.abs(lastCruise);
	if (denom <= 0) { return prevValue; }
	return round(prevValue + ((lastValue - prevValue) * Math.abs(prevCruise)) / denom);
}

export const SIGNAL_V_STRATEGY: SignalStrategy = {
	term: "v",
	label: "V (velocity feed-forward)",
	start: 0,
	maxAttempts: 11,
	decide(attempts) {
		const last = attempts[attempts.length - 1];
		if (signalUnstable(last.signal)) { return backOff(attempts, "V", 0); }
		if (!last.signal.hasMove) { return noMove; }
		const cm = last.signal.pTermCruiseMean;
		const cmAbs = Math.abs(cm);
		if (cmAbs <= V_CRUISE_OK) {
			return { kind: "accept", value: last.value, note: `Steady-speed P-term ~0 (${cm.toFixed(1)}).` };
		}
		// Sign flip between consecutive attempts = the zero crossing was just bracketed — the optimum is
		// the interpolated crossing, NOT further up the ramp. Without this the ramp is sign-blind: a real
		// run watched cruise-P go +13.5 → −9.7 → −46 → −109 → −203 while |cruise-P| kept it multiplying
		// ×1.6 all the way to V_MAX (the "stupidly big V" bug, in its purest form).
		if (attempts.length >= 2) {
			const prev = attempts[attempts.length - 2];
			const pcm = prev.signal.pTermCruiseMean;
			if (pcm !== 0 && cm !== 0 && Math.sign(pcm) !== Math.sign(cm)) {
				const v = interpolateVZero(prev.value, pcm, last.value, cm);
				return { kind: "accept", value: v, note: `Cruise P-term crossed zero (${pcm.toFixed(1)} at V=${prev.value} → ${cm.toFixed(1)} at V=${last.value}) — interpolated V=${v}.` };
			}
		}
		// Only honour a "plateau" once the cruise lag is already small. V reduces the lag monotonically,
		// so two equal-but-large noisy readings early on must NOT stop the ramp — keep raising V until
		// it's near zero, crosses zero, or is capped.
		if (attempts.length >= 2 && cmAbs <= V_CRUISE_OK * 4) {
			const pm = Math.abs(attempts[attempts.length - 2].signal.pTermCruiseMean);
			if (pm > 0 && (pm - cmAbs) / pm < AV_PLATEAU) {
				return { kind: "accept", value: bestBy(attempts, (s) => Math.abs(s.pTermCruiseMean)).value, note: `Steady-speed P-term plateaued (~${cm.toFixed(1)}).` };
			}
		}
		const next = round(last.value <= 0 ? 100 : last.value * 1.6);
		if (next > V_MAX) { return { kind: "accept", value: bestBy(attempts, (s) => Math.abs(s.pTermCruiseMean)).value, note: `Next step would exceed the V limit (${V_MAX}) — settled on the attempt with the smallest cruise P-term.` }; }
		if (attempts.length >= this.maxAttempts) {
			return { kind: "accept", value: bestBy(attempts, (s) => Math.abs(s.pTermCruiseMean)).value, note: "Max attempts reached." };
		}
		return { kind: "set", value: next, note: `Increasing V to ${next}.` };
	},
};

/**
 * Signal-based auto-tune sequence for drivers with an axis: P → A → V → D → I, matching the Duet
 * closed-loop tuning guide's order. Feed-forward (A/V) is tuned right after P and before D/I so the damping and
 * integral terms are judged against the error that's left *after* feed-forward removes what it can —
 * not against error that A/V will later make disappear out from under them.
 */
export const AUTOTUNE_SIGNAL_SEQUENCE: Array<SignalStrategy> = [
	SIGNAL_P_STRATEGY, SIGNAL_A_STRATEGY, SIGNAL_V_STRATEGY, SIGNAL_D_STRATEGY, SIGNAL_I_STRATEGY,
];
