/**
 * Pure auto-tune orchestrator — the state machine that used to live inside ClosedLoopTuning.vue
 * (`runAutoTune` / `autoTuneTerm` / `autoTuneSignalTerm`), extracted so it's unit-testable and so the
 * safety behaviours below apply uniformly instead of being reimplemented ad hoc in the UI layer:
 *
 *  - **Ku/Tu seeding**: cycle 1 starts with a brief, bounded identification of the ultimate gain/period
 *    — either "continuous-cycling" (classic Ziegler–Nichols: ramp P with I=D=A=V=0 looking for a clean,
 *    non-saturating sustained oscillation) or "relay" (Åström–Hägglund: jump straight to a fixed high P
 *    so the P-term saturates like a bounded on/off relay, then read Ku/Tu off that limit cycle via the
 *    describing-function formula). Either way, the found Ku/Tu seed P/I/D via a classical rule (Tyreus–
 *    Luyben by default) instead of always starting from a fixed P=30 — fewer physical moves to converge,
 *    with a rule tuned for position loops. Seeding is an accelerator, never a requirement: if the search
 *    saturates, runs away, or never finds a clean oscillation, it's abandoned and the normal conservative
 *    ramp runs instead.
 *  - **PID snapshot/rollback**: the driver's PID is read back before anything changes; on cancellation,
 *    failure, or a thrown error the snapshot (or the caller-supplied starting values, if the read-back
 *    failed) is always re-applied before returning, so a broken partial tune never survives a stopped run.
 *  - **Verified accept**: a strategy's "accept" is provisional — the value is re-applied and re-captured
 *    once more before being kept. An accept that looks fine against the attempts used to reach it can
 *    still be unstable once fully in effect (interactions with other terms, encoder noise); if so, it's
 *    halved and re-verified up to a bounded number of times before the run fails cleanly.
 *  - **Cycle semantics**: cycle 1 seeds and fully tunes every term in Duet's documented order
 *    (P → A → V → D → I). Cycles ≥2 refine from the values cycle 1 accepted with a bidirectional local
 *    probe per term — try a higher value, and only if that doesn't help, a lower one — judged against a
 *    single whole-loop cost (`signalCost`) so a change in one term is judged by its effect on the whole
 *    capture, not just that term's own metric. Probe size shrinks each cycle (25% at cycle 2, halving
 *    after), and the run stops early once the cost stops improving meaningfully between cycles.
 *  - **Preflight** (axis drivers only): forces closed/assisted mode, then probes with a safe baseline
 *    PID — if the driver isn't tracking the commanded move, it runs whatever calibration moves it's
 *    given and re-probes once before giving up. The probe (does it actually track?) is the ground
 *    truth, not the calibration command's reply text, which firmware doesn't guarantee is stable.
 *  - **Final verification**: after the tune completes, one more capture is graded with `evaluateTune`.
 *    A grade below "good" gets exactly one bounded correction pass (±20% per flagged term, from the
 *    evaluation's own findings) — re-verified once, and only kept if it didn't make things worse.
 *
 * Every side effect (sending G-code, capturing, waiting, logging) is injected via `TuneEffects`, so this
 * module has no DWC/Vue import and is fully deterministic to test.
 */
import { P_TERM_CLAMP } from "./analysis";
import {
	AUTOTUNE_SEQUENCE, AUTOTUNE_SIGNAL_SEQUENCE, describeMetrics, interpolateVZero, P_MAX,
	type Attempt, type SignalAttempt, type SignalStrategy, type TermStrategy,
} from "./autotune";
import { RING_WARN, type Grade, type TuneEvaluation } from "./evaluate";
import type { PidConfig } from "./m569";
import { MODEL_FIT_BACKOFF_DEFAULT, runModelFitIdentification } from "./modelfit";
import { runPackageOptimize, type PackageOptimizeOptions } from "./optimize";
import {
	describeSignal, RUNAWAY_STEPS, significantlyBetterForTerm, signalUnstable, type TuneSignal,
} from "./signal";
import {
	captureMedian, clampTerm, nextBackoff, ROUND_DP, SEED_START, SETTLE_DELAY_MS, verifyAccepted, ZERO_START,
	type AutoRunAttempt, type TuneEffects,
} from "./tuneShared";
import type { PidTerm } from "./wizard";

export type {
	AutoRunAttempt, StageId, StageState, TuneEffects,
} from "./tuneShared";
export {
	captureMedian, clampTerm, nextBackoff, SETTLE_DELAY_MS, TERM_MAX, verifyAccepted, ZERO_START,
} from "./tuneShared";

export type SeedRule = "tyreus-luyben" | "zn-classic" | "amigo";

