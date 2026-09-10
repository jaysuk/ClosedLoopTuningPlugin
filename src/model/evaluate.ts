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
import {
	buildSeries, computeRestEffort, dithersAtStandstill, REST_TAIL_FRACTION, REST_TAIL_MIN_SAMPLES, segmentMove,
} from "./analysis";
import type { ParsedCapture } from "./csv";
import type { Vibration } from "./vibration";

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
	/** Std-dev of error over the SETTLED TAIL of the rest window (see REST_TAIL_FRACTION/
	 *  REST_TAIL_MIN_SAMPLES) — the machine's actual encoder noise floor, not inflated by the settling
	 *  transient right after the move stops. What "Encoder noise floor" reports, and what scales the
	 *  cruise-wander gate and cost-comparison noise floor. docs/PLAN-capture-integrity.md §3. */
	restNoise: number;
	/** Std-dev of error over the WHOLE rest window, settling transient included. Deliberately kept
	 *  separate from `restNoise`: this is what gates `restRing`/`cruiseRing` and the Ku/Tu oscillation-
	 *  period search (signal.ts) — both are zero-crossing oscillation detectors, and a tail-based
	 *  (smaller) floor there would make ordinary settling itself count as "louder than the noise floor",
	 *  changing how much ringing it takes to register as ringing. docs/PLAN-capture-integrity.md §3. */
	restNoiseFull: number;
	/** Significant oscillation cycles after the motor stops (ringing). */
	restRing: number;
	/**
	 * Significant oscillation cycles WHILE cruising, using the same gate as `restRing`. Report-only —
	 * never gates a decision. Its purpose is context: a ripple present at a similar level whether the
	 * motor is moving or stopped usually isn't loop underdamping (which D fixes) but a persistent
	 * mechanical source such as a ballscrew's lead-error — more D is unlikely to help. See
	 * docs/PLAN-v2.4-feedback.md §2.3.
	 */
	cruiseRing: number;
	/** Peak |error| in the moment the move stops (overshoot). */
	settleOvershoot: number;
	/** Mean signed error during the steady-speed section (velocity lag). */
	cruiseLag: number;
	/** Std-dev of error during the steady-speed section — a symmetric wander (e.g. a mismatched V
	 * oscillating around the target) averages toward zero in `cruiseLag` alone but still shows up here. */
	cruiseSpread: number;
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

// Thresholds in motor steps. Tuned to the Duet closed-loop wiki's "good" guidance (error a small fraction of
// a step at rest) while staying tolerant of the high-frequency encoder fuzz that's always present.
// Exported: the auto-tune strategies accept/reject against the same bar the evaluator grades with.
export const REST_GOOD = 0.25;
const REST_FAIR = 0.6;
export const CRUISE_GOOD = 0.35;
const CRUISE_FAIR = 1.0;
export const ACCEL_GOOD = 1.2;
const ACCEL_FAIR = 3.0;
export const OVERSHOOT_GOOD = 1.0;
const OVERSHOOT_FAIR = 2.5;
export const RING_WARN = 4;       // significant oscillation cycles after stop
/**
 * Cruise WANDER (std-dev of cruise error) beyond this many rest-noise σ is a real tracking problem, not
 * encoder fuzz — deliberately noise-SCALED with no fixed absolute floor (a fake constant floor is
 * exactly what made `P_NOISE_FLOOR_MIN` wrong elsewhere in this codebase). A symmetric oscillation
 * (e.g. a mismatched V hunting around the target) averages toward zero in `cruiseLag` alone, so this
 * catches what that mean-based check structurally can't.
 */
export const CRUISE_SPREAD_K = 3;
const CRUISE_SPREAD_WARN_K = 6; // 2× the info-tier multiplier

/**
 * settle/tail RMS ratio above which post-move accelerometer vibration is called out. PROVISIONAL:
 * measured 5.70x on a real ringing capture and 1.97x on a deliberately quiet one (n=2 — one positive, one
 * negative), so this sits roughly midway. Report-only (see the `note` vs `add` distinction below), so a
 * wrong call here costs a line of text, not a bad tune. See docs/PLAN-accelerometer.md §17.
 */
