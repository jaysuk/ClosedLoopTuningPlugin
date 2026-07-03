/**
 * Pure auto-tune orchestrator — the state machine that used to live inside ClosedLoopTuning.vue
 * (`runAutoTune` / `autoTuneTerm` / `autoTuneSignalTerm`), extracted so it's unit-testable and so the
 * safety behaviours below apply uniformly instead of being reimplemented ad hoc in the UI layer:
 *
 *  - **Ku/Tu seeding**: cycle 1 starts with a brief, bounded excitation (I=D=A=V=0, P ramped) looking
 *    for a clean, non-saturating sustained oscillation. If found, the ultimate gain/period seed P/I/D
 *    via a classical rule (Tyreus–Luyben by default) instead of always starting from a fixed P=30 —
 *    fewer physical moves to converge, with a rule tuned for position loops. Seeding is an accelerator,
 *    never a requirement: if the search saturates or never finds a clean oscillation, it's abandoned
 *    and the normal conservative ramp runs instead.
 *  - **PID snapshot/rollback**: the driver's PID is read back before anything changes; on cancellation,
 *    failure, or a thrown error the snapshot (or the caller-supplied starting values, if the read-back
 *    failed) is always re-applied before returning, so a broken partial tune never survives a stopped run.
 *  - **Verified accept**: a strategy's "accept" is provisional — the value is re-applied and re-captured
 *    once more before being kept. An accept that looks fine against the attempts used to reach it can
 *    still be unstable once fully in effect (interactions with other terms, encoder noise); if so, it's
 *    halved and re-verified up to a bounded number of times before the run fails cleanly.
 *  - **Cycle semantics**: cycle 1 seeds and fully tunes every term; cycles ≥2 refine from the values the
 *    previous cycle accepted (not from scratch), and the run stops early once the tracking-error
 *    objective (ITAE) stops improving meaningfully between cycles.
 *
 * Every side effect (sending G-code, capturing, waiting, logging) is injected via `TuneEffects`, so this
 * module has no DWC/Vue import and is fully deterministic to test.
 */
import type { StepMetrics } from "./analysis";
import {
	AUTOTUNE_SEQUENCE, AUTOTUNE_SIGNAL_SEQUENCE, describeMetrics, type Attempt,
	type SignalAttempt, type SignalStrategy, type TermStrategy,
} from "./autotune";
import { RING_WARN } from "./evaluate";
import type { PidConfig } from "./m569";
import { describeSignal, medianSignal, signalUnstable, type TuneSignal } from "./signal";
import type { PidTerm } from "./wizard";

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
	 * Called once before cycle 1. Returning false aborts the run before anything is changed.
	 */
	ensureReady(): Promise<boolean>;
	log(line: string): void;
	status(line: string): void;
	/** Notified after every capture that feeds a decision (session recording, wizard-step highlighting). */
	onAttempt?(term: PidTerm, value: number, metric: TuneSignal | StepMetrics): void;
	isCancelled(): boolean;
	delay(ms: number): Promise<void>;
}

export type SeedRule = "tyreus-luyben" | "zn-classic" | "amigo";

export interface AutoRunOptions {
	cycles: number;
	hasAxis: boolean;
	/** Captures per decision, median-combined to reject one-off glitches. Default 1. */
	medianOf?: number;
	/** How many times a verified-unstable accept is halved and re-checked before the run fails. Default 2. */
	verifyRetries?: number;
	/** Ultimate-gain seeding rule for cycle 1. Default "tyreus-luyben". */
	seedRule?: SeedRule;
	/** Aggressiveness scalar for the "amigo" rule (bigger = faster/hotter). Default 1. */
	seedLambda?: number;
}

export interface AutoRunAttempt {
	term: PidTerm;
	value: number;
}

export interface AutoRunResult {
	ok: boolean;
	reason?: string;
	/** Final PID (the tuned values on success; the restored snapshot on failure/cancel). */
	pid: PidConfig;
	/** True when `pid` is the pre-run snapshot re-applied after a failure/cancel, not a tuned result. */
	restored?: boolean;
	attempts: Array<AutoRunAttempt>;
	/** Ultimate gain/period found during seeding, when it succeeded. */
	ku?: number;
	tu?: number;
}

