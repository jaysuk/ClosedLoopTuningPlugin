/**
 * Guided tuning wizard logic, distilled from the Duet 1HCL tuning guide. Pure + unit-tested — the UI
 * walks these steps, runs a capture between each, feeds the analysis metrics into `recommend()`, and
 * shows the advice. Duet removed the fully-automatic tuner, so this assists rather than fully automates:
 * each step measures the step response and recommends increasing/decreasing/accepting the term.
 *
 * Order follows the guide: P (rise time) → D (overshoot / critical damping) → I (steady-state error),
 * with A and V offered as advanced feed-forward steps (these need steady-speed G1 moves to judge, so
 * they give guidance rather than an auto-recommendation).
 */
import type { StepMetrics } from "./analysis";
import type { PidValues } from "./m569";

export type PidTerm = keyof PidValues; // "p" | "i" | "d" | "v" | "a"

export type Verdict = "increase" | "decrease" | "accept" | "info";

export interface Recommendation {
	verdict: Verdict;
	message: string;
	/** Suggested next value for the step's term, when the verdict is increase/decrease. */
	suggested?: number;
}

export interface WizardStep {
	id: string;
	/** The PID term this step tunes (null for the intro/finish steps). */
	term: PidTerm | null;
	title: string;
	goal: string;
	instructions: string;
	/** Recommended starting value for this term when the step is first entered. */
	defaultStart?: number;
	/** Variable keys to record for this step's capture (see CAPTURE_VARIABLES). */
	recordKeys: Array<string>;
	/** Turn analysis metrics + the current term value into advice. */
	recommend(metrics: StepMetrics | null, current: number): Recommendation;
}

const STEP_RECORD = ["measuredMotorSteps", "targetMotorSteps", "currentError", "pidPTerm"];

function needStep(metrics: StepMetrics | null): Recommendation | null {
	if (!metrics) {
		return { verdict: "info", message: "Run a Step capture to measure the response." };
	}
	if (!metrics.hasStep) {
		return { verdict: "info", message: "No clear step detected in the capture — use the Step manoeuvre and record Measured + Target Motor Steps." };
	}
	return null;
}

export const WIZARD_STEPS: Array<WizardStep> = [
	{
		id: "p",
		term: "p",
		title: "Tune P (proportional)",
		goal: "Fastest rise time without oscillation",
		instructions: "Start with P≈30 and I, D, V, A all zero. Increase P until the rise time stops improving or the response starts to oscillate, then back off slightly.",
		defaultStart: 30,
		recordKeys: STEP_RECORD,
		recommend(metrics, current) {
			const pre = needStep(metrics);
			if (pre) { return pre; }
			const m = metrics as StepMetrics;
			if (m.oscillations >= 8 || m.overshootPct > 40) {
				return { verdict: "decrease", message: `P=${current} is oscillating (overshoot ${m.overshootPct.toFixed(0)}%). Reduce it.`, suggested: round(current * 0.7) };
			}
			if (m.riseTime === null || m.riseTime > 0.03) {
				return { verdict: "increase", message: `Rise time is ${m.riseTime === null ? "unclear" : (m.riseTime * 1000).toFixed(0) + " ms"} — increase P for a faster response.`, suggested: round(current < 100 ? current + 20 : current * 1.25) };
			}
			return { verdict: "accept", message: `Good rise time (${(m.riseTime * 1000).toFixed(0)} ms) with little oscillation. Keep P=${current} (or drop ~30% for a quieter motor before tuning the rest).` };
		},
	},
	{
		id: "d",
		term: "d",
		title: "Tune D (derivative)",
		goal: "Critically damped — no overshoot, lowest D",
		instructions: "Increase D until overshoot just disappears (critically damped). Too high a D makes the motor noisy and can cause runaway oscillation, so use the lowest value that works.",
		defaultStart: 0,
		recordKeys: STEP_RECORD,
		recommend(metrics, current) {
			const pre = needStep(metrics);
			if (pre) { return pre; }
			const m = metrics as StepMetrics;
			if (m.overshootPct > 8) {
				return { verdict: "increase", message: `Overshoot is ${m.overshootPct.toFixed(0)}% — increase D to damp it.`, suggested: round(current + (current < 0.5 ? 0.01 : 0.025), 3) };
			}
			if (m.oscillations >= 12) {
				return { verdict: "decrease", message: `D=${current} looks too high (ringing/noise). Reduce it.`, suggested: round(Math.max(0, current - 0.025), 3) };
			}
			return { verdict: "accept", message: `Overshoot is ${m.overshootPct.toFixed(0)}% — critically damped. Keep D=${current}.` };
		},
	},
	{
		id: "i",
		term: "i",
		title: "Tune I (integral)",
		goal: "Drive steady-state error to zero",
		instructions: "Increase I to remove the residual (steady-state) error after the move settles. Too large an I will make the position oscillate.",
		defaultStart: 0,
		recordKeys: STEP_RECORD,
		recommend(metrics, current) {
			const pre = needStep(metrics);
			if (pre) { return pre; }
			const m = metrics as StepMetrics;
			if (Math.abs(m.steadyStateError) > 0.1) {
				return { verdict: "increase", message: `Steady-state error is ${m.steadyStateError.toFixed(2)} steps — increase I to remove it.`, suggested: round(current <= 0 ? 1000 : current * 1.5) };
			}
			if (m.oscillations >= 14) {
				return { verdict: "decrease", message: `I=${current} is causing oscillation — reduce it.`, suggested: round(current * 0.6) };
			}
			return { verdict: "accept", message: `Steady-state error is ${m.steadyStateError.toFixed(2)} steps — settled. Keep I=${current}.` };
		},
	},
	{
		id: "a",
		term: "a",
		title: "Tune A (acceleration feed-forward) — advanced",
		goal: "Reduce P-term peaks during accel/decel",
		instructions: "Use a G1 move (not the step manoeuvre) long enough to reach steady speed. Increase A to flatten the P-term peaks during the acceleration and deceleration segments. Typical values are in the 100000–200000 range.",
		defaultStart: 0,
		recordKeys: ["measuredMotorSteps", "targetMotorSteps", "pidPTerm"],
		recommend() {
			return { verdict: "info", message: "Record a G1 move and watch the PID P term: raise A until the peaks at the start/end of the move flatten out." };
		},
	},
	{
		id: "v",
		term: "v",
		title: "Tune V (velocity feed-forward) — advanced",
		goal: "Reduce average P-term during steady speed",
		instructions: "With a steady-speed G1 move, increase V until the average PID P term during the constant-speed section is close to zero.",
		defaultStart: 0,
		recordKeys: ["measuredMotorSteps", "targetMotorSteps", "pidPTerm"],
		recommend() {
			return { verdict: "info", message: "Record a G1 move and watch the PID P term: raise V until its average during the steady-speed section sits near zero." };
		},
	},
];

function round(v: number, dp = 2): number {
	const f = Math.pow(10, dp);
	return Math.round(v * f) / f;
}
