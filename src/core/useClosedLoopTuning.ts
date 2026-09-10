/**
 * The whole Closed Loop Tuning page — persisted UI state, machine I/O, the auto-tune orchestration
 * and, critically, the travel-limit/kinematics safety gate — as one composable shared verbatim by
 * BOTH DuetWebControl generations.
 *
 * Why this exists: `ui37/ClosedLoopTuning.vue` and `ui36/ClosedLoopTuningPage.vue` are two genuinely
 * different templates (Vuetify 4 vs Vuetify 2 — see docs/PLAN-dwc36-backport.md §6), but they drove
 * identical logic, which briefly lived as ~1000 duplicated lines in each page. That is an unacceptable
 * shape for safety-critical code: a fix to `coupledAxesForDriver`/`ensureAxisReady`/`captureRaw` had
 * to be made twice, nothing enforced that it was, and the 3.6 copy has no type-checker watching it
 * (DWC 3.6 ships no vue-tsc). Now there is exactly one copy and the pages are only markup.
 *
 * Everything here is framework-agnostic in the sense that matters: it uses only the Composition API
 * (present in Vue 2.7 and Vue 3), reaches DWC solely through the injected `HostAdapter` (./host), and
 * imports `dwc-plugin-runtime` by deep subpath only — never the barrel, which re-exports Vue 3
 * components that Vue 2.7 cannot compile.
 *
 * The caller supplies the host, so the same code talks to Pinia on 3.7 and Vuex on 3.6:
 *
 *   const { step, pid, startAutoTune, ... } = useClosedLoopTuning(createHost());
 */
import { computed, reactive, ref, watch } from "vue";

// Subpath, not the barrel — see the note above.
import { buildReport, downloadReport } from "dwc-plugin-runtime/diagnostics";

import { isMachineUnsafeForTuning, type HostAdapter } from "./host";
import { evaluateTune, gradeColor, severityColor, severityIcon, type Term, type TuneEvaluation } from "../model/evaluate";
import { ACCEL_CAPTURE_DIR, CAPTURE_DIR, CONFIG_FILE, DOCS, LS_STATE, PLUGIN_ID } from "../model/constants";
import { upsertTuneBlock } from "../model/config";
import { stepJumpDistanceMm, stepJumpFeedMmPerMin } from "../model/scale";
import {
	buildCalibrationCommand, buildCaptureCommand, buildModeCommand, buildPidCommand,
	CALIBRATION_MOVES, CAPTURE_VARIABLES, DEFAULT_MODE_D, ENCODER_TYPES, MODE_LABELS,
	parsePidReply, type CalibrationMove, type EncoderType, type LoopMode, type PidConfig,
} from "../model/m569";
import { achievedRateHz, parseCapture, type ParsedCapture } from "../model/csv";
import { analyzeCapture, analyzeMove, buildSeries, segmentMove, type StepMetrics } from "../model/analysis";
import {
	CENTER_TOLERANCE_MM, CENTERING_FEED_MM_MIN, DEFAULT_MARGIN_MM, envelopeFeedMmPerMin,
	getAxisLimits, midpoint, planCaptureProfile, planCoupledSymmetricMove, rateCeilingForBoard,
	rateCeilingForCapture, type CoupledAxisLimits,
} from "../model/limits";
import { resolveMotionCoupling } from "../model/kinematics";
import { evaluateEnvelope } from "../model/modelfit";
import { WIZARD_STEPS, type Recommendation } from "../model/wizard";
import { D_MAX } from "../model/autotune";
import {
	ACCEL_ASSUMED_RATE_HZ, accelSampleCount, buildAccelCaptureCommand, findAccelerometers, isAccelOnlyError,
	type AccelerometerInfo,
} from "../model/accelerometer";
import { firmwareAtLeast } from "../model/firmwareVersion";
import { parseAccelCapture, type AccelCapture } from "../model/accelCsv";
import { computeVibration, VIBRATION_MIN_COVERAGE, type Vibration } from "../model/vibration";
import { computeTuneSignal, type TuneSignal } from "../model/signal";
import {
	runAutoTune as runAutoTuneCore,
	type AutoRunOptions, type AutoRunResult, type EnvelopeCheck, type IdentifyMethod, type SeedRule,
	type StageId, type StageState, type TuneEffects, type TuneMethod,
} from "../model/autorun";
import { downsampleCapture, isNotableCapture, shapeCapturesForDownload, slimModelForReport, type ReportCapture } from "../model/report";
import { applying, applyUpdateNow, checking, dismissCurrentUpdate, pendingReload, runUpdateCheck, setUpdateChecksEnabled, updateChecksEnabled, updateState } from "../updateCheck";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * A plugin-supplied extra button in the About dialog's Diagnostics section. Structurally identical to
 * `dwc-plugin-runtime`'s `AboutExtraAction`, redeclared here so this module never imports the runtime
 * barrel (which also exports Vue 3 components). The 3.7 page passes these straight to the runtime's
 * AboutDialog; the 3.6 page to its own local one.
 */
export interface AboutExtraAction {
	label: string;
	icon?: string;
	color?: string;
	disabled?: boolean;
	onClick: () => void;
}

/**
 * Delete a capture CSV the plugin itself just created, if the "delete after read" setting is on.
 * Best-effort: swallows a failed delete (logs a warning) rather than letting it break the tuning run —
 * a stale file left on the SD card is a much smaller problem than aborting mid-run over it. Extracted
 * as its own top-level function (rather than inlined in loadLatestCsv below) so this can be unit
 * tested without a full capture-cycle mock — see docs/PLAN-standstill-effort.md §6.
 */
export async function maybeDeleteCapture(
	host: Pick<HostAdapter, "deleteFile">, path: string, enabled: boolean,
	warn: (...args: Array<unknown>) => void = console.warn,
): Promise<void> {
	if (!enabled) { return; }
	try { await host.deleteFile(path); } catch (e) { warn("[ClosedLoopTuning] failed to delete capture after read", path, e); }
}

/**
 * @param host how to reach this DuetWebControl — `ui37/host.ts` (Pinia) or `ui36/host.ts` (Vuex).
 *             Must be created inside component setup on 3.7, where Pinia requires an active instance.
 */