const VERIFY_RETRIES_DEFAULT = 2;
const MEDIAN_OF_DEFAULT = 1;
const SEED_RULE_DEFAULT: SeedRule = "tyreus-luyben";
const SEED_LAMBDA_DEFAULT = 1;
const SEED_START = 30;
const SEED_MAX_ATTEMPTS = 10;
const ITAE_PLATEAU = 0.05;
const SETTLE_DELAY_MS = 400;

function round(v: number, dp = 2): number {
	const f = Math.pow(10, dp);
	return Math.round(v * f) / f;
}

/** Same geometric ramp shape the strategies use, kept in sync so seeding and refinement feel consistent. */
function nextRampValue(value: number): number {
	return round(value < 100 ? value + 20 : value * 1.25);
}

/** Halve the accepted value on each verification retry (retry 0 → half, retry 1 → quarter, …). */
export function nextBackoff(value: number, retry: number): number {
	return round(value * Math.pow(0.5, retry + 1), 6);
}

// ---- Ultimate-gain (Ku/Tu) seeding ----

/**
 * Classical PID gains from an ultimate gain/period pair. Tyreus–Luyben (default) is the conservative
 * variant — less overshoot than textbook Ziegler–Nichols, which suits a position loop where overshoot
 * means lost steps rather than a temperature dip. "amigo" is a λ-scaled variant of the same Tyreus–
 * Luyben structure (no FOPDT process model is available from a relay test alone, so this is an
 * aggressiveness knob on the same rule rather than a true IMC/AMIGO model-based design): λ>1 pushes the
 * gains hotter/faster, λ<1 backs them off.
 */
export function seedFromUltimate(ku: number, tu: number, rule: SeedRule = SEED_RULE_DEFAULT, lambda = SEED_LAMBDA_DEFAULT): { p: number; i: number; d: number } {
	let kp: number, ti: number, td: number;
	if (rule === "zn-classic") {
		kp = 0.6 * ku; ti = 0.5 * tu; td = 0.125 * tu;
	} else if (rule === "amigo") {
		const l = lambda > 0 ? lambda : SEED_LAMBDA_DEFAULT;
		kp = (ku / 3.2) * l; ti = (2.2 * tu) / l; td = (tu / 6.3) / l;
	} else {
		kp = ku / 3.2; ti = 2.2 * tu; td = tu / 6.3;
	}
	return { p: round(kp), i: ti > 0 ? round(kp / ti) : 0, d: round(kp * td, 4) };
}

export type UltimateSearchResult =
	| { kind: "continue" }
	| { kind: "found"; ku: number; tu: number }
	| { kind: "abandon"; reason: string };

/**
 * Looked at after every seeding capture: has this P value produced a clean sustained oscillation (the
 * ultimate gain/period), does the search need to keep ramping, or has it gone unstable without ever
 * finding one (abandon — a saturated "Ku" is not a valid measurement)?
 */
export function detectUltimate(attempts: Array<SignalAttempt>): UltimateSearchResult {
	const last = attempts[attempts.length - 1];
	if (signalUnstable(last.signal)) {
		return { kind: "abandon", reason: `P=${last.value} went unstable before a clean sustained oscillation was found.` };
	}
	if (last.signal.oscPeriod != null && last.signal.stats.restRing >= RING_WARN) {
		return { kind: "found", ku: last.value, tu: last.signal.oscPeriod };
	}
	return { kind: "continue" };
}

async function captureMedian(effects: TuneEffects, n: number): Promise<TuneSignal | null> {
	const signals: Array<TuneSignal> = [];
	for (let i = 0; i < n; i++) {
		if (effects.isCancelled()) { return null; }
		const s = await effects.captureSignal();
		if (!s) { return null; }
		signals.push(s);
	}
	return medianSignal(signals);
}