/**
 * How cycle 1 identifies P (and, for "model-fit", A/V too):
 *  - "model-fit" (default): treats P/A/V as a system-identification problem instead of a search. Ramps P
 *    toward the actuator's own effort rail (not toward an oscillation — a well-damped servo may never
 *    produce one below saturation) and backs off a fixed fraction; then solves A and V directly from a
 *    two-capture linear fit of the P-term-domain quantity each one drives to zero. See modelfit.ts.
 *  - "continuous-cycling": the classical Ziegler–Nichols closed-loop method — ramp P (I=D=A=V=0) from a
 *    low starting value until a clean, non-saturating sustained oscillation appears; Ku is that P value.
 *    Physically inapplicable to a sufficiently well-damped plant (see modelfit.ts's own docs) — falls
 *    back to the conservative ramp when no oscillation is ever found, same as always.
 *  - "relay": Åström–Hägglund relay feedback — jump straight to a fixed high P so the P-term saturates
 *    (behaving like an on/off relay bounded at ±P_TERM_CLAMP) and read Ku off the resulting bounded limit
 *    cycle via the describing-function formula `Ku = 4d/(πa)`. Usually faster (no ramp) and inherently
 *    bounded (the "relay" amplitude is the actuator's own known saturation limit, not a gain pushed
 *    toward instability) — but needs a genuine bounded oscillation, not a true runaway, to be valid.
 */
export type IdentifyMethod = "model-fit" | "continuous-cycling" | "relay";

/** Which search strategy an auto-tune run uses on an axis driver (extruders always use "sequential"). */
export type TuneMethod =
	| "sequential" // Duet-order ramp (cycle 1) + bidirectional per-term refinement (cycles ≥2). Default.
	| "package"    // Duet-order ramp (cycle 1) to get a decent start, then one joint (all-terms-at-once)
	//              optimisation pass under a capture budget — "tune it as a complete package".
	| "refine";    // Skip the ramp entirely; joint-optimise directly from whatever's already on the driver.

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
	/** How cycle 1 identifies P (and A/V, for "model-fit"). Default "model-fit". */
	identifyMethod?: IdentifyMethod;
	/** Fraction of the effort-rail-onset P used as P* for the "model-fit" method. Default 0.65. */
	modelFitBackoff?: number;
	/**
	 * Calibration moves (`M569.6` V-ids) to try during preflight if the driver isn't tracking, in
	 * order. Axis drivers only; extruders keep the pre-Phase-3 behaviour (calibration stays manual).
	 */
	calibrationMoveIds?: Array<number>;
	/** Search strategy on an axis driver. Default "sequential"; ignored (always sequential) without an axis. */
	method?: TuneMethod;
	/** Capture budget for "package"/"refine" methods' joint-optimisation pass. Default 40. */
	captureBudget?: number;
	/**
	 * User-supplied manual cap on D, below `D_MAX`. `undefined`/`null` = no extra cap (today's
	 * behaviour). Only applies to the "sequential" cycle-1 ramp (`SIGNAL_D_STRATEGY` via
	 * `runSignalTerm`) — the thing that can ride D upward chasing a persistent, non-resonant ripple
	 * (see `D_OVERSHOOT_PLATEAU`, which already fixes that automatically; this is a manual override on
	 * top). "refine"/"package" take small bounded steps from wherever D already is and don't need it.
	 */
	dCeiling?: number;
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
	/** Calibration moves actually run during preflight (empty if the driver was already tracking). */
	preflightActions?: Array<string>;
	/** Final verification grade (axis drivers only; undefined if verification couldn't run). */
	evaluation?: TuneEvaluation;
}

const VERIFY_RETRIES_DEFAULT = 2;
const MEDIAN_OF_DEFAULT = 1;
const SEED_RULE_DEFAULT: SeedRule = "tyreus-luyben";
const SEED_LAMBDA_DEFAULT = 1;
const METHOD_DEFAULT: TuneMethod = "sequential";
const IDENTIFY_METHOD_DEFAULT: IdentifyMethod = "model-fit";
const SEED_MAX_ATTEMPTS = 10;
const ITAE_PLATEAU = 0.05;

/**
 * M569.1 E<warn>:<err> thresholds to use for the DURATION of an auto-tune run, restored to whatever
 * M569.1 actually reported before the run (never a hardcoded default — the user may have their own)
 * on every exit path. Intentionally-extreme early P/D/I/A/V probes produce transient position errors far
 * larger than any sane running threshold would tolerate; on RP2350-based boards the resulting stream of
 * warn/error messages was enough to crash the board outright (confirmed on real hardware — raising E,
 * not lowering the capture rate, is the actual fix for that). Applied on every board, not just RP2350
 * ones: suppressing spurious threshold events during tuning is a correctness improvement generally, and
 * restoring the exact prior value afterward makes it a no-op for anyone who didn't need it.
 */
const TUNING_WARN_THRESHOLD = 500000;
const TUNING_ERR_THRESHOLD = 1000000;

function round(v: number, dp = 2): number {
	const f = Math.pow(10, dp);
	return Math.round(v * f) / f;
}

