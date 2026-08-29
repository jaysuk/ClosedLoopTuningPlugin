/**
 * "Package"/joint PID optimisation — coordinate-descent (Twiddle-style) pattern search over the whole
 * gain vector at once, minimising the single whole-loop `signalCost` (src/model/signal.ts) instead of
 * one term-specific metric at a time. This is what the original plugin author meant by tuning "as a
 * complete package": a change to D can only be judged good or bad by its effect on the WHOLE capture,
 * not by D's own overshoot metric in isolation, because P/A/V/I all interact with it.
 *
 * Chosen over other gradient-free searches (Nelder-Mead, simulated annealing) because it maps 1:1 onto
 * the existing "set value → capture → decide" effects loop used everywhere else in this plugin: one
 * probe per term per pass, trivially bounded by a capture budget, and every intermediate PID applied to
 * the driver is a small, physically-continuous nudge from a known-working point — never a random
 * restart. It reuses the exact same stability veto as the ramp/refine paths (`signalCost` is Infinity
 * for any `signalUnstable` capture, so an unstable probe can never look like an improvement) — this is
 * a smarter search, not a looser safety net.
 *
 * Algorithm (classic Twiddle): each term has its own step size, initialised to a fraction of its current
 * value. Each pass, for every term in turn: probe `value+step`; if that's a significant improvement,
 * keep it and grow the step (explore faster in a direction that's working); otherwise probe
 * `value-step`; if THAT helps, keep it and grow the step; otherwise revert to the original value and
 * shrink the step (we overshot the optimum in both directions — take smaller steps next time).
 * Terminates when every term's step has shrunk below its convergence floor, or the capture budget runs
 * out, or the run is cancelled.
 */
import type { PidConfig } from "./m569";
import { describeSignal, significantlyBetterForTerm, type TuneSignal } from "./signal";
import {
	captureMedian, clampTerm, ROUND_DP, SETTLE_DELAY_MS, TERM_MAX, ZERO_START, type AutoRunAttempt, type TuneEffects,
} from "./tuneShared";
import type { PidTerm } from "./wizard";

export interface PackageOptimizeOptions {
	/** Terms to include in the search, probed in this order each pass. Default all five. */
	terms?: Array<PidTerm>;
	/** Total captures to spend before stopping regardless of convergence. Default 40. */
	captureBudget?: number;
	/** Captures per decision, median-combined to reject one-off glitches. Default 1. */
	medianOf?: number;
	/** Stop a term's search once its step shrinks below this fraction of its value. Default 2%. */
	convergeFraction?: number;
	/**
	 * Terms an earlier identification pass already found to have no measurable effect (e.g. model-fit's
	 * `FeedForwardSolveResult.measurable === false` for A/V). These still get probed here — the joint
	 * whole-capture cost can see interactions a single term's own metric can't — but starting AT the
	 * convergence floor instead of the usual 25%-of-scale step means one confirming probe settles them
	 * (instead of the 3-4 passes a full geometric shrink needs), leaving more of the capture budget for
	 * terms that actually move the whole-loop cost.
	 */
	insensitiveTerms?: Array<PidTerm>;
}

export interface PackageOptimizeResult {
	ok: boolean;
	reason?: string;
	attempts: Array<AutoRunAttempt>;
	/** Captures actually spent (counts every capture inside a `medianOf` group). */
	captures: number;
	/** The signal behind the settled PID vector this call ends on. */
	finalSignal?: TuneSignal;
}

const DEFAULT_TERMS: Array<PidTerm> = ["p", "d", "i", "a", "v"];
const CAPTURE_BUDGET_DEFAULT = 40;
const CONVERGE_FRACTION_DEFAULT = 0.02;
const STEP_GROW = 1.5;
const STEP_SHRINK = 0.5;
const INITIAL_STEP_FRACTION = 0.25;
/** Absolute step-size floor per term (steps stop shrinking below this even at convergeFraction=0). */
const MIN_STEP: Record<PidTerm, number> = { p: 0.5, i: 5, d: 0.0005, a: 250, v: 1 };

function round(v: number, dp: number): number {
	const f = Math.pow(10, dp);
	return Math.round(v * f) / f;
}

function initialStep(term: PidTerm, value: number): number {
	return (value > 0 ? value : ZERO_START[term]) * INITIAL_STEP_FRACTION;
}

function termFloor(term: PidTerm, value: number, convergeFraction: number): number {
	return Math.max(MIN_STEP[term], (value || ZERO_START[term]) * convergeFraction);
}