/** Bounded search for a clean ultimate gain/period with I=D=A=V=0. Null falls back to the normal ramp. */
async function seedUltimateGain(effects: TuneEffects, medianOf: number): Promise<{ ku: number; tu: number } | null> {
	let value = SEED_START;
	const attempts: Array<SignalAttempt> = [];
	for (let k = 0; k < SEED_MAX_ATTEMPTS; k++) {
		if (effects.isCancelled()) { return null; }
		await effects.applyPid({ p: value, i: 0, d: 0, v: 0, a: 0 });
		await effects.delay(SETTLE_DELAY_MS);
		effects.status(`Seeding: probing P=${value} for a sustained oscillation…`);
		const signal = await captureMedian(effects, medianOf);
		if (!signal) { effects.log("Seeding: capture failed — falling back to the conservative ramp."); return null; }
		attempts.push({ value, signal });
		effects.log(`Seeding: P=${value} → ${describeSignal(signal)}`);
		const result = detectUltimate(attempts);
		if (result.kind === "found") {
			effects.log(`Seeding: found Ku=${result.ku}, Tu=${(result.tu * 1000).toFixed(0)} ms.`);
			return { ku: result.ku, tu: result.tu };
		}
		if (result.kind === "abandon") {
			effects.log(`Seeding: ${result.reason} Falling back to the conservative ramp.`);
			return null;
		}
		value = nextRampValue(value);
	}
	effects.log("Seeding: no sustained oscillation found within the attempt budget — falling back to the conservative ramp.");
	return null;
}

// ---- Verified accept ----

interface VerifiedAccept {
	ok: true;
	value: number;
	signal: TuneSignal;
}
interface VerifyFailed {
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
		value = nextBackoff(acceptedValue, retry);
	}
	return { ok: false, reason: `${term.toUpperCase()}: stayed unstable after ${verifyRetries} verification backoffs — stopping the run.` };
}

// ---- Per-term loops ----

export interface TermRunResult {
	ok: boolean;
	reason?: string;
	/** The verified capture behind the final accepted value, when one was reached (feeds ITAE tracking). */
	finalSignal?: TuneSignal;
	attempts: Array<AutoRunAttempt>;
}

export async function runSignalTerm(
	effects: TuneEffects, strategy: SignalStrategy, pid: PidConfig, medianOf: number, verifyRetries: number, startValue: number,
): Promise<TermRunResult> {
	let value = startValue;
	const attempts: Array<SignalAttempt> = [];
	const log: Array<AutoRunAttempt> = [];
	for (let k = 0; k <= strategy.maxAttempts; k++) {
		if (effects.isCancelled()) { return { ok: false, reason: "Cancelled.", attempts: log }; }
		pid[strategy.term] = value;
		await effects.applyPid(pid);
		await effects.delay(SETTLE_DELAY_MS);
		effects.status(`${strategy.label}: testing ${strategy.term.toUpperCase()}=${value}…`);
		const signal = await captureMedian(effects, medianOf);
		if (!signal) { effects.log(`${strategy.label}: capture failed — aborting.`); return { ok: false, reason: `${strategy.label}: capture failed.`, attempts: log }; }
		attempts.push({ value, signal });
		log.push({ term: strategy.term, value });
		effects.onAttempt?.(strategy.term, value, signal);
		effects.log(`${strategy.label}: ${strategy.term.toUpperCase()}=${value} → ${describeSignal(signal)}`);
		const d = strategy.decide(attempts);
		if (d.kind === "fail") { effects.log(`${strategy.label}: ${d.reason}`); return { ok: false, reason: `${strategy.label}: ${d.reason}`, attempts: log }; }
		if (d.kind === "accept") {
			const verified = await verifyAccepted(effects, strategy.term, pid, d.value, medianOf, verifyRetries);
			if (!verified.ok) { effects.log(verified.reason); return { ok: false, reason: verified.reason, attempts: log }; }
			pid[strategy.term] = verified.value;
			await effects.applyPid(pid);
			const note = verified.value !== d.value ? `${d.note} (backed off further to ${verified.value} on verification)` : d.note;
			effects.log(`${strategy.label}: ✓ ${note}`);
			return { ok: true, finalSignal: verified.signal, attempts: log };
		}
		value = d.value;
	}
	return { ok: true, attempts: log };
}