export const VIBRATION_RING_RATIO = 3.0;

/**
 * Minimum settled-tail RMS (g) before the ratio above is trusted. A ratio is only as meaningful as its
 * denominator: a pathologically quiet tail would divide into an enormous, spurious ratio. Not reachable
 * with real hardware — the quietest tail measured across four real captures was 0.0029 g with the motor
 * off entirely — so this is a guard against a degenerate/stuck sensor channel, set an order of magnitude
 * below that. See docs/PLAN-accelerometer.md §17.
 */
export const VIBRATION_TAIL_MIN_G = 0.0003;

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
	restBias: 0, restNoise: 0, restNoiseFull: 0, restRing: 0, cruiseRing: 0, settleOvershoot: 0, cruiseLag: 0,
	cruiseSpread: 0, accelPeak: 0, movePeak: 0, moveRms: 0, cruiseSamples: 0, restSamples: 0, moved: false,
};

/** Compute the per-region error statistics from a capture. */
export function tuneStats(capture: ParsedCapture, sampleRateHz: number): TuneStats {
	const series = buildSeries(capture, sampleRateHz);
	if (!series) { return empty; }
	const { time, measured, target } = series;
	const n = measured.length;
	const error = measured.map((m, i) => m - target[i]);

	// Shared segmentation (analysis.ts) — the same classes the tuning signal and move analysis use.
	const seg = segmentMove(target, time, sampleRateHz);
	if (!seg.moved) {
		// No commanded motion — judge the standing error only. No settling transient to separate out here
		// (nothing moved to settle from), so restNoise/restNoiseFull are deliberately the same value.
		const restNoise = std(error);
		return {
			...empty, restBias: mean(error), restNoise, restNoiseFull: restNoise,
			restRing: ringCount(error, Math.max(0.3, 3 * restNoise)), restSamples: n,
		};
	}
	const moveDir = Math.sign(target[n - 1] - target[0]) || 1;

	const restErr: Array<number> = [];
	const cruiseErr: Array<number> = [];
	const accelErr: Array<number> = [];
	const moveErr: Array<number> = [];
	for (let i = 1; i < n; i++) {
		const e = error[i];
		const c = seg.classes[i];
		if (c === "rest") { restErr.push(e); continue; }
		moveErr.push(e);
		if (c === "cruise") { cruiseErr.push(e); }
		else if (c === "accel") { accelErr.push(e); }
	}

	// Ring detection keeps using the FULL rest window's std — unchanged behaviour, since a lower
	// tail-based floor here would make ordinary settling/ringing itself count as "louder than the noise
	// floor" and change how much ringing it takes to trigger a finding.
	const restNoiseFull = std(restErr);
	const ringThreshold = Math.max(0.3, 3 * restNoiseFull);
	// The REPORTED/GATING noise floor comes from the settled TAIL only, not the whole rest window: measured
	// on real reports, the whole-window figure reached 4.08 steps on a 1000 PPR encoder (~0.05 step/count)
	// and was still described to the user as "normal for the encoder resolution" — it was actually the
	// settling transient and ringing, averaged in. This also scales the cruise-wander gate
	// (CRUISE_SPREAD_K), so an inflated floor was hiding real oscillation. Same tail concept
	// computeRestEffort already uses (REST_TAIL_FRACTION/REST_TAIL_MIN_SAMPLES from analysis.ts). Falls
	// back to the full-window value when the tail is too short to judge — never lets restNoise go to (or
	// stay near) 0, which would make every noise-scaled gate fire. See docs/PLAN-capture-integrity.md §3.
	const tailLen = Math.min(restErr.length, Math.max(REST_TAIL_MIN_SAMPLES, Math.floor(restErr.length * REST_TAIL_FRACTION)));
	const restTail = restErr.slice(restErr.length - tailLen);
	const restNoise = restTail.length >= REST_TAIL_MIN_SAMPLES ? std(restTail) : restNoiseFull;
	// Overshoot: the worst error (in the move direction) in the first slice after the motor stops.
	const settleWindow = restErr.slice(0, Math.max(3, Math.round(restErr.length * 0.25)));
	const settleOvershoot = settleWindow.reduce((mx, e) => (moveDir * e > 0 ? Math.max(mx, Math.abs(e)) : mx), 0);

	return {
		restBias: mean(restErr),
		restNoise,
		restNoiseFull,
		restRing: ringCount(restErr, ringThreshold),
		cruiseRing: ringCount(cruiseErr, ringThreshold),
		settleOvershoot,
		cruiseLag: mean(cruiseErr),
		cruiseSpread: std(cruiseErr),
		accelPeak: peak(accelErr),
		movePeak: peak(moveErr),
		moveRms: rms(moveErr),
		cruiseSamples: cruiseErr.length,
		restSamples: restErr.length,
		moved: true,
	};
}

