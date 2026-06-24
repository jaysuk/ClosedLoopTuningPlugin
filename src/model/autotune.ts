/**
 * Automatic PID tuning controller (pure decision logic — unit-tested).
 *
 * Duet removed their auto-tuner, so this drives the documented manual procedure automatically: for
 * each term in turn (P → D → I) it repeatedly sets a value, runs a step-response capture, reads the
 * analysis metrics, and decides whether to increase, accept, or back off. The UI supplies the
 * capture+analysis side effect; this module only decides the next move, so it's deterministic and
 * testable. Every term is bounded (value caps + max attempts) and backs off on oscillation for safety.
 */
import type { MoveMetrics, StepMetrics } from "./analysis";
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

/** The fastest (lowest rise time) attempt that wasn't oscillating. */
function bestStable(attempts: Array<Attempt>): Attempt | null {
	let best: Attempt | null = null;
	for (const a of attempts) {
		if (!a.metrics.hasStep || a.metrics.oscillations >= P_OSC_LIMIT || a.metrics.overshootPct > 60) { continue; }
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
		// Oscillating / large overshoot → P too high; fall back to the last stable value.
		if (last.metrics.oscillations >= P_OSC_LIMIT || last.metrics.overshootPct > 60) {
			const prior = [...attempts].slice(0, -1).reverse().find((a) => a.metrics.oscillations < P_OSC_LIMIT && a.metrics.overshootPct <= 60);
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
		if (last.metrics.overshootPct <= D_OVERSHOOT_OK) {
			return { kind: "accept", value: last.value, note: `Overshoot ${last.metrics.overshootPct.toFixed(0)}% — critically damped.` };
		}
		if (last.metrics.oscillations >= D_OSC_LIMIT) {
			const v = attempts.length >= 2 ? attempts[attempts.length - 2].value : round(Math.max(0, last.value - 0.05), 3);
			return { kind: "accept", value: v, note: `D=${last.value} caused ringing — backed off to ${v}.` };
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
		if (Math.abs(last.metrics.steadyStateError) <= I_SSE_OK) {
			return { kind: "accept", value: last.value, note: `Steady-state error ${last.metrics.steadyStateError.toFixed(2)} — settled.` };
		}
		if (last.metrics.oscillations >= I_OSC_LIMIT) {
			const v = attempts.length >= 2 ? attempts[attempts.length - 2].value : round(last.value * 0.6);
			return { kind: "accept", value: v, note: `I=${last.value} caused oscillation — backed off to ${v}.` };
		}
		const next = round(last.value <= 0 ? 1000 : last.value * 1.5);
		if (next > I_MAX) { return { kind: "accept", value: last.value, note: `Reached the I limit (${I_MAX}).` }; }
		if (attempts.length >= this.maxAttempts) { return { kind: "accept", value: last.value, note: "Max attempts reached." }; }
		return { kind: "set", value: next, note: `Increasing I to ${next}.` };
	},
};

/** The step-response auto-tune sequence: P, then D, then I. */
export const AUTOTUNE_SEQUENCE: Array<TermStrategy> = [P_STRATEGY, D_STRATEGY, I_STRATEGY];

/** One-line summary of a step capture's metrics for the auto-tune log. */
export function describeMetrics(m: StepMetrics): string {
	const rise = m.riseTime == null ? "—" : `${(m.riseTime * 1000).toFixed(0)}ms`;
	return `rise ${rise}, overshoot ${m.overshootPct.toFixed(0)}%, ss-err ${m.steadyStateError.toFixed(2)}, osc ${m.oscillations}`;
}

// ---- Feed-forward (A / V) auto-tune, driven by a G1 MOVE capture (MoveMetrics) ----

export interface MoveAttempt {
	value: number;
	metrics: MoveMetrics;
}

export interface MoveTermStrategy {
	term: PidTerm;
	label: string;
	start: number;
	maxAttempts: number;
	decide(attempts: Array<MoveAttempt>): AutoDecision;
}

export const A_MAX = 2_000_000;
export const V_MAX = 10000;
export const AV_PLATEAU = 0.05;       // <5% improvement → stop raising (push further before settling)
export const V_CRUISE_OK = 3;         // |mean P term| in cruise considered ~zero

const noMove: AutoDecision = { kind: "fail", reason: "No steady-speed move detected — increase the A/V test move length or speed so the axis reaches cruise." };

/** Attempt with the smallest metric (e.g. accel peak / |cruise mean|). */
function bestMove(attempts: Array<MoveAttempt>, metric: (m: MoveMetrics) => number): MoveAttempt {
	return attempts.reduce((best, a) => (metric(a.metrics) < metric(best.metrics) ? a : best), attempts[0]);
}

export const A_STRATEGY: MoveTermStrategy = {
	term: "a",
	label: "A (accel feed-forward)",
	start: 0,
	maxAttempts: 10,
	decide(attempts) {
		const last = attempts[attempts.length - 1];
		if (!last.metrics.hasMove) { return noMove; }
		if (attempts.length >= 2) {
			const prev = attempts[attempts.length - 2];
			const pp = prev.metrics.pTermAccelPeak;
			const cp = last.metrics.pTermAccelPeak;
			if (pp > 0 && (pp - cp) / pp < AV_PLATEAU) {
				const best = pp <= cp ? prev : last;
				return { kind: "accept", value: best.value, note: `Accel P-term peak plateaued (~${cp.toFixed(0)}).` };
			}
		}
		const next = round(last.value <= 0 ? 50000 : last.value * 2);
		if (next > A_MAX) { return { kind: "accept", value: last.value, note: `Reached the A limit (${A_MAX}).` }; }
		if (attempts.length >= this.maxAttempts) {
			const best = bestMove(attempts, (m) => m.pTermAccelPeak);
			return { kind: "accept", value: best.value, note: "Max attempts reached." };
		}
		return { kind: "set", value: next, note: `Increasing A to ${next}.` };
	},
};

export const V_STRATEGY: MoveTermStrategy = {
	term: "v",
	label: "V (velocity feed-forward)",
	start: 0,
	maxAttempts: 11,
	decide(attempts) {
		const last = attempts[attempts.length - 1];
		if (!last.metrics.hasMove) { return noMove; }
		if (Math.abs(last.metrics.pTermCruiseMean) <= V_CRUISE_OK) {
			return { kind: "accept", value: last.value, note: `Steady-speed P-term ~0 (${last.metrics.pTermCruiseMean.toFixed(1)}).` };
		}
		if (attempts.length >= 2) {
			const pm = Math.abs(attempts[attempts.length - 2].metrics.pTermCruiseMean);
			const cm = Math.abs(last.metrics.pTermCruiseMean);
			if (pm > 0 && (pm - cm) / pm < AV_PLATEAU) {
				const best = bestMove(attempts, (m) => Math.abs(m.pTermCruiseMean));
				return { kind: "accept", value: best.value, note: `Steady-speed P-term plateaued (~${last.metrics.pTermCruiseMean.toFixed(1)}).` };
			}
		}
		const next = round(last.value <= 0 ? 100 : last.value * 1.6);
		if (next > V_MAX) { return { kind: "accept", value: last.value, note: `Reached the V limit (${V_MAX}).` }; }
		if (attempts.length >= this.maxAttempts) {
			const best = bestMove(attempts, (m) => Math.abs(m.pTermCruiseMean));
			return { kind: "accept", value: best.value, note: "Max attempts reached." };
		}
		return { kind: "set", value: next, note: `Increasing V to ${next}.` };
	},
};

/** Feed-forward auto-tune sequence (needs a G1 move + an axis): A, then V. */
export const AUTOTUNE_FF_SEQUENCE: Array<MoveTermStrategy> = [A_STRATEGY, V_STRATEGY];

/** One-line summary of a move capture's metrics for the auto-tune log. */
export function describeMove(m: MoveMetrics): string {
	return `accel peak ${m.pTermAccelPeak.toFixed(0)}, cruise mean ${m.pTermCruiseMean.toFixed(1)}`;
}