export async function runStepTerm(effects: TuneEffects, strategy: TermStrategy, pid: PidConfig, startValue: number): Promise<TermRunResult> {
	let value = startValue;
	const attempts: Array<Attempt> = [];
	const log: Array<AutoRunAttempt> = [];
	for (let k = 0; k <= strategy.maxAttempts; k++) {
		if (effects.isCancelled()) { return { ok: false, reason: "Cancelled.", attempts: log }; }
		pid[strategy.term] = value;
		await effects.applyPid(pid);
		await effects.delay(SETTLE_DELAY_MS);
		effects.status(`${strategy.label}: testing ${strategy.term.toUpperCase()}=${value}…`);
		const m = await effects.captureStep();
		if (!m) { effects.log(`${strategy.label}: capture failed — aborting.`); return { ok: false, reason: `${strategy.label}: capture failed.`, attempts: log }; }
		attempts.push({ value, metrics: m });
		log.push({ term: strategy.term, value });
		effects.onAttempt?.(strategy.term, value, m);
		effects.log(`${strategy.label}: ${strategy.term.toUpperCase()}=${value} → ${describeMetrics(m)}`);
		const d = strategy.decide(attempts);
		if (d.kind === "fail") { effects.log(`${strategy.label}: ${d.reason}`); return { ok: false, reason: `${strategy.label}: ${d.reason}`, attempts: log }; }
		if (d.kind === "accept") {
			pid[strategy.term] = d.value;
			await effects.applyPid(pid);
			effects.log(`${strategy.label}: ✓ ${d.note}`);
			return { ok: true, attempts: log };
		}
		value = d.value;
	}
	return { ok: true, attempts: log };
}

// ---- Per-cycle orchestration ----

interface CycleResult {
	ok: boolean;
	reason?: string;
	attempts: Array<AutoRunAttempt>;
	/** ITAE of the last verified capture this cycle (axis path only) — the early-stop objective. */
	itae?: number;
	ku?: number;
	tu?: number;
}

async function runAxisCycle(
	effects: TuneEffects, pid: PidConfig, cycle: number, medianOf: number, verifyRetries: number, seedRule: SeedRule, seedLambda: number,
): Promise<CycleResult> {
	const attempts: Array<AutoRunAttempt> = [];
	let ku: number | undefined, tu: number | undefined;
	// Cycle 1 only: zero the other terms and try to seed P/I/D from a Ku/Tu search before ramping.
	const seeded: Partial<Record<PidTerm, number>> = {};
	if (cycle === 1) {
		pid.i = 0; pid.d = 0; pid.a = 0; pid.v = 0;
		await effects.applyPid(pid);
		const ultimate = await seedUltimateGain(effects, medianOf);
		if (ultimate) {
			ku = ultimate.ku; tu = ultimate.tu;
			const candidate = seedFromUltimate(ultimate.ku, ultimate.tu, seedRule, seedLambda);
			pid.p = candidate.p; pid.i = candidate.i; pid.d = candidate.d;
			await effects.applyPid(pid);
			await effects.delay(SETTLE_DELAY_MS);
			let signal = await captureMedian(effects, medianOf);
			let tries = 0;
			const backoffRetries = 2;
			while (signal && signalUnstable(signal) && tries < backoffRetries) {
				pid.p = nextBackoff(candidate.p, tries); pid.i = nextBackoff(candidate.i, tries); pid.d = nextBackoff(candidate.d, tries);
				await effects.applyPid(pid);
				await effects.delay(SETTLE_DELAY_MS);
				signal = await captureMedian(effects, medianOf);
				tries++;
			}
			if (signal && !signalUnstable(signal)) {
				seeded.p = pid.p; seeded.i = pid.i; seeded.d = pid.d;
				effects.log(`Seeding: starting from P=${pid.p} I=${pid.i} D=${pid.d} (Ku=${ultimate.ku}, Tu=${(ultimate.tu * 1000).toFixed(0)} ms, ${seedRule}).`);
			} else {
				effects.log("Seeding: the derived gains stayed unstable after backing off — starting from the conservative default ramp instead.");
				pid.p = SEED_START; pid.i = 0; pid.d = 0;
				await effects.applyPid(pid);
			}
		}
	}

	let lastSignal: TuneSignal | undefined;
	for (const strategy of AUTOTUNE_SIGNAL_SEQUENCE) {
		if (effects.isCancelled()) { return { ok: false, reason: "Cancelled.", attempts, ku, tu }; }
		const isFeedForward = strategy.term === "a" || strategy.term === "v";
		const startValue = cycle === 1
			? (isFeedForward ? strategy.start : (seeded[strategy.term] ?? strategy.start))
			: pid[strategy.term];
		const result = await runSignalTerm(effects, strategy, pid, medianOf, verifyRetries, startValue);
		attempts.push(...result.attempts);
		if (!result.ok) { return { ok: false, reason: result.reason, attempts, ku, tu }; }
		if (result.finalSignal) { lastSignal = result.finalSignal; }
	}
	return { ok: true, attempts, itae: lastSignal?.itae, ku, tu };
}

