/**
 * Capture EVALUATION engine — turns a closed-loop capture into a plain-language verdict so the user
 * doesn't have to interpret the graph themselves. Pure and unit-tested (no DWC/Vue imports).
 *
 * It segments the move from the commanded target velocity (rest / acceleration / steady-speed) and
 * grades each region against absolute thresholds in MOTOR STEPS — the meaningful unit for closed loop,
 * where a good drive holds the error to a small fraction of a step. Each issue it finds names the term
 * to change and the direction, mirroring the auto-tuner's own logic:
 *   bias at rest → I · lag at steady speed → V · spikes in accel/decel → A · overshoot → D · ringing → P↓/D↑
 */
import { buildSeries } from "./analysis";
import type { ParsedCapture } from "./csv";

export type Severity = "good" | "info" | "warn" | "bad";
export type Grade = "excellent" | "good" | "fair" | "poor" | "unknown";
export type Term = "p" | "i" | "d" | "a" | "v";

export interface Finding {
	severity: Severity;
	/** Short headline, e.g. "Lags at steady speed". */
	title: string;
	/** One-sentence explanation with the measured number. */
	detail: string;
	/** Actionable fix, e.g. "Raise V (velocity feed-forward)". */
	fix?: string;
	term?: Term;
	direction?: "up" | "down";
}

export interface TuneStats {
	/** Mean signed error while the motor is stopped (the standing offset). */
	restBias: number;
	/** Std-dev of error while stopped (encoder noise floor). */
	restNoise: number;
	/** Significant oscillation cycles after the motor stops (ringing). */
	restRing: number;
	/** Peak |error| in the moment the move stops (overshoot). */
	settleOvershoot: number;
	/** Mean signed error during the steady-speed section (velocity lag). */
	cruiseLag: number;
	/** Peak |error| during acceleration / deceleration. */
	accelPeak: number;
	/** Peak |error| over the whole moving portion. */
	movePeak: number;
	/** RMS error over the whole moving portion. */
	moveRms: number;
	/** Samples classed as steady-speed (confidence). */
	cruiseSamples: number;
	/** Samples classed as at-rest (confidence). */
	restSamples: number;
	/** Whether any commanded movement was detected. */
	moved: boolean;
}

export interface TuneEvaluation {
	grade: Grade;
	/** 0–100. */
	score: number;
	/** One-line verdict the UI shows big. */
	headline: string;
	findings: Array<Finding>;
	stats: TuneStats;
}

// Thresholds in motor steps. Tuned to the Duet 1HCL wiki's "good" guidance (error a small fraction of
// a step at rest) while staying tolerant of the high-frequency encoder fuzz that's always present.
const REST_GOOD = 0.25;
const REST_FAIR = 0.6;
const CRUISE_GOOD = 0.35;
const CRUISE_FAIR = 1.0;
const ACCEL_GOOD = 1.2;
const ACCEL_FAIR = 3.0;
const OVERSHOOT_GOOD = 1.0;
const OVERSHOOT_FAIR = 2.5;
const RING_WARN = 4;       // significant oscillation cycles after stop

