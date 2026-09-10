/**
 * Shared plumbing between the sequential/refinement orchestrator (autorun.ts) and the package/joint
 * optimiser (optimize.ts). Kept in its own leaf module — with no dependency on either — so autorun.ts
 * can call INTO optimize.ts (to run a package-optimize pass as part of an auto-tune) while optimize.ts
 * still gets the primitives (TuneEffects, captureMedian, term clamps) it needs, without the two files
 * importing each other.
 */
import { dithersAtStandstill, type StepMetrics } from "./analysis";
import { A_MAX, D_MAX, I_MAX, P_MAX, V_MAX } from "./autotune";
import type { TuneEvaluation } from "./evaluate";
import type { PidConfig } from "./m569";
import { medianSignal, signalUnstable, type TuneSignal } from "./signal";
import type { PidTerm } from "./wizard";

/**
 * Result of a validation capture at the axis's own configured max (M203/M201) — a different question
 * from identification's rail search, which deliberately runs at a MODERATE profile so the ramp has
 * unsaturated headroom to measure anything (see docs/PLAN-rail-detection.md §6.2: a profile aggressive
 * enough to already saturate the seed gives model-fit nothing to ramp through). This checks, after
 * identification is done, whether the result it found still holds once the axis is pushed to what it's
 * actually configured to do. Report-only by design — never feeds back into the tune itself (§6.4).
 */
export interface EnvelopeCheck {
	/** Motor-space feed the check capture was COMMANDED at, mm/min — the speed at which the first coupled
	 *  axis to reach ITS OWN configured M203 does so (see docs/PLAN-envelope-check.md). */
	feedMmPerMin: number;
	/** The peak motor-space feed the move actually REACHED, mm/min, measured from the capture's own
	 *  commanded-velocity profile. Well below `feedMmPerMin` means the auto-sized move (capped at
	 *  AUTO_MOVE_CAP_MM) was too short to accelerate that far — see `outcome: "inconclusive"`. */
	achievedFeedMmPerMin: number;
	/** Saturation duty measured at the achieved speed. */
	satDuty: number;
	/**
	 * - `"holds"`: reached (near) the configured max and did not saturate.
	 * - `"saturates"`: reached the configured max and DID saturate — the tune may not be safe at speed.
	 * - `"inconclusive"`: the move was too short to reach the configured max, so this run did NOT
	 *   actually test the axis at its limits (docs/PLAN-v2.7-feedback.md §5).
	 */
	outcome: "holds" | "saturates" | "inconclusive";
}

export interface TuneEffects {
	/** Send the PID values to the driver. */
	applyPid(pid: PidConfig): Promise<void>;
	/** Read the driver's current PID values back (used for the pre-run snapshot). Null if the read fails. */
	readPid(): Promise<PidConfig | null>;
	/** One unified trapezoid-move capture, analysed into a TuneSignal (drivers with an axis). */
	captureSignal(): Promise<TuneSignal | null>;
	/** One step-response capture (extruders / no axis). */
	captureStep(): Promise<StepMetrics | null>;
	/**
	 * Whatever "ready to tune" means for this driver — mode switch, axis centering/homing check, etc.
	 * Called once before cycle 1 (and again, cheaply, before the preflight probe). Returning false
	 * aborts the run before anything is changed.
	 */
	ensureReady(): Promise<boolean>;
	/** Run one `M569.6` calibration/tuning manoeuvre and return its raw reply (preflight only). */
	runCalibration(moveId: number): Promise<string>;
	/** One fresh capture, graded with `evaluateTune` (final verification only). Null if it fails. */
	evaluateCapture(): Promise<TuneEvaluation | null>;
	/**
	 * One validation capture at the axis's own configured max feed/accel (final verification only,
	 * after a successful run). Null if it fails OR if there is no axis to check (extruders, or a
	 * kinematics the coupling math can't resolve) — a null result is not logged as a failure by the
	 * caller, since "nothing to check" and "the check itself failed" both just mean "no fact to report".
	 * Implementations should measure saturation duty and build the result via modelfit.ts's
	 * `evaluateEnvelope` rather than deciding `holds` themselves — keeps the one threshold judgment in
	 * one tested place.
	 */
	checkEnvelope(): Promise<EnvelopeCheck | null>;
	log(line: string): void;
	status(line: string): void;
	/** Notified after every capture that feeds a decision (session recording, wizard-step highlighting). */
	onAttempt?(term: PidTerm, value: number, metric: TuneSignal | StepMetrics): void;
	/** Notified on stage transitions (preflight → P → A → V → D → I → verify) — drives a progress UI. */
	onStage?(stage: StageId, state: StageState): void;
	isCancelled(): boolean;
	delay(ms: number): Promise<void>;
}

/** The stages auto-tune moves through, in order (P–I repeat every cycle). "optimize" is the package/joint
 * pattern-search pass (method: "package" | "refine") — a single stage since it works all terms at once. */
export type StageId = "preflight" | PidTerm | "optimize" | "verify";
export type StageState = "pending" | "running" | "done" | "failed";

export interface AutoRunAttempt {
	term: PidTerm;
	value: number;
}

export const SETTLE_DELAY_MS = 400;

/** First non-zero value the P ramp/seed tries — shared by seeding, zero-start floors, and refine steps. */
export const SEED_START = 30;

/** Where each term starts from zero — mirrors each strategy's own first non-zero value. */
export const ZERO_START: Record<PidTerm, number> = { p: SEED_START, i: 1000, d: 0.01, a: 50000, v: 100 };
export const TERM_MAX: Record<PidTerm, number> = { p: P_MAX, i: I_MAX, d: D_MAX, a: A_MAX, v: V_MAX };