export function useClosedLoopTuning(host: HostAdapter) {


	// Excludes `derived` entries (e.g. combined current) — those are never recorded by the firmware, only
	// computed client-side once their source columns exist (see csv.ts, m569.ts). `availableViewVars`
	// below needs no equivalent filter: it already only lists what's actually present in the capture.
	const captureVariables = CAPTURE_VARIABLES.filter((v) => !v.derived);
	const encoderTypes = ENCODER_TYPES;
	const steps = WIZARD_STEPS;
	const modeList = (Object.keys(MODE_LABELS) as Array<LoopMode>).map((value) => ({ value, label: MODE_LABELS[value] }));
	const modeHelp: Record<LoopMode, string> = {
		open: "Normal stepper operation with no feedback. Use this for homing, then switch to closed/assisted.",
		assisted: "Runs open-loop but uses the encoder to assist — correcting and preventing lost steps. Simpler to tune (P≈200, D/I usually 0).",
		closed: "Full closed-loop PID position control from the encoder. Best accuracy; needs the PID terms tuned below.",
	};
	const stepTitles = ["1. Driver", "2. Loop mode", "3. Calibrate", "4. Tune PID", "5. Test & save"];

	// Persisted UI state — restored on mount so navigating away and back keeps your place.
	interface SavedState {
		step?: number; wizardIndex?: number; selectedDriver?: string | null; currentMode?: LoopMode | null;
		encoderType?: EncoderType; modeD?: Partial<typeof DEFAULT_MODE_D>; pid?: Partial<PidConfig>;
		samples?: number; sampleRate?: number; moveMode?: "step" | "custom"; customMove?: string;
		recordKeys?: Array<string>; viewKeys?: Array<string>; avFeed?: number; cycles?: number;
		marginMm?: number;
		/** Tuning move distance, mm; 0/undefined = auto (longest reasonable). New key (not `avDistance`) so
		 * an existing session's persisted 50 mm default doesn't silently keep overriding the new auto mode. */
		tuneDistanceMm?: number;
		tuneMethod?: TuneMethod; identifyMethod?: IdentifyMethod; modelFitBackoff?: number;
		seedRule?: SeedRule; seedLambda?: number; medianOf?: number; captureBudget?: number;
		includeAllCsv?: boolean;
		/** Delete each capture CSV from 0:/sys/closed-loop right after it's been read into memory — see
		 *  deleteTrackedCapture(). Off by default: deleting files off the user's SD card unprompted is
		 *  the kind of thing that should be opted into. */
		deleteCapturesAfterRead?: boolean;
		/** Manual cap on D during auto-tune's sequential ramp; null/undefined = no extra cap. */
		dCeiling?: number | null;
		/** Arm an M956 accelerometer capture alongside every closed-loop capture, when one is available.
		 *  Off by default: it writes an extra file per capture and most users have no accelerometer. */
		recordVibration?: boolean;
		/** User's explicit accelerometer choice (CAN address); null/undefined = auto-pick. */
		selectedAccelerometerAddress?: number | null;
	}
	function loadState(): SavedState {
		try { return JSON.parse(localStorage.getItem(LS_STATE) ?? "{}") as SavedState; } catch { return {}; }
	}
	const saved = loadState();

	const step = ref(saved.step ?? 1);
	const selectedDriver = ref<string | null>(saved.selectedDriver ?? null);
	const currentMode = ref<LoopMode | null>(saved.currentMode ?? null);
	const encoderType = ref<EncoderType>(saved.encoderType ?? 2);
	const modeD = reactive({ ...DEFAULT_MODE_D, ...(saved.modeD ?? {}) });
	const pid = reactive<PidConfig>({ p: 100, i: 0, d: 0, v: 0, a: 0, warn: null, err: null, ...(saved.pid ?? {}) });
	const applyingPid = ref(false);

	const samples = ref(saved.samples ?? 2000);
	const sampleRate = ref(saved.sampleRate ?? 2000);
	const moveMode = ref<"step" | "custom">(saved.moveMode ?? "step");
	const customMove = ref(saved.customMove ?? "G91 G1 H2 X50 F6000 G90");
	const recordKeys = ref<Array<string>>(saved.recordKeys ?? ["measuredMotorSteps", "targetMotorSteps", "currentError", "pidPTerm"]);
	const recording = ref(false);

	const capture = ref<ParsedCapture | null>(null);
	const overlayCapture = ref<ParsedCapture | null>(null);
	const rawText = ref<string>("");
	const metrics = ref<StepMetrics | null>(null);
	const viewKeys = ref<Array<string>>(saved.viewKeys ?? ["measuredMotorSteps", "targetMotorSteps", "currentError"]);

	const wizardIndex = ref(saved.wizardIndex ?? 0);
	const recommendation = ref<Recommendation | null>(null);

	// Applies to every capture the plugin itself triggers, auto-tune or manual "Record" alike — both
	// go through loadLatestCsv() below. Off by default (see SavedState.deleteCapturesAfterRead).
	const deleteCapturesAfterRead = ref(saved.deleteCapturesAfterRead ?? false);

	// Off by default: it writes an extra file per capture and most users have no accelerometer. See
	// SavedState.recordVibration and captureRaw()'s use of accelerometerBoard/canRecordVibration below.
	const recordVibration = ref(saved.recordVibration ?? false);

	// Save the lightweight selections (not the captured CSV) whenever they change, debounced.
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	function persistState(): void {
		if (saveTimer) { clearTimeout(saveTimer); }
		saveTimer = setTimeout(() => {
			try {
				localStorage.setItem(LS_STATE, JSON.stringify({
					step: step.value, wizardIndex: wizardIndex.value, selectedDriver: selectedDriver.value,
					currentMode: currentMode.value, encoderType: encoderType.value, modeD: { ...modeD }, pid: { ...pid },
					samples: samples.value, sampleRate: sampleRate.value, moveMode: moveMode.value,
					customMove: customMove.value, recordKeys: recordKeys.value, viewKeys: viewKeys.value,
					tuneDistanceMm: avDistance.value, avFeed: avFeed.value, cycles: cycles.value, marginMm: marginMm.value,
					tuneMethod: tuneMethod.value, identifyMethod: identifyMethod.value, modelFitBackoff: modelFitBackoff.value,
					seedRule: seedRule.value, seedLambda: seedLambda.value, medianOf: medianOf.value,
					captureBudget: captureBudget.value, includeAllCsv: includeAllCsv.value,
					deleteCapturesAfterRead: deleteCapturesAfterRead.value, dCeiling: dCeiling.value,
					recordVibration: recordVibration.value, selectedAccelerometerAddress: selectedAccelerometerAddress.value,
				} satisfies SavedState));
			} catch { /* storage unavailable */ }
		}, 300);
	}
	watch([step, wizardIndex, selectedDriver, currentMode, encoderType, modeD, pid, samples, sampleRate, moveMode, customMove, recordKeys, viewKeys, deleteCapturesAfterRead, recordVibration],
		persistState, { deep: true });

	// --- Auto-tune ---
	const autoRunning = ref(false);
	const autoCancel = ref(false);
	const autoStatus = ref("");
	const autoLog = ref<Array<string>>([]);

	// Stage-status timeline: preflight → P → A → V → D → I → [optimize] → verify (P–I repeat every cycle;
	// "optimize" only fires for the package/refine methods, so it's only shown then).
	const STAGE_ORDER = computed<Array<{ id: StageId; label: string }>>(() => {
		const order: Array<{ id: StageId; label: string }> = [
			{ id: "preflight", label: "Preflight" }, { id: "p", label: "P" }, { id: "a", label: "A" },
			{ id: "v", label: "V" }, { id: "d", label: "D" }, { id: "i", label: "I" },
		];
		if (tuneMethod.value !== "sequential") { order.push({ id: "optimize", label: "Optimise" }); }
		order.push({ id: "verify", label: "Verify" });
		return order;
	});
	const stageStates = reactive<Record<StageId, StageState>>({ preflight: "pending", p: "pending", d: "pending", i: "pending", a: "pending", v: "pending", optimize: "pending", verify: "pending" });
	function resetStageStates(): void { for (const id of Object.keys(stageStates) as Array<StageId>) { stageStates[id] = "pending"; } }
	function stageColor(state: StageState): string | undefined {
		switch (state) {
			case "running": return "primary";
			case "done": return "success";
			case "failed": return "error";
			default: return undefined;
		}
	}
	function stageIcon(state: StageState): string {
		switch (state) {
			case "running": return "mdi-progress-clock";
			case "done": return "mdi-check-circle";
			case "failed": return "mdi-close-circle";
			default: return "mdi-circle-outline";
		}
	}
	const avDistance = ref(saved.tuneDistanceMm ?? 0); // mm — tuning move length; 0 = auto (longest reasonable)
	const avFeed = ref(saved.avFeed ?? 6000);          // mm/min — A/V test move feedrate
	const cycles = ref(saved.cycles ?? 3);             // how many times to iterate P→A→V→D→I
	const marginMm = ref(saved.marginMm ?? DEFAULT_MARGIN_MM); // mm — kept clear of each travel limit

	// Tuning method (axis drivers only — extruders always use "sequential") + its advanced options.
	const TUNE_METHODS: Array<{ value: TuneMethod; label: string; subtitle: string }> = [
		{ value: "sequential", label: "Standard", subtitle: "Duet order (P→A→V→D→I), then refine every term each cycle." },
		{ value: "package", label: "Thorough", subtitle: "Standard first pass, then jointly optimise every term together under a capture budget." },
		{ value: "refine", label: "Refine", subtitle: "Jointly optimise from whatever's on the driver now — no reset, no from-scratch ramp." },
	];
	const tuneMethod = ref<TuneMethod>(saved.tuneMethod ?? "sequential");
	const IDENTIFY_METHODS: Array<{ value: IdentifyMethod; label: string }> = [
		{ value: "model-fit", label: "Model fit" },
		{ value: "continuous-cycling", label: "Continuous cycling" },
		{ value: "relay", label: "Relay feedback" },
	];
	const identifyMethod = ref<IdentifyMethod>(saved.identifyMethod ?? "model-fit");
	const modelFitBackoff = ref(saved.modelFitBackoff ?? 0.65); // fraction of the effort-rail-onset P used as P*
	const SEED_RULES: Array<{ value: SeedRule; title: string }> = [
		{ value: "tyreus-luyben", title: "Tyreus–Luyben (conservative, default)" },
		{ value: "zn-classic", title: "Ziegler–Nichols (classic)" },
		{ value: "amigo", title: "AMIGO-scaled (λ below)" },
	];
	const seedRule = ref<SeedRule>(saved.seedRule ?? "tyreus-luyben");
	const seedLambda = ref(saved.seedLambda ?? 1);       // aggressiveness for the "amigo" seed rule
	const medianOf = ref(saved.medianOf ?? 1);           // captures per decision, median-combined
	const captureBudget = ref(saved.captureBudget ?? 40); // extra captures for the package/refine joint optimiser
	const includeAllCsv = ref(saved.includeAllCsv ?? false); // download every capture's raw CSV, not just the notable/last-per-phase ones
	/**
	 * Manual cap on D during auto-tune's "sequential" ramp, below the firmware's own D_MAX — for a
	 * machine where a persistent mechanical ripple (e.g. a ballscrew) means "more D" is never the right
	 * answer past some point. `null` = no extra cap (today's behaviour); the automatic diminishing-
	 * returns check (docs/PLAN-v2.4-feedback.md §2.1) already stops runaway ramps without this, so this
	 * is a manual override on top, not a replacement for it.
	 */
	const dCeiling = ref<number | null>(saved.dCeiling ?? null);
	watch([avDistance, avFeed, cycles, marginMm, tuneMethod, identifyMethod, modelFitBackoff, seedRule, seedLambda, medianOf, captureBudget, includeAllCsv, dCeiling], persistState);

	/** Rough move-count estimate shown next to the method select, so the cost of "Thorough" is visible upfront. */
	const estimatedMoves = computed(() => {
		const perRampCycle = 5 * 6;   // 5 terms × ~6 captures (ramp + verify) for a from-scratch cycle
		const perRefineCycle = 5 * 3; // 5 terms × ~3 captures (up/down probe + verify) for a refinement cycle
		switch (tuneMethod.value) {
			case "refine": return captureBudget.value;
			case "package": return perRampCycle + captureBudget.value;
			default: return perRampCycle + Math.max(0, cycles.value - 1) * perRefineCycle;
		}
	});

	const confirmOpen = ref(false);
	const confirmCommand = ref("");
	const confirmMessage = ref("");
	const DEFAULT_CONFIRM_MESSAGE = "This will move the selected driver. On an axis with known travel limits it "
		+ "will first centre the axis and then keep moves within the configured margin of min/max — but that only "
		+ "works once the axis is homed. Extruders, or axes the object model hasn't reported a position for yet, "
		+ "aren't checked at all, so make sure there's room to move.";
	let confirmAction: (() => Promise<void>) | null = null;
	let confirmResolve: ((ok: boolean) => void) | null = null;

	// --- About dialog + manual-panel control + live evaluation ---
	const aboutOpen = ref(false);
	const manualPanels = ref<number | undefined>(undefined);

	/**
	 * Automatic plain-language verdict on the most recent capture (see model/evaluate.ts).
	 *
	 * `lastVibration` is safe to pair with `capture.value` here: there is exactly ONE assignment to
	 * `capture.value` (in `loadLatestCsv`), reached only immediately after this plugin's own M569.5
	 * capture completes — there is no path that loads an arbitrary/older capture — and `collectAccel`
	 * clears `lastVibration` on entry, so the only transient is a brief window where it is null (absent,
	 * never mismatched) while the accelerometer file is still being read. Report-only either way: the
	 * vibration can only add an informational finding, never move the score or grade (evaluate.ts's
	 * `note` vs `add`). Declared later in this file, but this getter only runs after setup completes.
	 */
	const evaluation = computed<TuneEvaluation | null>(
		() => capture.value ? evaluateTune(capture.value, sampleRate.value, lastVibration.value ?? undefined) : null);
	const gradeIcon = computed(() => {
		switch (evaluation.value?.grade) {
			case "excellent": return "mdi-star-circle";
			case "good": return "mdi-check-circle";
			case "fair": return "mdi-alert-circle";
			case "poor": return "mdi-close-circle";
			default: return "mdi-help-circle";
		}
	});
	/** Jump to a term in the manual tuner (expands the panel) when the user clicks a fix suggestion. */
	function goToManualTerm(term: Term): void {
		const idx = WIZARD_STEPS.findIndex((s) => s.term === term);
		if (idx >= 0) { wizardIndex.value = idx; }
		manualPanels.value = 0;
		step.value = 4;
	}


	// --- Auto-tune session capture (for the downloadable results report) ---
	// A run makes 30-60+ captures; storing the full raw CSV for every one of them made the report several
	// MB. Each capture now always carries a compact downsampled error series + its metrics, and only keeps
	// its full CSV when `shapeCapturesForDownload` decides it's worth it (see report.ts) — the raw text is
	// still HELD in memory for the whole session so "include all raw CSVs" can restore it on demand.
	interface SessionCapture extends ReportCapture { /* seq/phase/value/metrics/series/csv/notable — see report.ts */ }
	interface StageEvent { stage: StageId; state: StageState; at: string }
	interface TuneSession {
		startedAt: string; finishedAt?: string; driver: string | null; mode: LoopMode | null;
		encoderType: EncoderType; cycles: number; finalPid?: PidConfig; log: Array<string>;
		captures: Array<SessionCapture>; evaluation?: TuneEvaluation | null;
		/** Ultimate gain/period found during Ku/Tu seeding, when it succeeded. */
		ku?: number; tu?: number;
		/** Whether the tune holds (no saturation) at the axis's own configured max — report-only, never
		 *  fed back into the tune. See docs/PLAN-envelope-check.md. */
		envelopeCheck?: EnvelopeCheck;
		/** Calibration moves (M569.6 V-ids) actually run during preflight. */
		preflightActions?: Array<string>;
		/** True if the run failed/was cancelled and the pre-run PID snapshot was restored. */
		restored?: boolean;
		/** Tuning method actually used ("sequential" always, for extruders regardless of the UI selection). */
		method?: TuneMethod;
		/** The full option set the run was started with — method, order, medianOf, budget, seed rule. */
		optionsUsed?: AutoRunOptions;
		/** Stage transitions with timestamps, for reconstructing the run's timeline from the report alone. */
		stageTimeline: Array<StageEvent>;
		reportVersion: number;
	}
	const REPORT_VERSION = 2;
	const tuneSession = ref<TuneSession | null>(null);
	let sessionSeq = 0;
	/** Uncapped session log (the report's own copy) — `autoLog` stays capped at 40 lines for display only. */
	let sessionLog: Array<string> = [];
	function recordSessionCapture(phase: string, value: number | undefined, metrics: unknown): void {
		if (!tuneSession.value || !rawText.value) { return; }
		const series = capture.value ? (downsampleCapture(capture.value, sampleRate.value) ?? undefined) : undefined;
		tuneSession.value.captures.push({ seq: sessionSeq++, phase, value, metrics, series, csv: rawText.value, notable: isNotableCapture(metrics) });
	}
	function downloadTuningReport(): void {
		if (!tuneSession.value) { return; }
		const version = ((host.model() as any)?.plugins?.get?.("ClosedLoopTuning")?.version) ?? "unknown";
		const axisObj = axisForDriver();
		const model = slimModelForReport(
			selectedBoard.value ? { firmwareName: selectedBoard.value.firmwareName, firmwareVersion: selectedBoard.value.firmwareVersion, canAddress: selectedBoard.value.canAddress, closedLoop: selectedBoard.value.closedLoop } : null,
			(host.model() as any).move?.kinematics?.name,
			axisObj ? { letter: axisObj.letter, min: axisObj.min, max: axisObj.max, stepsPerMm: axisObj.stepsPerMm, microstepping: axisObj.microstepping, homed: axisObj.homed } : null,
		);
		const state: TuneSession = { ...tuneSession.value, captures: shapeCapturesForDownload(tuneSession.value.captures, includeAllCsv.value) };
		const report = buildReport({ pluginId: PLUGIN_ID, pluginVersion: version, model, state, note: "Closed Loop auto-tune session (log + capture summaries; full CSV kept for notable/final captures unless \"include all\" was checked)" });
		downloadReport(report, `closed-loop-tuning-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
	}

	// About dialog (standardised runtime AboutDialog) wiring.
	const aboutDescription = "Tunes Duet 3 closed-loop drivers: loop mode, encoder calibration, and automatic PID + feed-forward tuning with capture analysis.";
	const autoCheck = ref(updateChecksEnabled());
	const aboutExtraActions = computed<Array<AboutExtraAction>>(() => [
		{ label: tuneSession.value ? "Download tuning report" : "Download tuning report (run auto-tune first)", icon: "mdi-download", color: "primary", disabled: !tuneSession.value, onClick: downloadTuningReport },
	]);
	function onCheckUpdate(): void { void runUpdateCheck({ force: true, notify: true }); }
	function onToggleAutoCheck(v: boolean): void { autoCheck.value = v; setUpdateChecksEnabled(v); }

	// --- Update banner ---
	const updateBanner = computed(() => {
		const s = updateState.value;
		return s?.updateAvailable ? `Closed Loop Tuning v${s.latestVersion} is available.` : "";
	});
	function reloadPage(): void { window.location.reload(); }

	// --- Drivers from the object model ---
	interface DriverEntry { name: string; value: string }
	const drivers = computed<Array<DriverEntry>>(() => {
		const model = host.model() as any;
		const boards = model.boards ?? [];
		// Closed-loop support shows up in the object model two different ways (@duet3d/objectmodel):
		//  - `board.closedLoop` ({ points, runs }) — an aggregate Duet3D's own 1HCL/M23CL firmware populates,
		//    and the same field this plugin's capture-completion detection watches (see `record()`/`waitForRuns`).
		//  - `board.drivers[i].closedLoop` ({ currentFraction, positionError }) — generic per-driver closed-
		//    loop telemetry that ANY RRF board running closed-loop control populates, Duet or third-party.
		// A third-party closed-loop toolboard may report the second without the first, so a driver counts as
		// closed-loop-capable if EITHER is present — checking only the board-level aggregate (as before)
		// hid every non-Duet3D closed-loop driver from the list entirely.
		const hasCl = (boardAddr: string, driverIndex: number) => {
			const board = boards.find((b: any) => b && b.canAddress === parseInt(boardAddr));
			if (!board) { return false; }
			if (board.closedLoop != null) { return true; }
			return board.drivers?.[driverIndex]?.closedLoop != null;
		};
		const out: Array<DriverEntry> = [];
		for (const axis of model.move?.axes ?? []) {
			for (const drv of axis.drivers ?? []) {
				const id = `${drv.board}.${drv.driver}`;
				if (hasCl(String(drv.board), drv.driver)) { out.push({ name: `${axis.letter} axis (driver ${id})`, value: id }); }
			}
		}
		(model.move?.extruders ?? []).forEach((ex: any, idx: number) => {
			const drv = ex?.driver;
			if (!drv) { return; }
			const id = `${drv.board}.${drv.driver}`;
			if (hasCl(String(drv.board), drv.driver)) { out.push({ name: `Extruder ${idx} (driver ${id})`, value: id }); }
		});
		return out;
	});

	const selectedBoard = computed<any>(() => {
		if (!selectedDriver.value) { return null; }
		const addr = parseInt(selectedDriver.value.split(".")[0]);
		return (host.model() as any).boards?.find((b: any) => b && b.canAddress === addr) ?? null;
	});

	/**
	 * RRF 3.7.0-rc.1 restructured M956's P from a DriverId (which also routed the command over CAN) to a
	 * small accelerometer index carrying no routing information at all — see
	 * docs/PLAN-rc1-accelerometer-addressing.md. The relevant firmware is `boards[0]`, the board DWC is
	 * actually connected to and which parses the M956 text — NOT `selectedBoard` (the tuned driver's own
	 * board) and NOT the accelerometer's own board (`accelerometerBoard`, below): this codebase's own
	 * existing comments already note the accelerometer is often on a different board from either of those.
	 */
	const useAccelNumberAddressing = computed(() =>
		firmwareAtLeast((host.model() as any).boards?.[0]?.firmwareVersion, "3.7.0-rc.1"));

	// --- Accelerometer / vibration (docs/PLAN-accelerometer.md §5, §8) ---
	const accelerometers = computed(() => findAccelerometers(host.model()));
	/** User's explicit choice from the accelerometer selector, by CAN address; null = auto-pick. Not
	 *  persisted across a board being unplugged/renumbered — re-validated against the live list below on
	 *  every read, so a stale saved address just falls back to auto-pick rather than silently misfiring. */
	const selectedAccelerometerAddress = ref<number | null>(saved.selectedAccelerometerAddress ?? null);
	// Declared after both existing persisted-settings watch arrays, so it gets its own — same effect,
	// just one more line rather than restructuring either array.
	watch(selectedAccelerometerAddress, persistState);
	/** Prefer the user's explicit selection if it's still a real accelerometer; else the tuned driver's
	 *  own board if it has one; else the first available. Confirmed in the field: the accelerometer is
	 *  often on a DIFFERENT board from the driver being tuned, so auto-pick must never assume they match. */
	const accelerometerBoard = computed<AccelerometerInfo | null>(() => {
		const all = accelerometers.value;
		if (all.length === 0) { return null; }
		const chosen = all.find((a) => a.boardAddress === selectedAccelerometerAddress.value);
		if (chosen) { return chosen; }
		const own = selectedBoard.value?.canAddress;
		return all.find((a) => a.boardAddress === own) ?? all[0];
	});
	/**
	 * Set once the accelerometer has failed in a way that makes re-arming it a bad idea, which stops this
	 * session arming it again. Two reasons to latch rather than just retry: a capture that never finished
	 * may still hold the accelerometer ("Accelerometer is already collecting data" fails the NEXT M956,
	 * and that M956 shares a line with the closed-loop capture), and a failure that repeats every capture
	 * would otherwise cost ACCEL_WAIT_MS each time across a run of hundreds. Cleared by toggling
	 * `recordVibration` off and on again — the natural "I've fixed it, try again" gesture.
	 */
	const accelDisabledReason = ref<string | null>(null);
	/** Consecutive soft failures (arm rejected, read/parse failed) — a few are tolerated before latching
	 *  off, since any one of them can be a one-off (e.g. a capture from BEFORE this session still finishing
	 *  up on the accelerometer) rather than something actually wrong. */
	let accelSoftFailures = 0;
	const ACCEL_SOFT_FAILURE_LIMIT = 3;
	function disableAccel(reason: string): void {
		if (accelDisabledReason.value) { return; }
		accelDisabledReason.value = reason;
		log(`Vibration: ${reason} Vibration recording is off for the rest of this session — untick and re-tick "Record vibration" to try again.`);
	}
	function noteAccelSoftFailure(reason: string): void {
		if (++accelSoftFailures >= ACCEL_SOFT_FAILURE_LIMIT) { disableAccel(`${reason} ${accelSoftFailures} times in a row.`); }
		else { log(`Vibration: ${reason} Continuing without it for this capture.`); }
	}
	watch(recordVibration, () => { accelDisabledReason.value = null; accelSoftFailures = 0; accelRetryAfter = 0; });

	/**
	 * Backoff until this timestamp before arming the accelerometer again, set whenever RRF rejects an M956
	 * arm (almost always "already collecting data" — see armAccel's caller). Found on real hardware: without
	 * this, a capture that fails for an unrelated reason (e.g. the driver not yet tracking) retries
	 * immediately, re-arms M956 while the FIRST attempt's capture is still genuinely running, gets rejected
	 * again, and repeats every retry — burning the whole retry budget on an accelerometer problem instead of
	 * ever getting a real tuning capture. Skipping the accelerometer for a few seconds after a rejection lets
	 * that still-running capture actually finish.
	 */
	let accelRetryAfter = 0;
	const ACCEL_ARM_BACKOFF_MS = 5000;

	const canRecordVibration = computed(() =>
		recordVibration.value && accelerometerBoard.value != null && accelDisabledReason.value == null);
	/** The last accelerometer capture's raw per-axis series, for the vibration chart — a separate ref
	 *  from `vibration` on the TuneSignal (that's the computed summary; this is what a chart needs to draw
	 *  an actual trace). Null whenever the last attempt had no usable vibration data. */
	const accelCapture = ref<AccelCapture | null>(null);
	/** Metrics for the capture in `accelCapture`, so the chart can state what was measured (and how
	 *  coarsely) rather than leaving the trace to be read by eye. Cleared alongside it. */
	const lastVibration = ref<Vibration | null>(null);
	/**
	 * Real rate of the last accelerometer capture, from its trailer. M956 takes a sample COUNT, not a
	 * rate, so the count has to be sized against an assumed rate — and getting that wrong low truncates
	 * the capture. After the first successful read the rate is known, so every later capture is sized
	 * exactly instead of against ACCEL_ASSUMED_RATE_HZ's deliberately-high guess.
	 */
	const lastAccelRateHz = ref<number | null>(null);

	/** Safe capture-rate ceiling for the selected driver's board — applied to every capture path (manual
	 * record, wizard step, auto-tune's own trapezoid move), not just the auto-sized one, since a
	 * rate-constrained board would truncate on any of them at the default rate. See rateCeilingForBoard. */
	const captureRateCeiling = computed(() => rateCeilingForBoard(selectedBoard.value?.shortName ?? null));
	/** The rate a manual/wizard capture actually requests — must be used for BOTH the M569.5 command and
	 * the subsequent analysis call, or a clamped capture gets mis-timed against the unclamped setting.
	 * (Auto-tune's own trapezoid move is a separate case — see `captureRaw`'s use of `profile.sampleRateHz`,
	 * which is derived from the move itself, not this value, and already threaded through correctly.) */
	const effectiveSampleRate = computed(() => Math.min(sampleRate.value, captureRateCeiling.value));

	/** Live object-model machine status ("idle", "halted", "disconnected", …) — read fresh every time,
	 * same discipline as `selectedBoard`/`drivers` above. Drives `isCancelled()` below: an emergency
	 * stop or a lost connection must stop a running auto-tune before it sends another move, not just
	 * when the user clicks Abort. See `isMachineUnsafeForTuning`. */
	const machineStatus = computed<string | null>(() => {
		const s = (host.model() as any)?.state?.status;
		return typeof s === "string" ? s : null;
	});

	/** The axis object the selected driver belongs to (null for extruders / unknown). */
	function axisForDriver(): any {
		if (!selectedDriver.value) { return null; }
		return (host.model() as any).move?.axes?.find((a: any) => (a.drivers ?? []).some((d: any) => `${d.board}.${d.driver}` === selectedDriver.value)) ?? null;
	}
	/** Index of the selected driver's axis into move.axes[] — the column kinematics.ts needs to resolve
	 * which OTHER axes a G1 H2 move on this driver's own motor also displaces (see coupledAxesForDriver). */
	function axisIndexForDriver(): number | null {
		if (!selectedDriver.value) { return null; }
		const axes = (host.model() as any).move?.axes ?? [];
		const idx = axes.findIndex((a: any) => (a.drivers ?? []).some((d: any) => `${d.board}.${d.driver}` === selectedDriver.value));
		return idx >= 0 ? idx : null;
	}
	/** True once a driver with an axis is selected — reactive, so template usage doesn't call a plain function on every render. */
	const hasAxisSelected = computed(() => !!axisForDriver()?.letter);

	let loggedCouplingFor: string | null = null;
	/** Last capture profile actually logged (see captureRaw) — a plain string key, not the object itself,
	 *  so a fresh CaptureProfile with identical numbers each cycle doesn't re-log. Reset per run alongside
	 *  loggedCouplingFor. docs/PLAN-capture-window.md §6: this line is what would have shown "4167 Hz" for
	 *  the auto-derived rate immediately, instead of requiring hand-decoded CSV timestamps to find it. */
	let loggedProfileKey: string | null = null;
	/** Last literal capture command actually logged (see captureRaw) — the profile line above says what
	 *  was RESOLVED, this says what was actually SENT (including the M956 sharing its line, if armed).
	 *  Requested by a field report that needed CSV-timestamp archaeology to establish the rate; this
	 *  answers that in one line. The per-capture filename is normalised out of the key so this logs once
	 *  per run, not once per capture. docs/PLAN-capture-integrity.md §5. */
	let loggedCommandKey: string | null = null;
	/** Whether this run has already warned that the firmware's achieved rate diverged from what was
	 *  requested — once is enough; every capture repeating the same divergence would just be noise. */
	let warnedAchievedRate = false;

	/**
	 * Every axis a G1 H2 move on the selected driver actually displaces, with travel limits AND the
	 * kinematics-derived perUnit (see kinematics.ts) — `[]` for extruders (no axis to couple). Returns an
	 * error (never a silent Cartesian guess) when the kinematics can't be resolved, a coupled axis's limits
	 * aren't available, or a coupled axis isn't homed — an unhomed coupled axis means its position is
	 * unknown, so the move can't be proven safe even if the TUNED axis itself is homed.
	 */
	function coupledAxesForDriver(): Array<CoupledAxisLimits> | { error: string } {
		const axisObj = axisForDriver();
		if (!axisObj) { return []; }
		const index = axisIndexForDriver();
		if (index === null) { return { error: "Could not resolve the selected driver's axis index." }; }
		const axes = (host.model() as any).move?.axes ?? [];
		const kinematics = (host.model() as any).move?.kinematics;
		const coupling = resolveMotionCoupling(kinematics, axes, index);
		if ("error" in coupling) { return coupling; }
		const out: Array<CoupledAxisLimits> = [];
		for (const effect of coupling.effects) {
			const limits = getAxisLimits(axes[effect.index]);
			if (!limits) { return { error: `${effect.letter}: axis limits/position not available.` }; }
			if (!limits.homed) {
				return { error: `${effect.letter} is not homed — home it first. This axis is coupled to ${coupling.letter}'s motor `
					+ `(${coupling.kinematicsName} kinematics), so its position must be known before tuning ${coupling.letter}.` };
			}
			out.push({ ...limits, perUnit: effect.perUnit });
		}
		if (coupling.effects.length > 1 && loggedCouplingFor !== selectedDriver.value) {
			loggedCouplingFor = selectedDriver.value;
			const parts = coupling.effects.map((e) => `${e.letter} by ${e.perUnit >= 0 ? "+" : ""}${e.perUnit.toFixed(3)} mm`).join(" and ");
			log(`Kinematics: ${coupling.kinematicsName} — tuning ${coupling.letter} moves ${parts} per mm of motor travel.`);
		}
		return out;
	}

	/** Human-readable summary of the driver's axis travel/position, shown next to the safety margin setting. */
	const axisTravelInfo = computed(() => {
		const limits = getAxisLimits(axisForDriver());
		if (!limits) { return ""; }
		const homedNote = limits.homed ? "" : " — NOT HOMED, moves will be refused";
		return `${limits.letter}: travel ${limits.min}–${limits.max} mm, currently ${limits.position.toFixed(1)} mm, `
			+ `${marginMm.value} mm margin${homedNote}`;
	});

	// --- Mode ---
	async function setMode(mode: LoopMode): Promise<void> {
		if (!selectedDriver.value) { return; }
		await send(buildModeCommand(selectedDriver.value, mode, modeD));
		currentMode.value = mode;
	}

	// --- Calibration ---
	const requiredMoveIds = computed<Array<number>>(() => {
		switch (encoderType.value) {
			case 2: return [1];        // quadrature shaft: polarity/zero every power-on
			case 3: return [2];        // magnetic: calibration once
			case 1: return [2, 1];     // linear composite: magnetic cal then polarity/zero, once
			default: return [];
		}
	});
	const calibrationMoves = computed<Array<CalibrationMove>>(() =>
		CALIBRATION_MOVES.filter((c) => c.encoders.length === 0 || c.encoders.includes(encoderType.value)));
	const encoderGuidance = computed(() => {
		switch (encoderType.value) {
			case 2: return "Quadrature shaft encoder: run Polarity detection & zeroing (V1) after every power-on — put it in your homing file.";
			case 3: return "Duet3D magnetic encoder: run Magnetic encoder calibration (V2) once. It's stored in the board's flash and survives power cycles.";
			case 1: return "Linear composite encoder: run Magnetic encoder calibration (V2) then Polarity & zeroing (V1) once. Stored in flash.";
			default: return "No encoder selected. Set the encoder type in config.g with M569.1 T (T1/T2/T3) and pick it here.";
		}
	});
	function runCalibration(c: CalibrationMove): void {
		if (!selectedDriver.value) { return; }
		askConfirm(buildCalibrationCommand(selectedDriver.value, c.id), async () => { await send(buildCalibrationCommand(selectedDriver.value!, c.id)); });
	}

	/** Non-interactive calibration for auto-tune's preflight — already covered by the upfront consent dialog. */
	async function runCalibrationSilent(moveId: number): Promise<string> {
		if (!selectedDriver.value) { return "No driver selected."; }
		try {
			return await host.sendCode(buildCalibrationCommand(selectedDriver.value, moveId), { log: false });
		} catch (e) { console.warn("[ClosedLoopTuning] runCalibrationSilent failed", e); return `Error: ${e instanceof Error ? e.message : String(e)}`; }
	}

	// --- PID ---
	const pidPreview = computed(() => selectedDriver.value ? buildPidCommand(selectedDriver.value, pid) : "");
	async function loadPid(): Promise<void> {
		if (!selectedDriver.value) { return; }
		try {
			const reply = await host.sendCode(`M569.1 P${selectedDriver.value}`, { log: false });
			Object.assign(pid, parsePidReply(reply));
		} catch (e) { console.warn("[ClosedLoopTuning] loadPid failed", e); }
	}
	async function applyPid(): Promise<void> {
		if (!selectedDriver.value) { return; }
		applyingPid.value = true;
		try {
			// Wait for any in-flight move on this driver to physically finish before reconfiguring its
			// closed-loop parameters. M569.1 previously fired straight after a capture's return move
			// (which is sent {log:false} and not itself awaited to completion) with no synchronisation
			// at all — every auto-tune attempt, dozens of times a run. Quiet: this runs at the same
			// frequency as the capture-loop's own moves, and the M569.1 line right after already
			// reports the change. Best-effort — a transient failure here shouldn't block the write below.
			try { await host.sendCode("M400", { log: false }); } catch { /* still apply the PID */ }
			await send(buildPidCommand(selectedDriver.value, pid));
		} finally { applyingPid.value = false; }
	}

	// --- Recording ---
	const canRecord = computed(() => !!selectedDriver.value && recordKeys.value.length > 0);
	// Shows the M956 too when vibration recording is armed, so the preview is what actually gets sent.
	// A fixed placeholder filename keeps the preview stable rather than minting a new one every render.
	const capturePreview = computed(() => selectedDriver.value
		? buildCaptureCommand(captureOptions(armAccel(samples.value, effectiveSampleRate.value, "cl-<timestamp>.csv").alongside))
		: "");

	/** @param alongside an already-built M956 to share the line with — see armAccel. The preview passes a
	 *  representative one so what's shown is what gets sent, without minting a new filename per render. */
	function captureOptions(alongside?: string) {
		return {
			driver: selectedDriver.value ?? "",
			samples: samples.value,
			activate: (moveMode.value === "custom" ? 1 : 0) as 0 | 1,
			rate: effectiveSampleRate.value,
			variables: recordKeys.value.map((k) => CAPTURE_VARIABLES.find((v) => v.key === k)?.id ?? 0),
			manoeuvre: moveMode.value === "step" ? 64 : 0,
			move: moveMode.value === "custom" ? (customMove.value || undefined) : undefined,
			alongside,
		};
	}

	let runsAtStart = -1;
	/** Armed accelerometer capture for the manual Record button, collected by the runs watcher below —
	 *  the manual path is split across a command and a watcher, so this can't be a local. */
	let pendingRecordAccel: PendingAccel | null = null;
	async function record(): Promise<void> {
		if (!canRecord.value) { return; }
		if (moveMode.value === "custom" && !customMove.value) {
			host.notify("warning", "Closed Loop Tuning", "Enter a move before recording.");
			return;
		}
		// Centre first if needed — this doesn't bounds-check a custom move's distance (it's arbitrary
		// G-code), only makes sure every axis this driver's motor can move is starting from its own midpoint.
		const coupledForRecord = coupledAxesForDriver();
		if ("error" in coupledForRecord) { host.notify("error", "Closed Loop Tuning", coupledForRecord.error); return; }
		if (!(await ensureAxisReady(coupledForRecord))) { return; }
		runsAtStart = selectedBoard.value?.closedLoop?.runs ?? -1;
		recording.value = true;
		// Manual captures arm the accelerometer exactly like the tuning ones do — same line, same trigger.
		// Without this, ticking "Record vibration" and then pressing Record would silently do nothing.
		if (canRecordVibration.value && accelerometerBoard.value) { await ensureAccelRateKnown(accelerometerBoard.value); }
		const armed = armAccel(samples.value, effectiveSampleRate.value);
		pendingRecordAccel = armed.pending;
		try {
			const reply = await host.sendCode(buildCaptureCommand(captureOptions(armed.alongside)), { log: false });
			if (reply && /error:|warning:/i.test(reply)) {
				if (armed.alongside && armed.pending && isAccelOnlyError(reply)) {
					armed.pending.armFailed = true;
					accelRetryAfter = Date.now() + ACCEL_ARM_BACKOFF_MS;
					noteAccelSoftFailure(`The accelerometer rejected this capture's M956 (${reply.trim()}).`);
					// Fall through: the actual capture command (not M956) is what this reply would be
					// about if it had failed — see isAccelOnlyError — so keep waiting for it as normal.
				} else {
					host.notify("error", "Closed Loop Tuning", reply);
					recording.value = false;
					pendingRecordAccel = null;
				}
			}
		} catch (e) {
			console.warn("[ClosedLoopTuning] record failed", e);
			recording.value = false;
			pendingRecordAccel = null;
		}
	}

	watch(() => selectedBoard.value?.closedLoop?.runs, async (runs) => {
		if (!recording.value || runs == null || runs === runsAtStart) { return; }
		const c = await loadLatestCapture();
		const pending = pendingRecordAccel;
		pendingRecordAccel = null;
		// A manual record is a one-off, deliberate user action, not a background retry loop (unlike
		// captureRaw's own auto-tune path, which stopped doing this — see the comment there) — so it's
		// worth clearing here on failure: without it, a failed manual capture would leave the OLD trace
		// sitting next to whatever's now shown, looking like it belongs to this move.
		if (c) { await collectAccel(pending, c, effectiveSampleRate.value); }
		else { accelCapture.value = null; lastVibration.value = null; }
		recording.value = false;
	});

	/** Load the newest capture CSV into the chart; returns the parsed capture (no analysis). */
	async function loadLatestCsv(): Promise<ParsedCapture | null> {
		try {
			const list = await host.getFileList(CAPTURE_DIR);
			const files = list.filter((f: any) => !f.isDirectory && f.name.endsWith(".csv"))
				.sort((a: any, b: any) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
			if (files.length === 0) { return null; }
			const path = `${CAPTURE_DIR}/${files[0].name}`;
			const text = await host.download(path);
			rawText.value = text;
			capture.value = parseCapture(text);
			// Every call site reaches loadLatestCsv() strictly because the plugin's own M569.5 command
			// just ran and the board's closed-loop run counter confirmably incremented (see runCapture's
			// waitForRuns and record()'s watch on closedLoop.runs) — "the newest file" IS "the file this
			// capture just wrote", the same identification the rest of this function already relies on
			// for correctness. So there's nothing to track beyond the name already resolved above; this
			// can never delete a file the plugin didn't just create.
			await maybeDeleteCapture(host, path, deleteCapturesAfterRead.value);
			return capture.value;
		} catch (e) { console.warn("[ClosedLoopTuning] loadLatestCsv failed", e); return null; }
	}

	/** Manual record path: load newest CSV and analyse it as a step response. */
	async function loadLatestCapture(): Promise<ParsedCapture | null> {
		const c = await loadLatestCsv();
		if (c) { metrics.value = analyzeCapture(c, effectiveSampleRate.value); }
		return c;
	}

	const availableViewVars = computed(() => CAPTURE_VARIABLES.filter((v) => capture.value && capture.value.columns[v.header]));
	function pinOverlay(): void { overlayCapture.value = capture.value; }

	// --- Wizard ---
	const wizardStep = computed(() => steps[wizardIndex.value]);
	const pidSummary = computed(() => (["p", "d", "i", "v", "a"] as const).map((term) => ({ term, value: (pid as Record<string, number>)[term] })));
	const verdictType = computed(() => {
		switch (recommendation.value?.verdict) {
			case "accept": return "success";
			case "decrease": return "warning";
			default: return "info";
		}
	});
	watch(wizardIndex, () => { recommendation.value = null; });
	function seedDefault(): void {
		const t = wizardStep.value.term;
		if (t && wizardStep.value.defaultStart !== undefined) { (pid as any)[t] = wizardStep.value.defaultStart; void applyPid(); }
	}
	async function runWizardCapture(): Promise<void> {
		recording.value = true;
		try {
			// Opt-in: the same custom-G1 mechanism the "Advanced: manual capture" panel already offers
			// (moveMode/customMove), now also reachable from the wizard — see docs/PLAN-v2.4-feedback.md
			// item J. Only activates once the user has switched moveMode to "custom" there; default
			// behaviour (below) is untouched.
			if (moveMode.value === "custom") {
				if (!customMove.value) {
					host.notify("warning", "Closed Loop Tuning", "Enter a move before recording.");
					return;
				}
				const coupled = coupledAxesForDriver();
				if ("error" in coupled) { log(`Step capture: ${coupled.error}`); host.notify("error", "Closed Loop Tuning", coupled.error); return; }
				if (!(await ensureAxisReady(coupled))) { return; }
				const c = await runCapture({
					driver: selectedDriver.value ?? "", samples: samples.value, activate: 1,
					rate: effectiveSampleRate.value, variables: varIds(ALL_CAPTURE_KEYS), manoeuvre: 0, move: customMove.value,
				});
				if (c) { metrics.value = analyzeCapture(c, effectiveSampleRate.value); }
				return;
			}
			// Default: a small, fast, auto-sized G1 move (the V64 manoeuvre doesn't move on all setups).
			await captureStep();
		} finally { recording.value = false; }
	}
	watch(metrics, (m) => {
		const term = wizardStep.value.term;
		if (!term) { return; }
		recommendation.value = wizardStep.value.recommend(m, (pid as any)[term] ?? 0);
	});
	function applySuggestion(): void {
		const term = wizardStep.value.term;
		if (term && recommendation.value?.suggested !== undefined) {
			// The wizard's own D step already caps at D_MAX (autotune.ts); this is the user's own,
			// optionally-tighter manual ceiling on top — see AutoRunOptions.dCeiling.
			const suggested = term === "d" && dCeiling.value != null
				? Math.min(dCeiling.value, recommendation.value.suggested)
				: recommendation.value.suggested;
			(pid as any)[term] = suggested;
			void applyPid();
		}
	}

	// --- Auto-tune: run a step capture and resolve when its analysis is ready ---
	const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

	/** Wait for the board's closed-loop run counter to advance (capture finished), or time out. */
	async function waitForRuns(startRuns: number, timeoutMs: number): Promise<boolean> {
		const t0 = Date.now();
		while (Date.now() - t0 < timeoutMs) {
			if (autoCancel.value) { return false; }
			const r = selectedBoard.value?.closedLoop?.runs;
			if (r != null && r !== startRuns) { return true; }
			await delay(200);
		}
		return false;
	}

	/** Like waitForRuns, but for `boards[n].accelerometer.runs` on the accelerometer's OWN board — which
	 *  is frequently not the board being tuned (docs/PLAN-accelerometer.md §5.3). */
	async function waitForAccelRuns(boardAddress: number, startRuns: number, timeoutMs: number): Promise<boolean> {
		const t0 = Date.now();
		while (Date.now() - t0 < timeoutMs) {
			if (autoCancel.value) { return false; }
			const board = (host.model() as any)?.boards?.find((b: any) => b && b.canAddress === boardAddress);
			const r = board?.accelerometer?.runs;
			if (r != null && r !== startRuns) { return true; }
			await delay(200);
		}
		return false;
	}

	const varIds = (keys: Array<string>) => keys.map((k) => CAPTURE_VARIABLES.find((v) => v.key === k)?.id ?? 0);

	/** Every recordable variable — used for the auto-generated captures (wizard step, auto-tune's own
	 * decision captures, the step-5 test move) so as much diagnostic overlay data as possible is available
	 * on the shared chart afterward, without the user having to run a separate manual "Advanced capture"
	 * to get it. `viewKeys`/`recordKeys` defaults still start with only a few lines selected — this only
	 * controls what's AVAILABLE to tick on, not what's shown by default. If firmware can't buffer this many
	 * columns at the requested sample count, `runCapture` already surfaces that as a clear "Firmware
	 * rejected the capture" error rather than failing silently. */
	const ALL_CAPTURE_KEYS = CAPTURE_VARIABLES.filter((v) => !v.derived).map((v) => v.key);

	/** Seeds a sensible starting chart selection only when there isn't one yet (nothing ticked) — never
	 * overwrites a selection the user already made. Without this, every capture (including each of auto-
	 * tune's own internal decision captures) used to stomp the checkboxes back to a hardcoded default,
	 * resetting whatever the user had just ticked to look at. */
	function ensureViewKeys(defaults: Array<string>): void {
		if (viewKeys.value.length === 0) { viewKeys.value = defaults; }
	}

	/**
	 * Run a capture command (built directly, not from the user's manual settings), wait for it to finish,
	 * load the CSV. `accel`, when given, is the accelerometer armed on the SAME line via `opts.alongside` —
	 * passed through so an M956-only rejection (see isAccelOnlyError) can be handled as a vibration-only
	 * problem, marking `accel.armFailed` and backing off, rather than failing the whole tuning capture that
	 * the M569.5 part of this same line most likely still completed successfully.
	 */
	async function runCapture(opts: Parameters<typeof buildCaptureCommand>[0], accel?: PendingAccel | null): Promise<ParsedCapture | null> {
		const startRuns = selectedBoard.value?.closedLoop?.runs ?? -1;
		const reply = await host.sendCode(buildCaptureCommand(opts), { log: false });
		if (reply && /error:|warning:/i.test(reply)) {
			if (opts.alongside && accel && isAccelOnlyError(reply)) {
				accel.armFailed = true;
				accelRetryAfter = Date.now() + ACCEL_ARM_BACKOFF_MS;
				noteAccelSoftFailure(`The accelerometer rejected this capture's M956 (${reply.trim()}).`);
				// Fall through: M569.5 and the move are not what errored (see isAccelOnlyError), so this
				// capture almost certainly still ran — wait for it exactly as if nothing had gone wrong.
			} else {
				host.notify("error", "Closed Loop Tuning", reply);
				log(`Firmware rejected the capture: ${reply}`);
				return null;
			}
		}
		const captureMs = opts.rate > 0 ? (opts.samples / opts.rate) * 1000 : 4000;
		if (!(await waitForRuns(startRuns, captureMs + 8000))) { log("Timed out waiting for the capture to finish — is the driver calibrated and in closed loop?"); return null; }
		await delay(300); // let the CSV finish writing
		const c = await loadLatestCsv();
		// RRF appends a bare "Data lost" line when its capture buffer overruns — parseCapture already
		// strips it so the rows that DID arrive are still usable (see csv.ts); this just surfaces that
		// it happened, once, rather than silently keeping the user in the dark about why their captures
		// are a bit shorter than requested. Never fails the capture — MIN_CAPTURE_SAMPLES already does
		// that job downstream if too little survived.
		if (c?.truncated) { log(`Capture truncated by the firmware (${c.rowCount} samples kept) — the requested sample rate may be too high for this board.`); }
		return c;
	}

	const MIN_STEP_DISTANCE_FRACTION = 0.5; // require at least half the intended step-jump distance to bother capturing

	/**
	 * Gate before any axis-moving capture. Tuning moves use G1's H2 (individual motor) mode, which drives
	 * one axis's own motor directly and bypasses RRF's kinematics — so M208 soft limits never apply to
	 * them. On coupled kinematics (CoreXY etc.) that single motor can displace MORE than one Cartesian axis
	 * (see kinematics.ts) — `axes` must already be the full coupled set from `coupledAxesForDriver()`,
	 * every one of them homed (that function's own job), or this can't prove the move is safe.
	 *
	 * If any coupled axis isn't already near the middle of its own travel, warns the user and moves ALL of
	 * them there together via one normal (kinematics-respecting) multi-axis G1 move, so the tuning move has
	 * room on every side it can actually reach. No-op when `axes` is empty (extruder — no axis to couple).
	 *
	 * `centerToMid: false` skips the move-to-mid leg entirely — for a caller that's about to reposition to
	 * its own precisely-planned, already-safety-clamped start positions regardless (see `captureRaw`),
	 * routing through the midpoint first is just an extra physical round trip.
	 */
	async function ensureAxisReady(axes: Array<CoupledAxisLimits>, opts: { centerToMid?: boolean } = {}): Promise<boolean> {
		if (axes.length === 0) { return true; }
		if (opts.centerToMid === false) { return true; }
		const targets = axes.filter((a) => Math.abs(midpoint(a) - a.position) >= CENTER_TOLERANCE_MM);
		if (targets.length === 0) { return true; }
		const letters = targets.map((a) => a.letter).join(", ");
		const move = `G90 G1 ${targets.map((a) => `${a.letter}${midpoint(a).toFixed(3)}`).join(" ")} F${CENTERING_FEED_MM_MIN}`;
		if (autoRunning.value) {
			// Auto-tune's upfront consent dialog already covers centering moves — no per-move prompt mid-run.
			log(`Centering ${letters} to ${targets.length > 1 ? "their" : "its"} travel midpoint — consented to upfront.`);
		} else {
			const message = `Before tuning, ${letters} will move to the middle of ${targets.length > 1 ? "their" : "its"} travel `
				+ `so there's room to move safely in every direction this driver's motor affects. `
				+ `Make sure the axes are clear, then proceed.`;
			if (!(await confirmAsync(message, move))) { return false; }
		}
		await send(move);
		await send("M400"); // block until the centering move finishes
		await delay(400);    // let the object model catch up before we read the new position back
		return true;
	}

	/**
	 * Step-response capture (for P/D/I). Uses a small, fast G1 move (~16 full steps) which behaves like a
	 * step jump — the firmware V64 manoeuvre doesn't reliably move on all setups, whereas a real
	 * closed-loop G1 move does (it's also what the official plugin/wiki tune from). The outward move is
	 * captured, then the axis is returned to its start. Falls back to V64 for drivers with no axis (extruders).
	 * The direction and distance are chosen to stay within the configured margin of the axis's travel limits.
	 */
	async function captureStep(): Promise<StepMetrics | null> {
		const ax = axisForDriver();
		const coupled = coupledAxesForDriver();
		if ("error" in coupled) { log(`Step capture: ${coupled.error}`); host.notify("error", "Closed Loop Tuning", coupled.error); return null; }
		if (!(await ensureAxisReady(coupled))) { return null; }
		const freshCoupled = coupledAxesForDriver(); // re-read: ensureAxisReady may have moved the axes
		if ("error" in freshCoupled) { log(`Step capture: ${freshCoupled.error}`); host.notify("error", "Closed Loop Tuning", freshCoupled.error); return null; }
		const stepVars = varIds(ALL_CAPTURE_KEYS);
		let c: ParsedCapture | null;
		if (ax?.letter) {
			const desired = stepJumpDistanceMm({ stepsPerMm: Number(ax.stepsPerMm), microstepping: Number(ax.microstepping?.value) });
			let dist = desired;
			let sign: 1 | -1 = 1;
			if (freshCoupled.length > 0) {
				const plan = planCoupledSymmetricMove(freshCoupled, desired, marginMm.value, desired * MIN_STEP_DISTANCE_FRACTION);
				if ("error" in plan) { log(`Step capture: ${plan.error}`); host.notify("error", "Closed Loop Tuning", plan.error); return null; }
				dist = plan.distance; sign = plan.sign;
			}
			const signedDist = sign * dist;
			const feed = stepJumpFeedMmPerMin(dist).toFixed(0);
			const move = `G91 G1 H2 ${ax.letter}${signedDist.toFixed(3)} F${feed} G90`;
			c = await runCapture({ driver: selectedDriver.value ?? "", samples: samples.value, activate: 1, rate: effectiveSampleRate.value, variables: stepVars, manoeuvre: 0, move });
			try { await host.sendCode(`G91 G1 H2 ${ax.letter}${(-signedDist).toFixed(3)} F${feed} G90`, { log: false }); } catch { /* return move */ }
		} else {
			c = await runCapture({ driver: selectedDriver.value ?? "", samples: samples.value, activate: 0, rate: effectiveSampleRate.value, variables: stepVars, manoeuvre: 64 });
		}
		if (!c) { return null; }
		metrics.value = analyzeCapture(c, effectiveSampleRate.value);
		return metrics.value;
	}

	/**
	 * Single trapezoid-move capture for the unified P/D/I/A/V tuning signal. One G1 H2 move sized (via
	 * `planCaptureProfile`) so the capture window holds both a real accel/cruise/decel section AND a
	 * meaningful at-rest tail — the same capture serves every term's decision instead of a separate
	 * "step" move and "A/V" move judged by different (and, for step, wrong) metrics.
	 *
	 * The move is CENTRED on every coupled axis's own midpoint (not just started from it): `planCaptureProfile`
	 * derives each `startPositions` entry (mid − perUnit·d/2) from that axis's own min/max alone, so this
	 * pre-positions straight there in one hop (no intermediate stop at mid) before the H2 move — using the
	 * full clear travel on every axis the tuned motor actually displaces (see limits.ts / kinematics.ts),
	 * not just the nominal one. Distance defaults to "auto" (0 = longest reasonable motor-space move, up to
	 * `AUTO_MOVE_CAP_MM`), which also derives the sample rate from the move's own duration; the returned
	 * `rateHz` is what was actually used, for the caller to pass to analysis so it matches what the
	 * firmware was told to capture at.
	 */
	/** Floor for the wait below; a capture sized for a long move gets proportionally longer (see armAccel). */
	const ACCEL_WAIT_MS = 8000;

	/** Download + parse one accelerometer capture. Returns null on ANY problem — never throws into the
	 *  tuning path (docs/PLAN-accelerometer.md §5.4). */
	async function loadAccelCapture(filename: string): Promise<AccelCapture | null> {
		const path = `${ACCEL_CAPTURE_DIR}/${filename}`;
		try {
			const text = await host.download(path);
			const parsed = parseAccelCapture(text);
			// Delete before any early return: the file exists either way, and the failure cases are exactly
			// the ones that repeat on every capture of a long run and would otherwise pile up on the SD card.
			await maybeDeleteCapture(host, path, deleteCapturesAfterRead.value);
			if (parsed.failed) { log("Vibration: the accelerometer reported a failed start — no vibration data for this capture."); return null; }
			if (parsed.rateHz == null) { log("Vibration: no rate in the accelerometer file's trailer — skipping frequency analysis for this capture."); return null; }
			if (parsed.notes.length > 1) { log(`Vibration: ${parsed.notes.length - 1} unreadable row(s) in the accelerometer capture were dropped.`); }
			return parsed;
		} catch (e) {
			console.warn("[ClosedLoopTuning] loadAccelCapture failed", e);
			log("Vibration: couldn't read the accelerometer capture — continuing without it.");
			return null;
		}
	}

	/** One armed accelerometer capture, waiting to be collected — see armAccel/collectAccel. */
	interface PendingAccel {
		boardAddress: number;
		file: string;
		startRuns: number;
		waitMs: number;
		/** Set by the caller once it learns RRF rejected THIS pending's own M956 (see isAccelOnlyError) —
		 *  collectAccel then skips straight to "no data" instead of waiting on a file that was never
		 *  created and might otherwise be confused with a stale capture's file finishing later. */
		armFailed?: boolean;
	}

	/**
	 * Learns the accelerometer's real rate via one cheap, short, STANDALONE M956 — run once before the
	 * first real capture of a session, instead of guessing. This is what lets accelSampleCount size every
	 * REAL capture from a known rate rather than ACCEL_ASSUMED_RATE_HZ's guess, which is the direct fix for
	 * a guess that's wrong in either direction: too low truncates the capture (a `coverage` this plugin can
	 * only detect after the fact); too high makes the accelerometer collect for far longer than the tuning
	 * move needs, and a second capture arriving while the first is still running is exactly what produces
	 * the "M956: ... is already collecting data" failure this whole function exists to avoid. Best-effort:
	 * any problem just leaves `lastAccelRateHz` null and callers fall back to the guess, same as before this
	 * existed — never throws, never blocks vibration recording from working at all.
	 */
	async function ensureAccelRateKnown(board: AccelerometerInfo): Promise<void> {
		if (lastAccelRateHz.value != null) { return; }
		const PROBE_SAMPLES = 50; // just enough to reach the trailer; small so even a genuinely slow real rate returns quickly
		const file = `probe-${Date.now()}.csv`;
		const startRuns = board.runs;
		try {
			const reply = await host.sendCode(
				buildAccelCaptureCommand({
					device: `${board.boardAddress}.0`, useAccelNumberAddressing: useAccelNumberAddressing.value,
					samples: PROBE_SAMPLES, activate: 0, filename: file,
				}),
				{ log: false },
			);
			if (reply && /error:|warning:/i.test(reply)) {
				log(`Vibration: couldn't measure the accelerometer's rate (${reply.trim()}) — sizing the first capture from a default guess instead.`);
				accelRetryAfter = Date.now() + ACCEL_ARM_BACKOFF_MS;
				return;
			}
			// Unlike the real capture's wait, this has no closed-loop move to size against — it has to
			// tolerate a genuinely slow real rate (a handful of Hz), since not knowing that rate yet is
			// the whole reason this function exists.
			if (!(await waitForAccelRuns(board.boardAddress, startRuns, 15000))) {
				log("Vibration: the accelerometer's rate probe didn't finish in time — sizing the first capture from a default guess instead.");
				return;
			}
			const parsed = await loadAccelCapture(file);
			if (parsed?.rateHz != null) {
				lastAccelRateHz.value = parsed.rateHz;
				log(`Vibration: measured the accelerometer's real rate at ${parsed.rateHz} Hz.`);
			}
		} catch (e) {
			console.warn("[ClosedLoopTuning] ensureAccelRateKnown failed", e);
		}
	}

	/**
	 * Build the M956 to put on the same line as a closed-loop capture, when vibration recording is on and
	 * usable. Returns the command plus what collectAccel() needs to pick the result up afterwards.
	 * `alongside` is undefined whenever nothing should be armed, so every caller can pass it straight
	 * through without branching. Callers should `await ensureAccelRateKnown(board)` first — this stays
	 * synchronous so `capturePreview` (a computed) can call it without awaiting a probe round-trip.
	 */
	function armAccel(clSamples: number, clRateHz: number, file = `cl-${Date.now()}.csv`): { alongside?: string; pending: PendingAccel | null } {
		const board = canRecordVibration.value ? accelerometerBoard.value : null;
		if (!board) { return { alongside: undefined, pending: null }; }
		if (Date.now() < accelRetryAfter) { return { alongside: undefined, pending: null }; }
		// Once a real rate has been read back from a trailer, size against THAT; only ever falls back to
		// the deliberately-high assumption if ensureAccelRateKnown's probe couldn't complete.
		const rate = lastAccelRateHz.value ?? ACCEL_ASSUMED_RATE_HZ;
		const samples = accelSampleCount(clSamples, clRateHz, rate);
		return {
			alongside: buildAccelCaptureCommand({
				device: `${board.boardAddress}.0`, useAccelNumberAddressing: useAccelNumberAddressing.value,
				samples, activate: 0, filename: file,
			}),
			// The wait has to outlast the capture itself, which is longer than the move by ACCEL_WINDOW_MARGIN
			// and longer still if the real rate is below the assumed one. Doubling the expected duration
			// leaves room for the file write on top.
			pending: { boardAddress: board.boardAddress, file, startRuns: board.runs, waitMs: Math.max(ACCEL_WAIT_MS, (samples / rate) * 2000 + 4000) },
		};
	}

	/**
	 * Collect an armed accelerometer capture and turn it into vibration metrics against the closed-loop
	 * capture that ran alongside it. Never throws.
	 *
	 * Deliberately does NOT clear the chart on every call (it used to, unconditionally, before this ran
	 * anything async) — an auto-tune run makes dozens of these calls, most of them retries or intermediate
	 * decision captures, and `VibrationChart`'s row is `v-if="accelCapture"`, so nulling it out ahead of a
	 * handful of awaited steps destroyed and recreated the whole chart component on every single one: the
	 * "charts going blank and refilling" a real run visibly showed. The chart component itself is left
	 * showing the last SUCCESSFULLY collected vibration reading until a new one is ready to replace it —
	 * that's a real, if momentarily slightly stale, reading from this same run and axis, which is far less
	 * misleading than a flashing "no data" placeholder on every attempt. The one-time reset a fresh run
	 * genuinely needs (so a previous run/axis's trace doesn't linger) happens once, at `runAutoTune`'s
	 * start, not here.
	 */
	async function collectAccel(pending: PendingAccel | null, cl: ParsedCapture, clRateHz: number): Promise<Vibration | undefined> {
		if (!pending) { return undefined; }
		if (pending.armFailed) { return undefined; } // RRF already told us nothing was captured — see isAccelOnlyError.

		// The closed-loop file is already back by here, so the accelerometer's run counter has almost
		// certainly advanced too — but wait explicitly rather than assume, then read it.
		if (!(await waitForAccelRuns(pending.boardAddress, pending.startRuns, pending.waitMs))) {
			// Latch immediately rather than counting up: the capture may still hold the accelerometer, and
			// the next M956 shares its line with a closed-loop capture we must not put at risk.
			if (!autoCancel.value) { disableAccel("the accelerometer capture didn't finish in time."); }
			return undefined;
		}
		const parsed = await loadAccelCapture(pending.file);
		if (!parsed) { noteAccelSoftFailure("The accelerometer capture failed to produce usable data"); return undefined; }
		accelSoftFailures = 0;
		lastAccelRateHz.value = parsed.rateHz;

		const series = buildSeries(cl, clRateHz);
		const seg = series ? segmentMove(series.target, series.time, clRateHz) : null;
		if (!series || !seg) { return undefined; }
		const vibration = computeVibration(parsed, series.time, seg.classes);
		accelCapture.value = parsed;
		lastVibration.value = vibration;
		log(describeVibration(vibration, parsed));
		return vibration;
	}

	/** The one-line vibration summary for the run log. Reports only regions that actually hold samples —
	 *  an empty region's 0 g would otherwise read as "perfectly still" rather than "no data". */
	function describeVibration(v: Vibration, parsed: AccelCapture): string {
		const region = (name: string, r: typeof v.overall) => r.samples > 0 ? `${r.rmsG.toFixed(3)} g rms ${name}` : null;
		const parts = [region("overall", v.overall), region("cruising", v.cruise), region("at rest", v.rest)].filter((p) => p != null);
		let line = `Vibration: ${parts.join(", ")}`;
		const d = v.overall;
		if (d.dominantHz != null && d.dominantHzLow != null && d.dominantHzHigh != null) {
			// Never the bare figure: at these rates the frequency is quantised into buckets wide enough to
			// be mistaken for precision (vibration.ts MIN_LAG).
			line += `, dominant ${d.dominantHz.toFixed(0)} Hz (${d.dominantHzLow.toFixed(0)}-${d.dominantHzHigh.toFixed(0)} Hz)`;
		}
		if (parsed.overflows > 0) { line += `, ${parsed.overflows} dropped samples`; }
		if (v.coverage < VIBRATION_MIN_COVERAGE) {
			line += `. The accelerometer only covered ${(v.coverage * 100).toFixed(0)}% of the capture, so the end of the move is missing`;
		}
		return `${line}.`;
	}

	interface RawCaptureResult {
		capture: ParsedCapture;
		rateHz: number;
		/** Present only when vibration recording was on AND the accelerometer capture came back usable. */
		vibration?: Vibration;
	}

	/**
	 * The unified trapezoid-move capture, shared by `captureSignal` (tuning decisions → TuneSignal),
	 * `evaluateCapture` (final-verification grading → TuneEvaluation), and `checkEnvelope` (validation at
	 * the axis's own configured max, docs/PLAN-envelope-check.md) so all three analyse the exact same kind
	 * of move instead of duplicating the move-planning/execution logic.
	 *
	 * `feedOverrideMmPerMin` is for `checkEnvelope` only — when given, it replaces `avFeed.value`
	 * everywhere below AND the move is auto-sized (no `maxDistanceMm`) rather than reusing the user's own
	 * `avDistance` setting, which is a manual cap on the ORDINARY tuning move and has no bearing on what
	 * distance an envelope check at a different feed should use.
	 */
	async function captureRaw(feedOverrideMmPerMin?: number): Promise<RawCaptureResult | null> {
		const feed = feedOverrideMmPerMin ?? avFeed.value;
		const axisObj = axisForDriver();
		const axis = axisObj?.letter ?? null;
		if (!axis) { host.notify("warning", "Closed Loop Tuning", "Signal-based tuning needs the driver's axis — skipped."); return null; }
		const coupled = coupledAxesForDriver();
		if ("error" in coupled) { log(`Tuning capture: ${coupled.error}`); host.notify("error", "Closed Loop Tuning", coupled.error); return null; }
		// No move-to-mid here: planCaptureProfile below computes each start position from every coupled
		// axis's own min/max alone (never from current position), so centering to mid first would just be
		// an extra round trip before the explicit reposition a few lines down. Only the homed check applies.
		if (!(await ensureAxisReady(coupled, { centerToMid: false }))) { return null; }
		const freshCoupled = coupledAxesForDriver();
		if ("error" in freshCoupled) { log(`Tuning capture: ${freshCoupled.error}`); host.notify("error", "Closed Loop Tuning", freshCoupled.error); return null; }
		const profile = planCaptureProfile(freshCoupled, feed, samples.value, sampleRate.value, marginMm.value, {
			maxDistanceMm: feedOverrideMmPerMin == null ? avDistance.value : undefined,
			// Bandwidth-aware, not just the board's own rate ceiling: this capture records every available
			// variable (ALL_CAPTURE_KEYS), and bandwidth is rate × columns — a rate the board could sustain
			// with a handful of columns can still overrun its buffer with all 17 (docs/PLAN-capture-window.md
			// §5, 10 of 82 real captures truncated this way).
			rateCeilingHz: rateCeilingForCapture(selectedBoard.value?.shortName ?? null, ALL_CAPTURE_KEYS.length),
		});
		if ("error" in profile) { log(`Tuning capture: ${profile.error}`); host.notify("error", "Closed Loop Tuning", profile.error); return null; }

		// Logged once per distinct profile, not once per capture — dozens of otherwise-identical lines is
		// why the log is capped. This one line is the direct fix for a real forum report that needed a day
		// of hand-decoded CSV timestamps to discover the auto-derived rate was 4167 Hz, not the UI's 2000
		// (docs/PLAN-capture-window.md §6) — R IS honoured; auto mode just doesn't use the UI's rate box.
		// Feed is part of the key (not just samples/rate/distance) since checkEnvelope's override can
		// otherwise land on a profile shape identical to the ordinary tuning move's and get silently
		// suppressed, hiding the very feed difference this whole log line exists to make visible.
		const profileKey = `${profile.samples}@${profile.sampleRateHz.toFixed(1)}/${profile.distance.toFixed(3)}/F${feed}`;
		if (profileKey !== loggedProfileKey) {
			loggedProfileKey = profileKey;
			log(`Capture profile: ${profile.samples} samples @ ${profile.sampleRateHz.toFixed(0)} Hz `
				+ `(${(profile.samples / profile.sampleRateHz).toFixed(3)} s window, ${profile.moveTimeS.toFixed(3)} s move, `
				+ `${profile.restTimeS.toFixed(3)} s rest), ${profile.distance.toFixed(1)} mm at F${feed}`
				+ `${profile.limitedBy ? `, limited by ${profile.limitedBy}` : ""}.`);
		}

		// Centre the MOVE on every coupled axis's own midpoint, not just the nominal one: pre-position ALL
		// of them via one normal, soft-limit-respecting multi-axis G1 before the H2 tuning move — this is
		// what unlocks the full clear travel on every axis the tuned motor actually displaces, instead of
		// only the half reachable by moving one-way from the midpoint (or, on coupled kinematics, checking
		// only the nominal axis while another one the same motor moves goes completely unchecked).
		const needsReposition = profile.startPositions.some((sp) => {
			const current = freshCoupled.find((a) => a.letter === sp.letter);
			return !current || Math.abs(sp.position - current.position) > CENTER_TOLERANCE_MM;
		});
		if (needsReposition) {
			const letters = profile.startPositions.map((sp) => sp.letter).join(", ");
			const move = `G90 G1 ${profile.startPositions.map((sp) => `${sp.letter}${sp.position.toFixed(3)}`).join(" ")} F${CENTERING_FEED_MM_MIN}`;
			const limitNote = profile.limitedBy ? `, limited by ${profile.limitedBy}` : "";
			log(`Positioning ${letters} for a ${profile.distance.toFixed(0)} mm centred tuning move${limitNote}.`);
			await send(move);
			await send("M400");
			await delay(400);
		}

		const signedDist = profile.sign * profile.distance;
		ensureViewKeys(["measuredMotorSteps", "targetMotorSteps", "pidPTerm"]);

		// Arm the accelerometer on the SAME line as the closed-loop capture and the move. Confirmed
		// working on real hardware (docs/PLAN-accelerometer.md §12.1); both captures start together
		// closely enough to share a t=0 (§12.2), and running both showed no measurable effect on the
		// closed-loop data (§12.4).
		if (canRecordVibration.value && accelerometerBoard.value) { await ensureAccelRateKnown(accelerometerBoard.value); }
		const { alongside, pending } = armAccel(profile.samples, profile.sampleRateHz);

		// Built ONCE and reused for both the logged command and the actual sendCode call below — building
		// it twice risked the logged text drifting from what was really sent, which would be worse than
		// not logging it at all.
		const captureOpts: Parameters<typeof buildCaptureCommand>[0] = {
			// `profile.samples`, not `samples.value` — the rate ceiling can reduce the effective count
			// (see planCaptureProfile / CaptureProfile.samples); using the raw setting here would ask the
			// firmware for more samples than the (now lower) rate can actually spread across this window.
			driver: selectedDriver.value ?? "", samples: profile.samples, activate: 1, rate: profile.sampleRateHz,
			variables: varIds(ALL_CAPTURE_KEYS), manoeuvre: 0, alongside,
			move: `G91 G1 H2 ${axis}${signedDist.toFixed(3)} F${feed} G90`,
		};

		// Log the literal command once per distinct shape — the profile line above says what was
		// RESOLVED, this says what was actually SENT (M956 included, when armed). docs/PLAN-capture-
		// integrity.md §5. The per-capture filename is normalised out of the dedupe key so this logs once
		// per run, not once per capture.
		const commandText = buildCaptureCommand(captureOpts);
		const commandKey = commandText.replace(/F"[^"]*"/g, 'F"…"');
		if (commandKey !== loggedCommandKey) {
			loggedCommandKey = commandKey;
			log(`Capture command: ${commandKey}`);
		}

		const c = await runCapture(captureOpts, pending);
		try { await host.sendCode(`G91 G1 H2 ${axis}${(-signedDist).toFixed(3)} F${feed} G90`, { log: false }); } catch { /* ignore return-move error */ }

		// One-time sanity check per run: is the firmware actually sampling at what was requested? A
		// divergence here is not necessarily wrong (a board's own clock can quantise the rate slightly),
		// only worth a warning past 20% — see docs/PLAN-capture-window.md §6.
		if (c && !warnedAchievedRate) {
			const achieved = achievedRateHz(c);
			if (achieved != null && Math.abs(achieved - profile.sampleRateHz) / profile.sampleRateHz > 0.2) {
				warnedAchievedRate = true;
				log(`Note: this board sampled at ~${achieved.toFixed(0)} Hz, not the requested ${profile.sampleRateHz.toFixed(0)} Hz. `
					+ `This can be expected (e.g. the board quantises the rate) but affects how much rest time each capture actually gets.`);
			}
		}

		// Only collect when the closed-loop capture itself came back — with no `c` there's nothing to
		// correlate against, and waiting would just add this capture's timeout to an already-failed attempt.
		// Deliberately does NOT clear the vibration chart here: this runs on every failed/retried attempt
		// (the common case in a real run — field reports show 5-12 per run), and clearing on each one is
		// exactly the flicker collectAccel's own doc comment describes — nulling the chart ahead of the
		// NEXT successful capture's data, destroying and recreating VibrationChart every time. A failed
		// attempt produced no new data, so the last real reading stays exactly as valid as it was.
		if (!c) { return null; }
		const vibration = await collectAccel(pending, c, profile.sampleRateHz);
		return { capture: c, rateHz: profile.sampleRateHz, vibration };
	}

	async function captureSignal(): Promise<TuneSignal | null> {
		const result = await captureRaw();
		if (!result) { return null; }
		const signal = computeTuneSignal(result.capture, result.rateHz);
		// Post-hoc attachment, same pattern as pTermSatDuty/restEffort elsewhere in this codebase —
		// vibration is computed in captureRaw() (it needs the accelerometer capture, which computeTuneSignal
		// has no reason to know about) and only needs to ride along on the result for the report/UI to see.
		if (signal && result.vibration) { signal.vibration = result.vibration; }
		return signal;
	}

	/** Final-verification grading: a fresh capture judged the same way the Step-5 evaluation panel does.
	 *  Passes `result.vibration` (from the SAME capture, when vibration recording was on) so a real
	 *  post-move-vibration finding can appear — see docs/PLAN-accelerometer.md §17. Report-only: it can
	 *  never change the score or grade, only add an informational line. */
	async function evaluateCapture(): Promise<TuneEvaluation | null> {
		const result = await captureRaw();
		return result ? evaluateTune(result.capture, result.rateHz, result.vibration) : null;
	}

	/**
	 * Validation capture at the axis's own configured max (M203/M201), run once after a successful tune
	 * regardless of grade (docs/PLAN-envelope-check.md, decision A) — a tune that grades well on the
	 * moderate profile identification uses can still be the one that saturates hardest at speed. Null
	 * when there's nothing to check (extruder, unresolvable kinematics, or no coupled axis has both a
	 * non-negligible coupling AND a configured speed) or the check capture itself fails — both cases mean
	 * "no fact to report", not a run failure (see the try/catch around this call in autorun.ts).
	 */
	async function checkEnvelope(): Promise<EnvelopeCheck | null> {
		const axis = axisForDriver();
		if (!axis?.letter) { return null; } // extruder — no axis to check
		const index = axisIndexForDriver();
		if (index === null) { return null; }
		const axes = (host.model() as any).move?.axes ?? [];
		const kinematics = (host.model() as any).move?.kinematics;
		const coupling = resolveMotionCoupling(kinematics, axes, index);
		if ("error" in coupling) { log(`Envelope check: ${coupling.error}`); return null; }
		// `move.axes[].speed` is M203 in mm/min already (RRF Move.cpp: InverseConvertSpeedToMmPerMin) —
		// the same unit `captureRaw`'s feed override and a G1 F parameter take. No conversion.
		const speedInputs = coupling.effects.map((e) => ({
			letter: e.letter, perUnit: e.perUnit, speedMmPerMin: Number(axes[e.index]?.speed) || 0,
		}));
		const feedMmPerMin = envelopeFeedMmPerMin(speedInputs);
		if (feedMmPerMin == null) {
			log("Envelope check: no coupled axis has both a real coupling and a configured M203 — skipped.");
			return null;
		}
		const result = await captureRaw(feedMmPerMin);
		if (!result) { return null; }
		const move = analyzeMove(result.capture, result.rateHz);
		if (!move) { return null; }
		return evaluateEnvelope(feedMmPerMin, move.pTermSatDuty);
	}

	function log(line: string): void {
		sessionLog.push(line); // uncapped — this is what the downloadable report uses
		autoLog.value = [...autoLog.value, line]; // uncapped — display keeps the full run so it can be copied out
	}

	/**
	 * Read the driver's current PID back from the firmware (a fresh snapshot, independent of the `pid`
	 * reactive) — this is what auto-tune restores to if the run is cancelled or fails partway through.
	 */
	async function readPidSnapshot(): Promise<PidConfig | null> {
		if (!selectedDriver.value) { return null; }
		try {
			const reply = await host.sendCode(`M569.1 P${selectedDriver.value}`, { log: false });
			return parsePidReply(reply);
		} catch (e) { console.warn("[ClosedLoopTuning] readPidSnapshot failed", e); return null; }
	}

	/** Wire the orchestrator in src/model/autorun.ts to this component's G-code/UI side effects. */
	function buildTuneEffects(): TuneEffects {
		return {
			applyPid: async (p) => { Object.assign(pid, p); await applyPid(); },
			readPid: readPidSnapshot,
			captureSignal,
			captureStep,
			runCalibration: runCalibrationSilent,
			evaluateCapture,
			checkEnvelope,
			ensureReady: async () => {
				// The step/signal captures only move in closed/assisted loop, and the board can come up in
				// open loop after a reboot/reload. Uses the corrected mode command (D only — never S, which
				// is direction). This does NOT calibrate; that's the user's job (Step 3).
				const mode: LoopMode = currentMode.value === "assisted" ? "assisted" : "closed";
				log(`Ensuring ${MODE_LABELS[mode]} — ${buildModeCommand(selectedDriver.value ?? "", mode, modeD)}`);
				await send(buildModeCommand(selectedDriver.value ?? "", mode, modeD));
				currentMode.value = mode;
				await delay(600);
				return true; // per-capture axis centering/homing checks happen inside captureSignal/captureStep
			},
			log,
			status: (s) => { autoStatus.value = s; },
			onAttempt: (term, value, metric) => {
				wizardIndex.value = WIZARD_STEPS.findIndex((s) => s.term === term);
				recordSessionCapture(term, value, metric);
			},
			onStage: (stage, state) => {
				stageStates[stage] = state;
				if (tuneSession.value) { tuneSession.value.stageTimeline.push({ stage, state, at: new Date().toISOString() }); }
			},
			// Machine-safety stop, not just the user's own Abort button: an emergency stop or a lost
			// connection must never be followed by another positioning/capture move (see
			// isMachineUnsafeForTuning) — every capture/retry loop in autorun.ts/optimize.ts already
			// checks isCancelled() before each attempt, so this one change covers all of them.
			isCancelled: () => autoCancel.value || isMachineUnsafeForTuning(machineStatus.value),
			delay,
		};
	}

	const METHOD_CONSENT_TEXT: Record<TuneMethod, string> = {
		sequential: "tuning P → A → V → D → I from the same trapezoid move each time (starting with a brief search for a good starting point), then refining every term again each cycle",
		package: "tuning P → A → V → D → I once to get a good starting point, then jointly optimising every term together against a single whole-loop score",
		refine: "jointly optimising every term together, starting from the PID values already on the driver — no reset, no from-scratch ramp",
	};

	function startAutoTune(): void {
		if (!selectedDriver.value) { return; }
		const hasAxis = hasAxisSelected.value;
		const msg = hasAxis
			? "Auto-tune will run everything below without asking again — make sure the axis is clear and you've calibrated (Step 3) and homed it:\n"
				+ "• Switch to closed/assisted loop.\n"
				+ "• Check the driver is tracking a move; if not, run calibration automatically (this can include a full rotation of the motor) and check again.\n"
				+ "• Move the axis to the middle of its travel if it isn't already there.\n"
				+ `• Repeatedly move it back and forth, ${METHOD_CONSENT_TEXT[tuneMethod.value]}, keeping every move inside the configured safety margin.\n`
				+ "• Grade the result and, if needed, make one bounded correction pass.\n"
				+ "Review the evaluation afterwards, then save to config.g yourself."
			: "Auto-tune will switch to closed loop, then repeatedly move the driver with step jumps to tune P/D/I (A/V need an axis and will be skipped). Make sure you've calibrated (Step 3) first.";
		askConfirm(msg, runAutoTune);
	}

	async function runAutoTune(): Promise<void> {
		autoRunning.value = true;
		autoCancel.value = false;
		autoLog.value = [];
		sessionLog = [];
		sessionSeq = 0;
		// The coupling line is logged once per driver; this run just cleared the log it was written to, so
		// re-arm it or the 2nd+ run on a driver produces a report with no kinematics context at all.
		loggedCouplingFor = null;
		loggedProfileKey = null;
		loggedCommandKey = null;
		warnedAchievedRate = false;
		resetStageStates();
		// Once, here — not on every capture during the run (see the comments on collectAccel and
		// captureRaw's own `if (!c)` branch). A fresh run's FIRST vibration reading should still replace
		// whatever a PREVIOUS run/axis left showing, so this one reset stays; it just doesn't repeat.
		accelCapture.value = null;
		lastVibration.value = null;
		ensureViewKeys(["measuredMotorSteps", "targetMotorSteps", "currentError"]);
		const totalCycles = Math.max(1, Math.round(cycles.value || 1));
		const hasAxis = hasAxisSelected.value;
		const runOptions: AutoRunOptions = {
			cycles: totalCycles, hasAxis, calibrationMoveIds: requiredMoveIds.value,
			method: tuneMethod.value, identifyMethod: identifyMethod.value, modelFitBackoff: modelFitBackoff.value,
			seedRule: seedRule.value, seedLambda: seedLambda.value, medianOf: medianOf.value, captureBudget: captureBudget.value,
			dCeiling: dCeiling.value ?? undefined,
		};
		tuneSession.value = {
			startedAt: new Date().toISOString(), driver: selectedDriver.value, mode: currentMode.value,
			encoderType: encoderType.value, cycles: totalCycles, log: [], captures: [],
			method: hasAxis ? tuneMethod.value : "sequential", optionsUsed: runOptions,
			stageTimeline: [], reportVersion: REPORT_VERSION,
		};
		let result: AutoRunResult | undefined;
		try {
			result = await runAutoTuneCore(buildTuneEffects(), { ...pid }, runOptions);
			Object.assign(pid, result.pid);
			if (result.ok) {
				const gradeNote = result.evaluation
					? ` Final grade: ${result.evaluation.grade} (${result.evaluation.score}/100).`
					: " Final verification did not produce a valid capture — no final grade for these values.";
				autoStatus.value = `Auto-tune complete — P=${pid.p} D=${pid.d} I=${pid.i} A=${pid.a} V=${pid.v}.${gradeNote}`;
				host.notify("success", "Closed Loop Tuning", autoStatus.value + " Review the evaluation, then save to config.g.");
			} else {
				// Distinguish an automatic machine-safety stop from the user's own Abort click or an
				// ordinary capture failure — both report the identical "Cancelled." reason otherwise,
				// leaving the user to guess why a run they didn't touch just stopped.
				const safetyStop = !autoCancel.value && isMachineUnsafeForTuning(machineStatus.value);
				const reason = safetyStop ? `the machine is ${machineStatus.value} — stopped automatically` : (result.reason ?? "see log");
				autoStatus.value = result.restored
					? `Auto-tune stopped (${reason}) — PID restored to its values from before this run.`
					: `Auto-tune stopped: ${reason}.`;
				if (safetyStop) { host.notify("error", "Closed Loop Tuning", `Auto-tune stopped automatically — the machine is ${machineStatus.value}. No further moves were sent.`); }
			}
		} catch (e) {
			console.warn("[ClosedLoopTuning] auto-tune failed", e);
			autoStatus.value = "Auto-tune stopped (see console).";
		} finally {
			autoRunning.value = false;
			if (tuneSession.value) {
				tuneSession.value.finishedAt = new Date().toISOString();
				tuneSession.value.finalPid = { ...pid };
				tuneSession.value.log = [...sessionLog];
				// No fallback: when final verification couldn't produce a grade (e.g. the firmware rejected the
				// capture outright), showing the PREVIOUS capture's evaluation presents a score for a PID that
				// was never verified — measured on a real report, an I=875 refine capture's numbers were shown
				// against a completely different finalPid. "No final score" is the honest answer.
				// docs/PLAN-capture-integrity.md §2.
				tuneSession.value.evaluation = result?.evaluation ?? null;
				tuneSession.value.ku = result?.ku;
				tuneSession.value.tu = result?.tu;
				tuneSession.value.envelopeCheck = result?.envelopeCheck;
				tuneSession.value.preflightActions = result?.preflightActions;
				tuneSession.value.restored = result?.restored;
			}
		}
	}

	function abortAutoTune(): void { autoCancel.value = true; autoStatus.value = "Stopping after this capture…"; }

	// --- Test & save ---
	async function runTestMove(): Promise<void> {
		moveMode.value = "custom";
		recordKeys.value = ALL_CAPTURE_KEYS;
		ensureViewKeys(["measuredMotorSteps", "targetMotorSteps", "currentError"]);
		await record();
	}
	const configBlock = computed(() => {
		const id = selectedDriver.value ?? "#.#";
		const lines = [
			`; --- Closed-loop tuning for driver ${id} ---`,
			`; Put this in config.g AFTER your M569 / M906 / microstepping setup:`,
			buildPidCommand(id, pid),
			"",
			`; Put this in the homing file, after homing in open loop and moving to a safe spot:`,
			`${buildModeCommand(id, currentMode.value === "assisted" ? "assisted" : "closed", modeD)}     ; ${currentMode.value === "assisted" ? "assisted open loop" : "closed loop"}`,
		];
		for (const mid of requiredMoveIds.value) {
			const move = CALIBRATION_MOVES.find((c) => c.id === mid);
			lines.push(`${buildCalibrationCommand(id, mid)}        ; ${move?.name ?? "calibration"}`);
		}
		return lines.join("\n");
	});
	async function copyConfig(): Promise<void> {
		try {
			await navigator.clipboard.writeText(configBlock.value);
			host.notify("success", "Closed Loop Tuning", "config.g block copied to clipboard.");
		} catch {
			host.notify("warning", "Closed Loop Tuning", "Couldn't access the clipboard — select and copy the block manually.");
		}
	}

	// --- Automated config.g write (opt-in, explicit confirm) ---
	const configWriteConfirmOpen = ref(false);
	const savingConfig = ref(false);
	function openSaveToConfigG(): void { if (selectedDriver.value) { configWriteConfirmOpen.value = true; } }
	async function confirmSaveToConfigG(): Promise<void> {
		savingConfig.value = true;
		try { await saveToConfigG(); } finally { savingConfig.value = false; configWriteConfirmOpen.value = false; }
	}
	async function saveToConfigG(): Promise<void> {
		if (!selectedDriver.value) { return; }
		try {
			const currentText = await host.download(CONFIG_FILE);
			const result = upsertTuneBlock(currentText, {
				driver: selectedDriver.value,
				pid,
				mode: currentMode.value === "assisted" ? "assisted" : "closed",
				modeD,
				calibrationMoveIds: requiredMoveIds.value,
			});
			if (!result.changed) {
				host.notify("info", "Closed Loop Tuning", "config.g already has these values — nothing to write.");
				return;
			}
			// Belt-and-suspenders backup of our own, on top of whatever DWC does automatically for config.g uploads.
			const backupName = `${CONFIG_FILE}.clt-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
			await host.upload(backupName, currentText);
			await host.upload(CONFIG_FILE, result.text, { showSuccess: true, showError: true });
			host.notify("success", "Closed Loop Tuning", `config.g ${result.replaced ? "updated" : "written"} (backup: ${backupName.split("/").pop()}). Restart the board to apply it.`);
		} catch (e) {
			console.warn("[ClosedLoopTuning] saveToConfigG failed", e);
			host.notify("error", "Closed Loop Tuning", `Couldn't write config.g: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// --- Shared confirm + send ---
	function askConfirm(command: string, action: () => Promise<void>, message = DEFAULT_CONFIRM_MESSAGE): void {
		confirmCommand.value = command;
		confirmMessage.value = message;
		confirmAction = action;
		confirmResolve = null;
		confirmOpen.value = true;
	}
	/** Promise-based confirm for gating a step inside an async flow (e.g. centering before a move). */
	function confirmAsync(message: string, command: string): Promise<boolean> {
		return new Promise((resolve) => {
			confirmCommand.value = command;
			confirmMessage.value = message;
			confirmAction = null;
			confirmResolve = resolve;
			confirmOpen.value = true;
		});
	}
	async function confirmProceed(): Promise<void> {
		confirmOpen.value = false;
		const action = confirmAction;
		const resolve = confirmResolve;
		confirmAction = null;
		confirmResolve = null;
		if (action) { await action(); }
		if (resolve) { resolve(true); }
	}
	function confirmCancel(): void {
		confirmOpen.value = false;
		const resolve = confirmResolve;
		confirmAction = null;
		confirmResolve = null;
		if (resolve) { resolve(false); }
	}
	async function send(code: string): Promise<void> {
		try {
			const reply = await host.sendCode(code);
			if (reply && reply.startsWith("Error:")) {
				host.notify("error", "Closed Loop Tuning", reply);
			}
		} catch (e) { console.warn("[ClosedLoopTuning] send failed", code, e); }
	}

	watch(selectedDriver, (d) => { if (d) { void loadPid(); } });

	// Everything the templates bind to. Both pages destructure this; anything omitted silently becomes
	// `undefined` in a template (Vue does not error), and on 3.6 no type-checker would catch it — so the
	// set below is derived from the union of identifiers both templates actually reference.
	return {
		// The host itself — the About dialog binds `:model="host.model()"` for its version/firmware table.
		host,

		// Static tables & helpers the templates render directly.
		DOCS, MODE_LABELS, TUNE_METHODS, IDENTIFY_METHODS, SEED_RULES, STAGE_ORDER,
		steps, stepTitles, captureVariables, encoderTypes, modeList, modeHelp,
		buildModeCommand, buildCalibrationCommand,
		gradeColor, severityColor, severityIcon, gradeIcon, stageColor, stageIcon,

		// Wizard position & driver selection.
		step, selectedDriver, drivers, currentMode, hasAxisSelected, wizardIndex, wizardStep,

		// Mode / encoder / calibration.
		modeD, setMode, encoderType, encoderGuidance, calibrationMoves, requiredMoveIds, runCalibration,

		// PID values and the manual tuner.
		pid, pidPreview, pidSummary, applyingPid, applyPid, loadPid,
		recommendation, verdictType, applySuggestion, seedDefault, runWizardCapture, manualPanels,

		// Auto-tune.
		autoRunning, autoStatus, autoLog, startAutoTune, abortAutoTune,
		tuneMethod, estimatedMoves, identifyMethod, modelFitBackoff, seedRule, seedLambda,
		medianOf, captureBudget, cycles, avDistance, avFeed, marginMm, axisTravelInfo,
		stageStates, tuneSession, includeAllCsv, downloadTuningReport, dCeiling, D_MAX,
		recordVibration, accelerometers, selectedAccelerometerAddress, accelCapture, accelDisabledReason, lastVibration,

		// Manual capture & the shared chart.
		samples, sampleRate, moveMode, customMove, recordKeys, canRecord, capturePreview, record,
		recording, capture, overlayCapture, rawText, viewKeys, availableViewVars, pinOverlay,
		metrics, evaluation, goToManualTerm, deleteCapturesAfterRead,

		// Test & save.
		runTestMove, configBlock, copyConfig, openSaveToConfigG,
		configWriteConfirmOpen, savingConfig, confirmSaveToConfigG,

		// Movement-confirmation dialog.
		confirmOpen, confirmCommand, confirmMessage, confirmProceed, confirmCancel,

		// Self-update (re-exported from ../updateCheck so pages need only this one import).
		updateState, updateBanner, checking, applying, pendingReload, autoCheck,
		applyUpdateNow, dismissCurrentUpdate, reloadPage, onCheckUpdate, onToggleAutoCheck,

		// About dialog.
		aboutOpen, aboutDescription, aboutExtraActions,
	};
}