/** Same geometric ramp shape the strategies use, kept in sync so seeding and refinement feel consistent. */
function nextRampValue(value: number): number {
	return round(value < 100 ? value + 20 : value * 1.25);
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

/** Fixed high P used to force P-term saturation for the relay-feedback identification — the same cap
 * every strategy already clamps P to, so it's a value the driver is already known to tolerate. */
const RELAY_IDENT_P = P_MAX;

/** Generous sanity ceiling on the whole-move peak error, for the relay probe only. A commanded move at
 * a deliberately high, undamped P (no D/V/A yet) WILL overshoot during acceleration — that's expected,
 * not instability — so this only needs to catch a genuine, unbounded runaway, not the ordinary transient
 * of a hard-undamped move. `RUNAWAY_STEPS` (the tight bound used everywhere else) is judged against the
 * REST-window oscillation instead (see below), which is what actually needs to be bounded for a valid
 * Ku estimate. */
const RELAY_ABANDON_STEPS = 200;

/**
 * Åström–Hägglund relay-feedback identification: one capture at a fixed high P (I=D=A=V=0) intended to
 * saturate the P-term, then read Ku/Tu off the resulting bounded limit cycle instead of ramping toward
 * instability. Ku = 4d/(πa) (d = the known saturation half-amplitude `P_TERM_CLAMP` — the relay's real
 * physical throw, not the lower detection margin `P_TERM_RAIL` used elsewhere to declare "saturated";
 * a = the oscillation's peak error amplitude, measured on the REST window after the commanded move
 * ends — not the whole capture, which is dominated by the commanded move's own transient at this
 * deliberately undamped P and would otherwise trip a "runaway" veto on every genuine relay experiment).
 * Null (falls back to the continuous-cycling ramp) when the capture fails, the error is genuinely
 * unbounded, or no clean oscillation is found at rest at all.
 */
async function identifyRelay(effects: TuneEffects, medianOf: number): Promise<{ ku: number; tu: number } | null> {
	await effects.applyPid({ p: RELAY_IDENT_P, i: 0, d: 0, v: 0, a: 0 });
	await effects.delay(SETTLE_DELAY_MS);
	effects.status(`Relay feedback: identifying Ku/Tu at a fixed P=${RELAY_IDENT_P}…`);
	const signal = await captureMedian(effects, medianOf);
	if (!signal) { effects.log("Relay feedback: capture failed — falling back to the conservative ramp."); return null; }
	if (signal.oscAmplitude >= RUNAWAY_STEPS || signal.stats.movePeak >= RELAY_ABANDON_STEPS) {
		effects.log(`Relay feedback: P=${RELAY_IDENT_P} produced an unbounded error (rest amplitude ${signal.oscAmplitude.toFixed(1)} step, move peak ${signal.stats.movePeak.toFixed(1)} step) — not a bounded limit cycle. Falling back to the conservative ramp.`);
		return null;
	}
	if (signal.oscPeriod == null || signal.oscAmplitude <= 0) {
		effects.log("Relay feedback: no clean sustained oscillation found at rest — falling back to the conservative ramp.");
		return null;
	}
	const ku = (4 * P_TERM_CLAMP) / (Math.PI * signal.oscAmplitude);
	effects.log(`Relay feedback: found Ku=${ku.toFixed(1)}, Tu=${(signal.oscPeriod * 1000).toFixed(0)} ms (amplitude ${signal.oscAmplitude.toFixed(2)} step, P=${RELAY_IDENT_P}).`);
	return { ku, tu: signal.oscPeriod };
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
	priorAttempts: Array<SignalAttempt> = [],
	/** Manual cap on the values this ramp will ever try — `Infinity` (default) is a no-op for every
	 * term. Only D's caller passes a real value (see `AutoRunOptions.dCeiling`). */
	ceiling = Infinity,
): Promise<TermRunResult> {
	let value = startValue;
	// Readings an identification pass already took for this term feed the strategy's decide() as real
	// attempts, so a fallback never re-measures values it already has (a real run measured its P curve
	// three times over before this existed).
	const attempts: Array<SignalAttempt> = [...priorAttempts];
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
		value = Math.min(d.value, ceiling);
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
	/** Terms cycle 1's model-fit identification found to have no measurable effect (A/V only) — carried
	 * forward so a later package/optimise pass can seed them with a smaller step instead of re-discovering
	 * the same "doesn't matter" conclusion from scratch. Undefined when this cycle didn't run model-fit. */
	insensitiveTerms?: Array<PidTerm>;
}

/** One joint (all-terms-at-once) optimisation pass, wrapped as a `CycleResult` for the main cycle loop. */
async function runPackageCycle(
	effects: TuneEffects, pid: PidConfig, medianOf: number, captureBudget: number | undefined,
	insensitiveTerms: Array<PidTerm> = [],
): Promise<CycleResult> {
	effects.onStage?.("optimize", "running");
	const opts: PackageOptimizeOptions = { medianOf, captureBudget, insensitiveTerms };
	const result = await runPackageOptimize(effects, pid, opts);
	effects.onStage?.("optimize", result.ok ? "done" : "failed");
	return { ok: result.ok, reason: result.reason, attempts: result.attempts, itae: result.finalSignal?.itae };
}

/**
 * A per-term failure that means "we couldn't measure this term right now" (a flaky capture, or the test
 * move not reaching cruise) rather than "this gain destabilised the loop". The latter must always stop
 * the run for restore; the former should skip the term (keeping whatever value it already had) and let
 * the rest of the cycle — and the terms already verified — survive. This is what would have saved the
 * field run that lost 40 verified captures to one corrupt CSV on the last (V) stage.
 */
function isMeasurementFailure(reason: string): boolean {
	return /capture failed|no steady-speed move detected/i.test(reason);
}

async function runAxisCycle(
	effects: TuneEffects, pid: PidConfig, cycle: number, medianOf: number, verifyRetries: number, seedRule: SeedRule,
	seedLambda: number, method: TuneMethod, captureBudget: number | undefined, identifyMethod: IdentifyMethod,
	modelFitBackoff: number, priorInsensitiveTerms: Array<PidTerm> = [],
	/** See `AutoRunOptions.dCeiling` — only used by the "sequential" D ramp below. */
	dCeiling?: number,
): Promise<CycleResult> {
	// "refine" never seeds/ramps — every cycle is a joint-optimisation pass from whatever's already set.
	if (method === "refine") { return runPackageCycle(effects, pid, medianOf, captureBudget, priorInsensitiveTerms); }
	if (cycle > 1) {
		return method === "package"
			? runPackageCycle(effects, pid, medianOf, captureBudget, priorInsensitiveTerms)
			: refineAxisCycle(effects, pid, cycle, medianOf, verifyRetries);
	}

	const attempts: Array<AutoRunAttempt> = [];
	let ku: number | undefined, tu: number | undefined;
	// Zero every other term and identify P (and, for "model-fit", A/V too) before the per-term stages.
	const seeded: Partial<Record<PidTerm, number>> = {};
	const solved = new Set<PidTerm>();
	// Readings the model-fit P ramp took — primed into the legacy P stage on fallback so the identical
	// curve is never measured twice (let alone three times, as a real fallback run did).
	let pPriorAttempts: Array<SignalAttempt> = [];
	let lastSignal: TuneSignal | undefined;
	// A/V model-fit found to have no measurable effect — carried into a later package/optimise pass
	// (see CycleResult.insensitiveTerms) so it can seed a smaller step instead of re-discovering this.
	let cycleInsensitiveTerms: Array<PidTerm> = [];
	// Zero the local state (keeps the live PID display consistent while identification runs) but do
	// NOT write it to the driver: every identify branch below (model-fit/continuous-cycling/relay)
	// sends its own complete first applyPid() — P at its own starting value, I/D/V/A zeroed — before
	// any capture happens. A write here was unconditionally overwritten one line later with nothing
	// measured in between, so it was dead work that also briefly commanded the driver to a stale P
	// (whatever this run started at) right after the preflight probe's return move — the exact,
	// already-fragile seam a firmware race was traced to (see docs: M400-before-applyPid fix).
	pid.i = 0; pid.d = 0; pid.a = 0; pid.v = 0;

	if (identifyMethod === "model-fit") {
		const { fit, pRampAttempts } = await runModelFitIdentification(effects, pid, medianOf, verifyRetries, modelFitBackoff);
		if (fit) {
			solved.add("p"); solved.add("a"); solved.add("v");
			lastSignal = fit.finalSignal;
			if (!fit.a.measurable) { cycleInsensitiveTerms.push("a"); }
			if (!fit.v.measurable) { cycleInsensitiveTerms.push("v"); }
			effects.log(`Model fit: P=${fit.pStar} (${fit.pBasis}), A=${fit.a.applied}${fit.a.measurable ? "" : " (no measurable effect)"}, V=${fit.v.applied}${fit.v.measurable ? "" : " (no measurable effect)"}.`);
		} else {
			// The ramp couldn't measure (capture failure / instability before any reading / verify failure).
			// A Ku/Tu seeding ramp over the same range would fail identically, so skip it — go straight to
			// the P stage, primed with whatever readings the ramp did get.
			pPriorAttempts = pRampAttempts;
			effects.log(`Model fit: identification incomplete — continuing with the P stage directly${pRampAttempts.length ? ` (reusing its ${pRampAttempts.length} ramp readings)` : ""}.`);
		}
	}
	if (!solved.has("p") && identifyMethod !== "model-fit") {
		const ultimate = identifyMethod === "relay"
			? await identifyRelay(effects, medianOf)
			: await seedUltimateGain(effects, medianOf);
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
				pid.p = nextBackoff(candidate.p, tries, "p"); pid.i = nextBackoff(candidate.i, tries, "i"); pid.d = nextBackoff(candidate.d, tries, "d");
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

	for (const strategy of AUTOTUNE_SIGNAL_SEQUENCE) {
		if (effects.isCancelled()) { return { ok: false, reason: "Cancelled.", attempts, ku, tu }; }
		effects.onStage?.(strategy.term, "running");
		if (solved.has(strategy.term)) {
			effects.onStage?.(strategy.term, "done");
			continue;
		}
		const isFeedForward = strategy.term === "a" || strategy.term === "v";
		const prior = strategy.term === "p" ? pPriorAttempts : [];
		// With primed readings, continue the ramp from where it stopped instead of restarting at the default.
		const startValue = prior.length
			? prior[prior.length - 1].value
			: (isFeedForward ? strategy.start : (seeded[strategy.term] ?? strategy.start));
		const ceiling = strategy.term === "d" && dCeiling != null ? dCeiling : Infinity;
		const result = await runSignalTerm(effects, strategy, pid, medianOf, verifyRetries, startValue, prior, ceiling);
		attempts.push(...result.attempts);
		if (!result.ok) {
			// P failing always means capture isn't working at all (nothing else can be trusted either) —
			// only a LATER term's measurement failure is safe to skip, precisely because P already proved
			// capture works. Without this, a permanently broken capture would silently "complete" a cycle
			// having tuned nothing at all instead of failing loudly.
			if (strategy.term !== "p" && isMeasurementFailure(result.reason ?? "")) {
				effects.onStage?.(strategy.term, "done");
				effects.log(`${strategy.label}: ${result.reason} Keeping ${strategy.term.toUpperCase()}=${pid[strategy.term]} and continuing.`);
				continue;
			}
			effects.onStage?.(strategy.term, "failed");
			return { ok: false, reason: result.reason, attempts, ku, tu };
		}
		effects.onStage?.(strategy.term, "done");
		if (result.finalSignal) { lastSignal = result.finalSignal; }
	}
	return { ok: true, attempts, itae: lastSignal?.itae, ku, tu, insensitiveTerms: cycleInsensitiveTerms };
}

// ---- Bidirectional refinement (cycles ≥2): probe each term up, then down, judged on whole-loop cost ----

/** Step-size fraction for a refinement cycle: 25% at cycle 2, halving each cycle after. */
export function refinementDelta(cycle: number): number {
	return 0.25 * Math.pow(0.5, Math.max(0, cycle - 2));
}

/**
 * Absolute step to probe from a zero-valued term — scaled well below `ZERO_START` (the first non-zero
 * value a from-scratch ramp would try), since this is a bidirectional nudge, not a fresh start.
 */
const REFINE_ZERO_STEP: Record<PidTerm, number> = { p: SEED_START / 4, i: 250, d: 0.0025, a: 12500, v: 25 };

function refineStepSize(term: PidTerm, value: number, deltaFraction: number): number {
	return value > 0 ? value * deltaFraction : REFINE_ZERO_STEP[term];
}

interface RefineTermResult {
	changed: boolean;
	/** The signal now in effect for this term (the verified new capture, or the untouched baseline). */
	signal: TuneSignal;
	attempts: Array<AutoRunAttempt>;
}

/**
 * Bidirectional local probe for one term: try `value·(1+δ)`, and — only if that isn't a significant
 * improvement — `value·(1-δ)`, keeping whichever comparison shows is a real improvement over `baseline`
 * (never a noisy tie; see `significantlyBetterForTerm`, which folds A/V's own P-term-domain objective
 * back into the whole-loop cost — plain `signalCost` can't see `pTermAccelPeak`/`pTermCruiseMean`, so
 * without this a term with no more genuine effect on tracking error could drift arbitrarily on noise).
 * An unstable probe is discarded immediately, exactly like the ramp strategies' veto. Unlike a fresh-tune
 * term, though, failing to *verify* an improvement here just reverts to the pre-refinement value instead
 * of failing the whole run — a flaky refinement pass must never wreck a tune that already works.
 */
export async function refineTerm(
	effects: TuneEffects, term: PidTerm, pid: PidConfig, baseline: TuneSignal, medianOf: number, verifyRetries: number, deltaFraction: number,
): Promise<RefineTermResult> {
	const attempts: Array<AutoRunAttempt> = [];
	const original = pid[term];
	const step = refineStepSize(term, original, deltaFraction);

	const probe = async (value: number): Promise<TuneSignal | null> => {
		pid[term] = value;
		await effects.applyPid(pid);
		await effects.delay(SETTLE_DELAY_MS);
		effects.status(`Refining: testing ${term.toUpperCase()}=${value}…`);
		const signal = await captureMedian(effects, medianOf);
		if (!signal) { return null; }
		attempts.push({ term, value });
		effects.onAttempt?.(term, value, signal);
		effects.log(`Refine ${term.toUpperCase()}=${value} → ${describeSignal(signal)}`);
		return signal;
	};

	let best = original;
	let bestSignal = baseline;
	const dp = ROUND_DP[term];
	const upValue = clampTerm(term, round(original + step, dp));
	if (upValue !== original) {
		const upSignal = await probe(upValue);
		if (upSignal && significantlyBetterForTerm(term, bestSignal, upSignal)) {
			best = upValue; bestSignal = upSignal;
		} else {
			// Down candidate: normally value·(1−δ) — but when refining V and the baseline/up-probe cruise
			// P-terms bracket zero, the interpolated crossing is the physically right proposal, not a blind
			// fixed-δ step (V's target is literally "cruise P-term = 0").
			let downValue = clampTerm(term, round(Math.max(0, original - step), dp));
			if (term === "v" && upSignal) {
				const c0 = baseline.pTermCruiseMean;
				const c1 = upSignal.pTermCruiseMean;
				if (c0 !== 0 && c1 !== 0 && Math.sign(c0) !== Math.sign(c1)) {
					downValue = clampTerm(term, interpolateVZero(original, c0, upValue, c1));
					effects.log(`Refine V: cruise P-term crossed zero between V=${original} (${c0.toFixed(1)}) and V=${upValue} (${c1.toFixed(1)}) — probing the interpolated crossing V=${downValue}.`);
				}
			}
			if (downValue !== original) {
				const downSignal = await probe(downValue);
				if (downSignal && significantlyBetterForTerm(term, bestSignal, downSignal)) { best = downValue; bestSignal = downSignal; }
			}
		}
	}

	if (best === original) {
		pid[term] = original;
		await effects.applyPid(pid);
		return { changed: false, signal: baseline, attempts };
	}

	const verified = await verifyAccepted(effects, term, pid, best, medianOf, verifyRetries);
	if (!verified.ok) {
		effects.log(`Refine ${term.toUpperCase()}: ${verified.reason} — keeping ${original}.`);
		pid[term] = original;
		await effects.applyPid(pid);
		return { changed: false, signal: baseline, attempts };
	}
	pid[term] = verified.value;
	await effects.applyPid(pid);
	effects.log(`Refine ${term.toUpperCase()}: ${original} → ${verified.value}.`);
	return { changed: true, signal: verified.signal, attempts };
}

/** Refinement cycle body (cycle ≥2): capture a fresh baseline, then bidirectionally probe every term. */
export async function refineAxisCycle(
	effects: TuneEffects, pid: PidConfig, cycle: number, medianOf: number, verifyRetries: number,
): Promise<CycleResult> {
	const attempts: Array<AutoRunAttempt> = [];
	const deltaFraction = refinementDelta(cycle);

	await effects.applyPid(pid);
	await effects.delay(SETTLE_DELAY_MS);
	effects.status("Refining: capturing baseline…");
	let current = await captureMedian(effects, medianOf);
	if (!current) {
		effects.log("Refine: baseline capture failed — skipping this cycle's refinement.");
		return { ok: true, attempts };
	}

	for (const strategy of AUTOTUNE_SIGNAL_SEQUENCE) {
		if (effects.isCancelled()) { return { ok: false, reason: "Cancelled.", attempts, itae: current.itae }; }
		effects.onStage?.(strategy.term, "running");
		const result = await refineTerm(effects, strategy.term, pid, current, medianOf, verifyRetries, deltaFraction);
		effects.onStage?.(strategy.term, "done");
		attempts.push(...result.attempts);
		if (result.changed) { current = result.signal; }
	}
	return { ok: true, attempts, itae: current.itae };
}

async function runExtruderCycle(effects: TuneEffects, pid: PidConfig, cycle: number): Promise<CycleResult> {
	const attempts: Array<AutoRunAttempt> = [];
	if (cycle === 1) { pid.i = 0; pid.d = 0; pid.v = 0; pid.a = 0; await effects.applyPid(pid); }
	for (const strategy of AUTOTUNE_SEQUENCE) {
		if (effects.isCancelled()) { return { ok: false, reason: "Cancelled.", attempts }; }
		const startValue = cycle === 1 ? strategy.start : pid[strategy.term];
		effects.onStage?.(strategy.term, "running");
		const result = await runStepTerm(effects, strategy, pid, startValue);
		attempts.push(...result.attempts);
		if (!result.ok) {
			if (strategy.term !== "p" && isMeasurementFailure(result.reason ?? "")) {
				effects.onStage?.(strategy.term, "done");
				effects.log(`${strategy.label}: ${result.reason} Keeping ${strategy.term.toUpperCase()}=${pid[strategy.term]} and continuing.`);
				continue;
			}
			effects.onStage?.(strategy.term, "failed");
			return { ok: false, reason: result.reason, attempts };
		}
		effects.onStage?.(strategy.term, "done");
	}
	return { ok: true, attempts };
}

// ---- Preflight (axis drivers only) ----

export interface PreflightResult {
	ok: boolean;
	reason?: string;
	actions: Array<string>;
}

/**
 * Force closed/assisted mode, then confirm the driver is actually tracking a commanded move with a
 * safe baseline PID. If not, run the given calibration moves once and re-probe. A saturating/runaway
 * probe (not the calibration reply text) is what "not tracking" means here. Extruders skip this
 * entirely — calibration there stays a manual Step-3 action, unchanged from before Phase 3.
 */
async function preflight(effects: TuneEffects, hasAxis: boolean, calibrationMoveIds: Array<number>): Promise<PreflightResult> {
	if (effects.isCancelled()) { return { ok: false, reason: "Cancelled.", actions: [] }; }
	if (!(await effects.ensureReady())) {
		return { ok: false, reason: "Not ready to tune (see log).", actions: [] };
	}
	if (!hasAxis) { return { ok: true, actions: [] }; }
	if (effects.isCancelled()) { return { ok: false, reason: "Cancelled.", actions: [] }; }

	const probe = async (): Promise<TuneSignal | null> => {
		await effects.applyPid({ p: SEED_START, i: 0, d: 0, v: 0, a: 0 });
		await effects.delay(SETTLE_DELAY_MS);
		return captureMedian(effects, 1);
	};

	let signal = await probe();
	if (signal && !signalUnstable(signal)) { return { ok: true, actions: [] }; }

	if (!calibrationMoveIds.length) {
		return {
			ok: false,
			actions: [],
			reason: signal
				? "The driver isn't tracking the commanded move, and no calibration is configured for this encoder type — check wiring/polarity manually."
				: "The preflight probe capture failed.",
		};
	}

	effects.log("Preflight: the driver isn't tracking a commanded move — attempting calibration.");
	const actions: Array<string> = [];
	for (const moveId of calibrationMoveIds) {
		if (effects.isCancelled()) { return { ok: false, reason: "Cancelled.", actions }; }
		const reply = await effects.runCalibration(moveId);
		actions.push(`V${moveId}`);
		effects.log(`Preflight: ran calibration V${moveId} → ${reply.slice(0, 160)}`);
	}

	signal = await probe();
	if (signal && !signalUnstable(signal)) {
		effects.log("Preflight: calibration fixed it — the driver is now tracking.");
		return { ok: true, actions };
	}
	return { ok: false, actions, reason: "Still not tracking the commanded move after calibration — check wiring/encoder setup manually." };
}

// ---- Final verification + bounded correction pass ----

const GRADE_RANK: Record<Grade, number> = { excellent: 4, good: 3, fair: 2, poor: 1, unknown: 0 };
const CORRECTION_FACTOR = 0.2; // ±20% per flagged term

/**
 * One ±20%-per-term correction derived directly from the evaluation's own findings (each finding
 * already names the term and direction to adjust) — at most one adjustment per term, only for
 * warn/bad-severity findings.
 */
export function planCorrections(evaluation: TuneEvaluation, pid: PidConfig): Array<{ term: PidTerm; value: number }> {
	const seen = new Set<PidTerm>();
	const out: Array<{ term: PidTerm; value: number }> = [];
	for (const f of evaluation.findings) {
		if (!f.term || !f.direction) { continue; }
		if (f.severity !== "warn" && f.severity !== "bad") { continue; }
		const term = f.term as PidTerm;
		if (seen.has(term)) { continue; }
		seen.add(term);
		const current = pid[term];
		let value: number;
		if (current > 0) {
			value = current * (f.direction === "up" ? 1 + CORRECTION_FACTOR : 1 - CORRECTION_FACTOR);
		} else {
			value = f.direction === "up" ? ZERO_START[term] : 0;
		}
		out.push({ term, value: clampTerm(term, round(value, 4)) });
	}
	return out;
}

interface FinalVerification {
	evaluation?: TuneEvaluation;
	correctionApplied: boolean;
}

/** Grade the tuned result; if it's below "good", try exactly one bounded correction, keeping it only if it helped. */
async function runFinalVerification(effects: TuneEffects, pid: PidConfig): Promise<FinalVerification> {
	const before = await effects.evaluateCapture();
	if (!before) { return { correctionApplied: false }; }
	if (GRADE_RANK[before.grade] >= GRADE_RANK.good) { return { evaluation: before, correctionApplied: false }; }

	const corrections = planCorrections(before, pid);
	if (!corrections.length) { return { evaluation: before, correctionApplied: false }; }

	const snapshot: PidConfig = { ...pid };
	for (const c of corrections) { pid[c.term] = c.value; }
	effects.log(`Final verification: grade "${before.grade}" — applying one correction pass (${corrections.map((c) => `${c.term.toUpperCase()}→${c.value}`).join(", ")}).`);
	await effects.applyPid(pid);
	await effects.delay(SETTLE_DELAY_MS);
	const after = await effects.evaluateCapture();

	if (after && GRADE_RANK[after.grade] >= GRADE_RANK[before.grade]) {
		effects.log(`Final verification: correction pass ${after.grade === before.grade ? "held at" : "improved it to"} "${after.grade}".`);
		return { evaluation: after, correctionApplied: true };
	}
	// The correction didn't help (or the re-check failed) — revert rather than leave a worse tune.
	Object.assign(pid, snapshot);
	await effects.applyPid(pid);
	effects.log("Final verification: the correction pass didn't help — reverted to the pre-correction values.");
	return { evaluation: before, correctionApplied: false };
}

// ---- Top-level run ----

export async function runAutoTune(effects: TuneEffects, startPid: PidConfig, opts: AutoRunOptions): Promise<AutoRunResult> {
	const medianOf = Math.max(1, opts.medianOf ?? MEDIAN_OF_DEFAULT);
	const verifyRetries = Math.max(0, opts.verifyRetries ?? VERIFY_RETRIES_DEFAULT);
	const seedRule = opts.seedRule ?? SEED_RULE_DEFAULT;
	const seedLambda = opts.seedLambda ?? SEED_LAMBDA_DEFAULT;
	const identifyMethod = opts.identifyMethod ?? IDENTIFY_METHOD_DEFAULT;
	const modelFitBackoff = opts.modelFitBackoff ?? MODEL_FIT_BACKOFF_DEFAULT;
	// Extruders (no axis) have no package/refine path — runExtruderCycle always ramps P → D → I regardless
	// of `opts.method`, so a leftover/persisted method choice from an axis driver can never change how
	// many extruder cycles run.
	const method: TuneMethod = opts.hasAxis ? (opts.method ?? METHOD_DEFAULT) : "sequential";
	// "refine" is a single joint-optimisation pass by construction (no ramp to repeat); "package" is
	// exactly cycle 1's ramp (a decent starting point) followed by exactly one joint-optimisation pass —
	// `opts.cycles` only governs how many *sequential refinement* cycles follow cycle 1.
	const totalCycles = method === "refine" ? 1 : method === "package" ? 2 : Math.max(1, Math.round(opts.cycles || 1));

	const readBack = await effects.readPid();
	const restoreTarget: PidConfig = readBack ?? { ...startPid };
	const pid: PidConfig = { ...startPid };
	const attempts: Array<AutoRunAttempt> = [];
	let ku: number | undefined, tu: number | undefined;
	let preflightActions: Array<string> = [];

	effects.log(`Auto-tune config: method=${method}, identify=${identifyMethod}, seedRule=${seedRule}, medianOf=${medianOf}, cycles=${totalCycles}${opts.captureBudget != null ? `, captureBudget=${opts.captureBudget}` : ""}.`);

	// Raise E BEFORE preflight's own probe capture runs — that probe can already produce a large
	// transient error on a fresh axis, so the window this closes has to start here, not at the first
	// ramp/seed stage's own applyPid(). M569.1 only changes the parameters it's given, so leaving E off
	// every other call site in this run (preflight's probe included) can never revert it early.
	const priorWarn = restoreTarget.warn ?? "unset", priorErr = restoreTarget.err ?? "unset";
	effects.log(`Raising M569.1 error thresholds to E${TUNING_WARN_THRESHOLD}:${TUNING_ERR_THRESHOLD} for this run (was E${priorWarn}:${priorErr} — restored afterward).`);
	pid.warn = TUNING_WARN_THRESHOLD;
	pid.err = TUNING_ERR_THRESHOLD;
	await effects.applyPid(pid);

	let ok = true;
	let reason: string | undefined;
	try {
		effects.onStage?.("preflight", "running");
		const pre = await preflight(effects, opts.hasAxis, opts.calibrationMoveIds ?? []);
		effects.onStage?.("preflight", pre.ok ? "done" : "failed");
		preflightActions = pre.actions;
		if (!pre.ok) {
			// Preflight's own probe may already have applied a baseline PID to the firmware — fall through
			// to the same restore path every other failure uses, rather than leaving that baseline in place.
			ok = false;
			reason = pre.reason ?? "Preflight failed.";
		}
		let prevItae: number | undefined;
		// Terms cycle 1's model-fit found to have no measurable effect — passed into a later package/
		// optimise pass so it seeds them with a smaller step instead of re-discovering the same thing.
		let insensitiveTerms: Array<PidTerm> = [];
		for (let cycle = 1; ok && cycle <= totalCycles; cycle++) {
			if (effects.isCancelled()) { ok = false; reason = "Cancelled."; break; }
			effects.log(`──── Cycle ${cycle} of ${totalCycles} ────`);
			const result = opts.hasAxis
				? await runAxisCycle(effects, pid, cycle, medianOf, verifyRetries, seedRule, seedLambda, method, opts.captureBudget, identifyMethod, modelFitBackoff, insensitiveTerms, opts.dCeiling)
				: await runExtruderCycle(effects, pid, cycle);
			attempts.push(...result.attempts);
			if (result.ku != null) { ku = result.ku; tu = result.tu; }
			if (result.insensitiveTerms) { insensitiveTerms = result.insensitiveTerms; }
			if (!result.ok) { ok = false; reason = result.reason; break; }
			if (result.itae != null) {
				// Cycle 2 is the first cycle that actually refines (cycle 1 seeds/ramps from scratch), so
				// give it a full, unjudged pass — the plateau check only starts comparing from cycle 3.
				if (prevItae != null && cycle > 2) {
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
		return { ok: false, reason, pid: restoreTarget, restored: true, attempts, ku, tu, preflightActions };
	}

	// Success keeps the newly tuned P/I/D/V/A, but E (warn/err) must go back to whatever was actually on
	// the driver before this run started — not the elevated tuning-only thresholds still sitting in `pid`
	// (see the top of this function). Otherwise a successful tune would silently widen the user's own
	// error-detection thresholds forever, the exact opposite of the point of restoring them at all.
	if (pid.warn !== restoreTarget.warn || pid.err !== restoreTarget.err) {
		pid.warn = restoreTarget.warn;
		pid.err = restoreTarget.err;
		await effects.applyPid(pid);
	}

	let evaluation: TuneEvaluation | undefined;
	effects.onStage?.("verify", "running");
	try {
		const verification = await runFinalVerification(effects, pid);
		evaluation = verification.evaluation;
		effects.onStage?.("verify", "done");
	} catch (e) {
		effects.log(`Final verification skipped: ${e instanceof Error ? e.message : String(e)}`);
		effects.onStage?.("verify", "failed");
	}
	return { ok: true, pid, attempts, ku, tu, preflightActions, evaluation };
}