function mean(a: Array<number>): number { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function std(a: Array<number>): number {
	if (a.length < 2) { return 0; }
	const m = mean(a);
	return Math.sqrt(mean(a.map((x) => (x - m) * (x - m))));
}
function peak(a: Array<number>): number { return a.reduce((x, y) => Math.max(x, Math.abs(y)), 0); }
function rms(a: Array<number>): number { return a.length ? Math.sqrt(mean(a.map((x) => x * x))) : 0; }

/** Amplitude-gated oscillation count (ignores noise jitter, like the step analyser). */
function ringCount(err: Array<number>, threshold: number): number {
	let count = 0, prevSign = 0, half = 0;
	for (const e of err) {
		half = Math.max(half, Math.abs(e));
		const s = Math.sign(e);
		if (s !== 0 && prevSign !== 0 && s !== prevSign) {
			if (half >= threshold) { count++; }
			half = 0;
		}
		if (s !== 0) { prevSign = s; }
	}
	return count;
}

const empty: TuneStats = {
	restBias: 0, restNoise: 0, restRing: 0, settleOvershoot: 0, cruiseLag: 0,
	accelPeak: 0, movePeak: 0, moveRms: 0, cruiseSamples: 0, restSamples: 0, moved: false,
};

/** Compute the per-region error statistics from a capture. */
export function tuneStats(capture: ParsedCapture, sampleRateHz: number): TuneStats {
	const series = buildSeries(capture, sampleRateHz);
	if (!series) { return empty; }
	const { time, measured, target } = series;
	const n = measured.length;
	const error = measured.map((m, i) => m - target[i]);

	const dtOf = (i: number) => (time[i] - time[i - 1]) || (sampleRateHz > 0 ? 1 / sampleRateHz : 1);
	const vel: Array<number> = [0];
	for (let i = 1; i < n; i++) { vel.push((target[i] - target[i - 1]) / dtOf(i)); }
	const absVel = vel.map(Math.abs);
	const maxV = peak(absVel);
	if (maxV <= 1e-6) {
		// No commanded motion — judge the standing error only.
		const restNoise = std(error);
		return { ...empty, restBias: mean(error), restNoise, restRing: ringCount(error, Math.max(0.3, 3 * restNoise)), restSamples: n };
	}
	const acc: Array<number> = [0];
	for (let i = 1; i < n; i++) { acc.push((vel[i] - vel[i - 1]) / dtOf(i)); }
	const maxA = peak(acc) || 1e-9;
	const moveDir = Math.sign(target[n - 1] - target[0]) || 1;

	const restErr: Array<number> = [];
	const cruiseErr: Array<number> = [];
	const accelErr: Array<number> = [];
	const moveErr: Array<number> = [];
	// Index after which the motor is stopped for good (target velocity stays ~0 to the end).
	let lastMoving = 0;
	for (let i = 0; i < n; i++) { if (absVel[i] >= 0.08 * maxV) { lastMoving = i; } }

	for (let i = 1; i < n; i++) {
		const v = absVel[i], a = Math.abs(acc[i]), e = error[i];
		if (i > lastMoving) { restErr.push(e); continue; }
		moveErr.push(e);
		if (v >= 0.6 * maxV && a < 0.2 * maxA) { cruiseErr.push(e); }
		else if (a >= 0.3 * maxA && v > 0.1 * maxV) { accelErr.push(e); }
	}

	const restNoise = std(restErr);
	// Overshoot: the worst error (in the move direction) in the first slice after the motor stops.
	const settleWindow = restErr.slice(0, Math.max(3, Math.round(restErr.length * 0.25)));
	const settleOvershoot = settleWindow.reduce((mx, e) => (moveDir * e > 0 ? Math.max(mx, Math.abs(e)) : mx), 0);

	return {
		restBias: mean(restErr),
		restNoise,
		restRing: ringCount(restErr, Math.max(0.3, 3 * restNoise)),
		settleOvershoot,
		cruiseLag: mean(cruiseErr),
		accelPeak: peak(accelErr),
		movePeak: peak(moveErr),
		moveRms: rms(moveErr),
		cruiseSamples: cruiseErr.length,
		restSamples: restErr.length,
		moved: true,
	};
}

/** Grade a capture and produce plain-language, actionable findings. */
export function evaluateTune(capture: ParsedCapture, sampleRateHz: number): TuneEvaluation {
	const series = buildSeries(capture, sampleRateHz);
	if (!series) {
		return { grade: "unknown", score: 0, headline: "Couldn't read this capture — record Measured + Target Motor Steps.", findings: [], stats: empty };
	}
	const s = tuneStats(capture, sampleRateHz);
	const findings: Array<Finding> = [];
	let score = 100;
	const penalise = (sev: Severity) => { score -= sev === "bad" ? 34 : sev === "warn" ? 15 : sev === "info" ? 3 : 0; };
	const add = (f: Finding) => { findings.push(f); penalise(f.severity); };

	if (!s.moved) {
		const sev: Severity = Math.abs(s.restBias) > REST_FAIR ? "bad" : Math.abs(s.restBias) > REST_GOOD ? "warn" : "good";
		add({
			severity: sev,
			title: "No movement detected",
			detail: `This capture has no commanded move. Standing error ${s.restBias.toFixed(2)} step. Run a test move to evaluate tracking.`,
			...(sev !== "good" ? { fix: "Raise I (integral)", term: "i", direction: "up" } : {}),
		});
		return finalise(findings, score, s);
	}

	// 1. Standing error at rest (integral term).
	{
		const b = Math.abs(s.restBias);
		if (b > REST_FAIR) { add({ severity: "bad", title: "Standing error at rest", detail: `The motor settles ${s.restBias.toFixed(2)} step away from target — it isn't reaching the commanded position.`, fix: "Raise I (integral)", term: "i", direction: "up" }); }
		else if (b > REST_GOOD) { add({ severity: "warn", title: "Slight standing error", detail: `Settles ${s.restBias.toFixed(2)} step off target.`, fix: "Raise I (integral) a little", term: "i", direction: "up" }); }
		else { add({ severity: "good", title: "Reaches target", detail: `Settles to within ${b.toFixed(2)} step of target — no standing offset.` }); }
	}

	// 2. Steady-speed lag (velocity feed-forward).
	if (s.cruiseSamples >= 3) {
		const c = Math.abs(s.cruiseLag);
		if (c > CRUISE_FAIR) { add({ severity: "warn", title: "Lags at steady speed", detail: `Trails the target by ${s.cruiseLag.toFixed(2)} step while cruising.`, fix: "Raise V (velocity feed-forward)", term: "v", direction: "up" }); }
		else if (c > CRUISE_GOOD) { add({ severity: "info", title: "Small cruise lag", detail: `Trails by ${s.cruiseLag.toFixed(2)} step at speed.`, fix: "Raise V (velocity feed-forward) slightly", term: "v", direction: "up" }); }
		else { add({ severity: "good", title: "Tracks at speed", detail: `Holds within ${c.toFixed(2)} step during steady-speed motion.` }); }
	}

	// 3. Acceleration / deceleration spikes (acceleration feed-forward).
	if (s.accelPeak > 0) {
		if (s.accelPeak > ACCEL_FAIR) { add({ severity: "warn", title: "Spikes during accel/decel", detail: `Error reaches ${s.accelPeak.toFixed(2)} step at the start/stop of the move.`, fix: "Raise A (acceleration feed-forward)", term: "a", direction: "up" }); }
		else if (s.accelPeak > ACCEL_GOOD) { add({ severity: "info", title: "Mild accel/decel transients", detail: `Up to ${s.accelPeak.toFixed(2)} step during accel/decel — usually fine.` }); }
	}

	// 4. Overshoot at the stop (derivative term).
	if (s.settleOvershoot > OVERSHOOT_FAIR) { add({ severity: "warn", title: "Overshoots the target", detail: `Overshoots by ${s.settleOvershoot.toFixed(2)} step before settling.`, fix: "Raise D (derivative)", term: "d", direction: "up" }); }
	else if (s.settleOvershoot > OVERSHOOT_GOOD) { add({ severity: "info", title: "Slight overshoot", detail: `Overshoots ${s.settleOvershoot.toFixed(2)} step then settles.`, fix: "A touch more D (derivative)", term: "d", direction: "up" }); }

	// 5. Ringing after the stop (too much P / too little D).
	if (s.restRing >= RING_WARN) { add({ severity: "warn", title: "Rings after stopping", detail: `${s.restRing} oscillation cycles after the move stops — the loop is under-damped.`, fix: "Lower P, or raise D (derivative)", term: "p", direction: "down" }); }

	// 6. Encoder noise floor (informational, never penalised badly).
	if (s.restNoise > 0) { add({ severity: "good", title: "Encoder noise floor", detail: `±${s.restNoise.toFixed(2)} step of high-frequency fuzz at rest — normal for the encoder resolution.` }); }

	return finalise(findings, score, s);
}

function finalise(findings: Array<Finding>, rawScore: number, stats: TuneStats): TuneEvaluation {
	const score = Math.max(0, Math.min(100, Math.round(rawScore)));
	const hasBad = findings.some((f) => f.severity === "bad");
	const hasWarn = findings.some((f) => f.severity === "warn");
	let grade: Grade;
	if (!stats.moved && findings.every((f) => f.severity === "good")) { grade = "good"; }
	else if (hasBad) { grade = score >= 45 ? "fair" : "poor"; }
	else if (hasWarn) { grade = score >= 80 ? "good" : "fair"; }
	else { grade = score >= 90 ? "excellent" : "good"; }

	const topIssue = findings.find((f) => f.severity === "bad") ?? findings.find((f) => f.severity === "warn");
	const headline = grade === "excellent" ? "Excellent tune — the motor tracks tightly with no standing error."
		: grade === "good" ? (topIssue ? `Good tune — minor point: ${topIssue.title.toLowerCase()}.` : "Good tune — well within tolerance.")
		: grade === "fair" ? `Usable, but could be better${topIssue ? ` — ${topIssue.title.toLowerCase()}` : ""}.`
		: grade === "poor" ? `Needs more work${topIssue ? ` — ${topIssue.title.toLowerCase()}` : ""}.`
		: "Couldn't grade this capture.";
	return { grade, score, headline, findings, stats };
}

/** Vuetify colour / alert type for a grade. */
export function gradeColor(grade: Grade): string {
	switch (grade) {
		case "excellent": return "success";
		case "good": return "success";
		case "fair": return "warning";
		case "poor": return "error";
		default: return "info";
	}
}

/** Vuetify colour for a finding severity. */
export function severityColor(sev: Severity): string {
	switch (sev) {
		case "good": return "success";
		case "info": return "info";
		case "warn": return "warning";
		case "bad": return "error";
	}
}

/** Icon for a finding severity. */
export function severityIcon(sev: Severity): string {
	switch (sev) {
		case "good": return "mdi-check-circle";
		case "info": return "mdi-information";
		case "warn": return "mdi-alert";
		case "bad": return "mdi-close-circle";
	}
}