/** Decimal places each term is rounded/displayed to — single source of truth (previously duplicated in
 * optimize.ts and autorun.ts, which is how `nextBackoff` below ended up drifting to a hardcoded 6). */
export const ROUND_DP: Record<PidTerm, number> = { p: 2, i: 2, d: 4, a: 2, v: 2 };

export function clampTerm(term: PidTerm, value: number): number {
	return Math.min(TERM_MAX[term], Math.max(0, value));
}

/** How many times a null/invalid capture is retried (a fresh move re-issued) before giving up on it. A
 * single corrupt/truncated CSV must not be treated as a real measurement — see `computeTuneSignal`'s own
 * validation, which is what usually produces the null this retries. */
const CAPTURE_RETRIES = 2;
const CAPTURE_RETRY_DELAY_MS = 300;

/** One or more captures, median-combined — shared by every orchestration path (ramp, refine, package).
 * Each individual capture is retried (re-issuing the move) up to `CAPTURE_RETRIES` times if it comes back
 * null (missing columns, too few rows, or NaN/garbage data — see `computeTuneSignal`), so a single glitched
 * capture can't be mistaken for "the axis stopped tracking" partway through an otherwise-good run. */
export async function captureMedian(effects: TuneEffects, n: number): Promise<TuneSignal | null> {
	const signals: Array<TuneSignal> = [];
	for (let i = 0; i < n; i++) {
		if (effects.isCancelled()) { return null; }
		let s: TuneSignal | null = null;
		for (let retry = 0; retry <= CAPTURE_RETRIES; retry++) {
			if (effects.isCancelled()) { return null; }
			s = await effects.captureSignal();
			if (s) { break; }
			if (retry < CAPTURE_RETRIES) {
				effects.log(`Capture failed or invalid — retrying (${retry + 1}/${CAPTURE_RETRIES})…`);
				await effects.delay(CAPTURE_RETRY_DELAY_MS);
			}
		}
		if (!s) { return null; }
		signals.push(s);
	}
	return medianSignal(signals);
}

function round(v: number, dp = 2): number {
	const f = Math.pow(10, dp);
	return Math.round(v * f) / f;
}

/** Halve the accepted value on each verification retry (retry 0 → half, retry 1 → quarter, …), rounded
 * to the term's own display precision — NOT a fixed dp, or repeated halving on a large term (A in
 * particular) surfaces real-but-meaningless digits (.5, .25, .125, .0625, …) in the UI. */
export function nextBackoff(value: number, retry: number, term: PidTerm): number {
	return round(value * Math.pow(0.5, retry + 1), ROUND_DP[term]);
}

export interface VerifiedAccept {
	ok: true;
	value: number;
	signal: TuneSignal;
}
export interface VerifyFailed {
	ok: false;
	reason: string;
}

/**
 * A strategy's "accept" is provisional: re-apply the value and capture once more before trusting it.
 * If the fresh capture is unstable, halve the value and re-verify, up to `verifyRetries` times.
 */
export async function verifyAccepted(
	effects: TuneEffects, term: PidTerm, pid: PidConfig, acceptedValue: number, medianOf: number, verifyRetries: number,
): Promise<VerifiedAccept | VerifyFailed> {
	let value = acceptedValue;
	for (let retry = 0; retry <= verifyRetries; retry++) {
		pid[term] = value;
		await effects.applyPid(pid);
		await effects.delay(SETTLE_DELAY_MS);
		const signal = await captureMedian(effects, medianOf);
		if (!signal) { return { ok: false, reason: `${term.toUpperCase()}: verification capture failed.` }; }
		if (!signalUnstable(signal)) { return { ok: true, value, signal }; }
		effects.log(`${term.toUpperCase()}=${value} was unstable on verification (retry ${retry + 1}/${verifyRetries}) — backing off.`);
		value = nextBackoff(acceptedValue, retry, term);
	}
	return { ok: false, reason: `${term.toUpperCase()}: stayed unstable after ${verifyRetries} verification backoffs — stopping the run.` };
}

/** Accepted I at or below this triggers dither confirmation — an I=0/near-0 "accept" is the degenerate
 *  case the field report showed slipping through. A real integrator (the ramp's first non-zero I is
 *  1000) never needs it. */
export const I_CONFIRM_MAX = 100;
/** Extra rest captures taken to confirm a low-I accept. */
export const I_CONFIRM_TRIES = 3;

/**
 * Confirm a just-accepted low I really holds, by taking a few more rest captures. The CoreXY standstill
 * limit cycle in the 2026-09-10 field report is INTERMITTENT — one I=0 capture can look settled while a
 * later one shows the dither, so `medianOf` alone (a median of N) doesn't catch a behaviour that only
 * appears on a minority of captures (docs/PLAN-v2.7-feedback.md §3). Returns false if ANY of `tries`
 * captures shows a dither (position-error limit cycle, `dithersAtStandstill`) or fails outright — the
 * caller then bumps I rather than accepting, and never silently accepts an unconfirmed low I.
 */
export async function confirmNoDither(effects: TuneEffects, medianOf: number, tries: number): Promise<boolean> {
	for (let i = 0; i < tries; i++) {
		if (effects.isCancelled()) { return true; } // a cancel is the caller's to handle, not ours to fail
		const s = await captureMedian(effects, medianOf);
		if (!s) { return false; }
		if (dithersAtStandstill(s.restEffort)) { return false; }
	}
	return true;
}