/**
 * Coordinate-descent search over `terms`, mutating `pid` in place exactly like every other orchestrator
 * in this plugin, and returning once it converges, exhausts its capture budget, or is cancelled. Never
 * throws on a capture failure mid-search — if a probe capture fails, that probe is simply treated as "no
 * improvement" (the term's step shrinks) so a single flaky capture can't derail the whole pass; only a
 * FAILED BASELINE capture (nothing to compare against at all) is a hard stop.
 */
export async function runPackageOptimize(
	effects: TuneEffects, pid: PidConfig, opts: PackageOptimizeOptions = {},
): Promise<PackageOptimizeResult> {
	const terms = opts.terms ?? DEFAULT_TERMS;
	const budget = Math.max(terms.length, opts.captureBudget ?? CAPTURE_BUDGET_DEFAULT);
	const medianOf = Math.max(1, opts.medianOf ?? 1);
	const convergeFraction = opts.convergeFraction ?? CONVERGE_FRACTION_DEFAULT;
	const insensitive = new Set(opts.insensitiveTerms ?? []);

	const attempts: Array<AutoRunAttempt> = [];
	let captures = 0;

	const capture = async (): Promise<TuneSignal | null> => {
		await effects.applyPid(pid);
		await effects.delay(SETTLE_DELAY_MS);
		const signal = await captureMedian(effects, medianOf);
		captures += medianOf;
		return signal;
	};

	if (effects.isCancelled()) { return { ok: false, reason: "Cancelled.", attempts, captures }; }
	effects.status("Package optimise: capturing baseline…");
	let current = await capture();
	if (!current) { return { ok: false, reason: "Package optimise: baseline capture failed.", attempts, captures }; }
	effects.log(`Package optimise: baseline → ${describeSignal(current)}`);

	const step: Partial<Record<PidTerm, number>> = {};
	for (const t of terms) {
		step[t] = insensitive.has(t) ? termFloor(t, pid[t], convergeFraction) : initialStep(t, pid[t]);
	}
	const seededSmall = terms.filter((t) => insensitive.has(t));
	if (seededSmall.length) {
		effects.log(`Package optimise: starting ${seededSmall.map((t) => t.toUpperCase()).join(", ")} from a smaller step — an earlier identification pass found no measurable effect.`);
	}

	const probe = async (term: PidTerm, value: number): Promise<TuneSignal | null> => {
		pid[term] = value;
		const signal = await capture();
		attempts.push({ term, value });
		effects.onAttempt?.(term, value, signal ?? current!);
		effects.log(signal ? `Package ${term.toUpperCase()}=${value} → ${describeSignal(signal)}` : `Package ${term.toUpperCase()}=${value} → capture failed.`);
		return signal;
	};

	while (captures < budget) {
		if (effects.isCancelled()) { return { ok: false, reason: "Cancelled.", attempts, captures, finalSignal: current }; }
		let anyActive = false;
		for (const term of terms) {
			if (effects.isCancelled()) { return { ok: false, reason: "Cancelled.", attempts, captures, finalSignal: current }; }
			if (captures >= budget) { break; }
			const s = step[term]!;
			const floor = termFloor(term, pid[term], convergeFraction);
			if (s < floor) { continue; }
			anyActive = true;

			const original = pid[term];
			const dp = ROUND_DP[term];
			let improved = false;

			const upValue = clampTerm(term, round(original + s, dp));
			if (upValue !== original) {
				const upSignal = await probe(term, upValue);
				if (upSignal && significantlyBetterForTerm(term, current, upSignal)) {
					current = upSignal; step[term] = Math.min(s * STEP_GROW, TERM_MAX[term]); improved = true;
				}
			}
			if (!improved) {
				const downValue = clampTerm(term, round(Math.max(0, original - s), dp));
				if (downValue !== original && captures < budget) {
					const downSignal = await probe(term, downValue);
					if (downSignal && significantlyBetterForTerm(term, current, downSignal)) {
						current = downSignal; step[term] = Math.min(s * STEP_GROW, TERM_MAX[term]); improved = true;
					}
				}
			}
			if (!improved) {
				pid[term] = original; // revert — neither direction beat the current baseline
				step[term] = s * STEP_SHRINK;
			}
		}
		if (!anyActive) {
			effects.log("Package optimise: every term's step has converged.");
			break;
		}
	}
	if (captures >= budget) { effects.log("Package optimise: capture budget exhausted — stopping with the best values found so far."); }

	const finalValues = terms.map((t) => `${t.toUpperCase()}=${round(pid[t], ROUND_DP[t])}`).join(", ");
	effects.log(`Package optimise: final values — ${finalValues}.`);

	// pid already holds the settled (best-known) vector; re-apply it so the driver matches `current` even
	// if the last probe inside the loop above ended on a reverted value.
	await effects.applyPid(pid);
	return { ok: true, attempts, captures, finalSignal: current };
}