async function runExtruderCycle(effects: TuneEffects, pid: PidConfig, cycle: number): Promise<CycleResult> {
	const attempts: Array<AutoRunAttempt> = [];
	if (cycle === 1) { pid.i = 0; pid.d = 0; pid.v = 0; pid.a = 0; await effects.applyPid(pid); }
	for (const strategy of AUTOTUNE_SEQUENCE) {
		if (effects.isCancelled()) { return { ok: false, reason: "Cancelled.", attempts }; }
		const startValue = cycle === 1 ? strategy.start : pid[strategy.term];
		const result = await runStepTerm(effects, strategy, pid, startValue);
		attempts.push(...result.attempts);
		if (!result.ok) { return { ok: false, reason: result.reason, attempts }; }
	}
	return { ok: true, attempts };
}

// ---- Top-level run ----

export async function runAutoTune(effects: TuneEffects, startPid: PidConfig, opts: AutoRunOptions): Promise<AutoRunResult> {
	const medianOf = Math.max(1, opts.medianOf ?? MEDIAN_OF_DEFAULT);
	const verifyRetries = Math.max(0, opts.verifyRetries ?? VERIFY_RETRIES_DEFAULT);
	const seedRule = opts.seedRule ?? SEED_RULE_DEFAULT;
	const seedLambda = opts.seedLambda ?? SEED_LAMBDA_DEFAULT;
	const totalCycles = Math.max(1, Math.round(opts.cycles || 1));

	const readBack = await effects.readPid();
	const restoreTarget: PidConfig = readBack ?? { ...startPid };
	const pid: PidConfig = { ...startPid };
	const attempts: Array<AutoRunAttempt> = [];
	let ku: number | undefined, tu: number | undefined;

	let ok = true;
	let reason: string | undefined;
	try {
		if (!(await effects.ensureReady())) {
			return { ok: false, reason: "Not ready to tune (see log).", pid: restoreTarget, restored: false, attempts };
		}
		let prevItae: number | undefined;
		for (let cycle = 1; cycle <= totalCycles; cycle++) {
			if (effects.isCancelled()) { ok = false; reason = "Cancelled."; break; }
			effects.log(`──── Cycle ${cycle} of ${totalCycles} ────`);
			const result = opts.hasAxis
				? await runAxisCycle(effects, pid, cycle, medianOf, verifyRetries, seedRule, seedLambda)
				: await runExtruderCycle(effects, pid, cycle);
			attempts.push(...result.attempts);
			if (result.ku != null) { ku = result.ku; tu = result.tu; }
			if (!result.ok) { ok = false; reason = result.reason; break; }
			if (result.itae != null) {
				if (prevItae != null && cycle > 1) {
					const improvement = (prevItae - result.itae) / Math.max(prevItae, 1e-9);
					if (improvement < ITAE_PLATEAU) {
						effects.log(`Tracking-error objective (ITAE) plateaued after cycle ${cycle} — stopping early.`);
						break;
					}
				}
				prevItae = result.itae;
			}
		}
	} catch (e) {
		ok = false;
		reason = e instanceof Error ? e.message : String(e);
	}

	if (!ok) {
		effects.log(`Auto-tune stopped: ${reason ?? "cancelled"}. Restoring the PID values from before this run.`);
		await effects.applyPid(restoreTarget);
		return { ok: false, reason, pid: restoreTarget, restored: true, attempts, ku, tu };
	}
	return { ok: true, pid, attempts, ku, tu };
}