/**
 * Grade a capture and produce plain-language, actionable findings.
 * @param vibration accelerometer measurements for this SAME capture, when one was armed alongside it
 * (see vibration.ts / docs/PLAN-accelerometer.md). Optional and additive: every existing caller that
 * omits it gets byte-identical behaviour to before this parameter existed — see the `note` vs `add`
 * distinction below for how it stays report-only.
 */
export function evaluateTune(capture: ParsedCapture, sampleRateHz: number, vibration?: Vibration): TuneEvaluation {
	const series = buildSeries(capture, sampleRateHz);
	if (!series) {
		return { grade: "unknown", score: 0, headline: "Couldn't read this capture — record Measured + Target Motor Steps.", findings: [], stats: empty };
	}
	const s = tuneStats(capture, sampleRateHz);
	const findings: Array<Finding> = [];
	let score = 100;
	const penalise = (sev: Severity) => { score -= sev === "bad" ? 34 : sev === "warn" ? 15 : sev === "info" ? 3 : 0; };
	const add = (f: Finding) => { findings.push(f); penalise(f.severity); };
	/** Adds a finding that does NOT affect the score. For measurements from a sensor OUTSIDE the control
	 *  loop — the accelerometer — which must never move an encoder-derived grade. `add` penalises; this
	 *  deliberately does not. See docs/PLAN-accelerometer.md §17.4. */
	const note = (f: Finding) => { findings.push(f); };

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
		else {
			// Standing error alone can't tell "settled" from a limit cycle centred on zero — a fraction
			// of one encoder count can swing the P term hard, audible as buzz or hum, without ever
			// moving the mean error enough to show up as bias. See docs/PLAN-standstill-effort.md.
			// restTailValid false (too-short rest window, or the integrator was still converging when
			// the capture ended) means "can't judge effort yet" — falls through to "Reaches target",
			// same as before this check existed, never a false "dithers" finding.
			const re = computeRestEffort(capture, sampleRateHz);
			if (dithersAtStandstill(re)) {
				add({
					severity: "warn",
					title: "Dithers at standstill",
					detail: `Position error swings ${re.errorRestRipple.toFixed(3)} step at rest (P term ${re.pTermRestRipple.toFixed(1)}) `
						+ `while the motor holds position — more than encoder quantisation, and audible as buzz or hum.`,
					fix: "Raise I (integral) so it holds the static load instead of P",
					term: "i",
					direction: "up",
				});
			} else {
				add({ severity: "good", title: "Reaches target", detail: `Settles to within ${b.toFixed(2)} step of target — no standing offset.` });
			}
		}
	}

	// 2. Steady-speed lag (velocity feed-forward).
	if (s.cruiseSamples >= 3) {
		const c = Math.abs(s.cruiseLag);
		if (c > CRUISE_FAIR) { add({ severity: "warn", title: "Lags at steady speed", detail: `Trails the target by ${s.cruiseLag.toFixed(2)} step while cruising.`, fix: "Raise V (velocity feed-forward)", term: "v", direction: "up" }); }
		else if (c > CRUISE_GOOD) { add({ severity: "info", title: "Small cruise lag", detail: `Trails by ${s.cruiseLag.toFixed(2)} step at speed.`, fix: "Raise V (velocity feed-forward) slightly", term: "v", direction: "up" }); }
		else { add({ severity: "good", title: "Tracks at speed", detail: `Holds within ${c.toFixed(2)} step during steady-speed motion.` }); }

		// 2b. Steady-speed WANDER — a separate signal from the mean lag above. A symmetric oscillation
		// (e.g. a mismatched V hunting around the target) averages toward zero in `cruiseLag`, so a badly
		// wandering tune could otherwise still score full marks on the check above.
		const spreadInfoFloor = CRUISE_SPREAD_K * s.restNoise;
		const spreadWarnFloor = CRUISE_SPREAD_WARN_K * s.restNoise;
		if (s.cruiseSpread > spreadWarnFloor) { add({ severity: "warn", title: "Cruise error wanders", detail: `Swings ±${s.cruiseSpread.toFixed(2)} step around its own mean while cruising — even though that averages out, it's a real feed-forward mismatch, not noise.`, fix: "Raise V (velocity feed-forward)", term: "v", direction: "up" }); }
		else if (s.cruiseSpread > spreadInfoFloor) { add({ severity: "info", title: "Slight cruise wander", detail: `±${s.cruiseSpread.toFixed(2)} step spread while cruising.`, fix: "A touch more V (velocity feed-forward)", term: "v", direction: "up" }); }
		else { add({ severity: "good", title: "Steady at speed", detail: `±${s.cruiseSpread.toFixed(2)} step spread while cruising — within the encoder's own noise.` }); }
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
	if (s.restRing >= RING_WARN) {
		// Ripple present at a similar level while cruising too is context, not a different verdict — a
		// mechanical source (e.g. a leadscrew/ballscrew) shows up regardless of whether the motor is
		// moving or stopped, whereas loop underdamping (what this finding is normally about) is worst
		// right after the stop. Never changes severity/score/fix — see docs/PLAN-v2.4-feedback.md §2.3.
		const alsoAtSpeed = s.cruiseRing >= RING_WARN
			? ` A similar ${s.cruiseRing} cycles show up while cruising too — that pattern usually means a mechanical source (e.g. a leadscrew/ballscrew), not underdamping. More D is unlikely to help; check the mechanics before raising it further.`
			: "";
		add({ severity: "warn", title: "Rings after stopping", detail: `${s.restRing} oscillation cycles after the move stops — the loop is under-damped.${alsoAtSpeed}`, fix: "Lower P, or raise D (derivative)", term: "p", direction: "down" });
	}

	// 5b. Post-move vibration, from the accelerometer — measures the physical machine rather than the
	// encoder's own position error, so it can catch ringing too small for the encoder to see at all (a
	// real capture: restRing was 0 here while the accelerometer measured 5.7x its own settled level).
	// Compares the capture against ITS OWN settled tail rather than a universal g threshold, which is what
	// lets this work without per-machine calibration — see docs/PLAN-accelerometer.md §17.2. Report-only:
	// uses `note`, never `add`, so this can never move the score or grade (§17.4, §11).
	if (vibration?.valid && vibration.restSettle.samples > 0 && vibration.restTail.samples > 0
		&& vibration.restTail.rmsG >= VIBRATION_TAIL_MIN_G) {
		const ratio = vibration.restSettle.rmsG / vibration.restTail.rmsG;
		if (ratio >= VIBRATION_RING_RATIO) {
			const alsoEncoder = s.restRing > 0
				? " The encoder sees this too."
				: " The encoder's own error signal is too coarse to show this.";
			note({
				severity: "info",
				title: "Vibration after stopping (accelerometer)",
				detail: `${vibration.restSettle.rmsG.toFixed(3)} g measured just after the move stopped, `
					+ `${ratio.toFixed(1)}x this machine's own settled level (${vibration.restTail.rmsG.toFixed(3)} g).`
					+ alsoEncoder,
			});
		}
	}

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
