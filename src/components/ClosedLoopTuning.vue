<template>
	<v-container fluid class="pa-2">
		<v-alert v-if="updateBanner" type="info" variant="tonal" density="compact" class="mb-3">
			{{ updateBanner }}
			<template #append>
				<v-btn v-if="!pendingReload" size="small" variant="text" :loading="applying" @click="applyUpdateNow">{{ $t("plugins.closedLoopTuning.updates.apply") }}</v-btn>
				<v-btn v-if="pendingReload" size="small" variant="text" @click="reloadPage">{{ $t("plugins.closedLoopTuning.updates.reload") }}</v-btn>
				<v-btn size="small" variant="text" @click="dismissCurrentUpdate">{{ $t("plugins.closedLoopTuning.updates.dismiss") }}</v-btn>
			</template>
		</v-alert>

		<v-alert v-if="drivers.length === 0" type="warning" variant="tonal" density="compact" class="mb-3">
			No closed-loop drivers found. Connect a Duet 3 board with a 1HCL / M23CL configured for an axis or extruder.
		</v-alert>

		<v-row dense>
			<!-- Driver + mode + calibration -->
			<v-col cols="12" md="6" lg="4">
				<v-card class="mb-2">
					<v-card-title class="py-2 text-subtitle-1">Driver &amp; mode</v-card-title>
					<v-card-text>
						<v-select v-model="selectedDriver" :items="drivers" item-title="name" item-value="value"
								  density="compact" variant="outlined" hide-details label="Closed-loop driver" class="mb-3" />
						<div class="d-flex ga-2 mb-2">
							<v-btn v-for="m in modeList" :key="m.value" size="small" variant="tonal"
								   :disabled="!selectedDriver" @click="setMode(m.value)">{{ m.label }}</v-btn>
						</div>
						<div v-if="selectedDriver" class="text-caption text-medium-emphasis">Sends: <code>{{ modePreview }}</code></div>
						<v-expansion-panels class="mt-2" variant="accordion">
							<v-expansion-panel title="Advanced: mode D-values">
								<v-expansion-panel-text>
									<div class="text-caption mb-2">Confirm these against <code>M569</code> on your firmware if a mode misbehaves.</div>
									<v-row dense>
										<v-col cols="4"><v-text-field v-model.number="modeD.open" type="number" label="Open (D)" density="compact" variant="outlined" hide-details /></v-col>
										<v-col cols="4"><v-text-field v-model.number="modeD.closed" type="number" label="Closed (D)" density="compact" variant="outlined" hide-details /></v-col>
										<v-col cols="4"><v-text-field v-model.number="modeD.assisted" type="number" label="Assisted (D)" density="compact" variant="outlined" hide-details /></v-col>
									</v-row>
								</v-expansion-panel-text>
							</v-expansion-panel>
						</v-expansion-panels>
					</v-card-text>
				</v-card>

				<v-card>
					<v-card-title class="py-2 text-subtitle-1">Calibration</v-card-title>
					<v-card-text>
						<v-select v-model="encoderType" :items="encoderTypes" item-title="title" item-value="value"
								  density="compact" variant="outlined" hide-details label="Encoder type" class="mb-2" />
						<div class="text-caption text-medium-emphasis mb-2">Driver must be in closed/assisted mode first. These moves rotate the motor.</div>
						<v-list density="compact" class="py-0">
							<v-list-item v-for="c in calibrationMoves" :key="c.id" :title="c.name" :subtitle="c.description">
								<template #append>
									<v-btn size="small" variant="tonal" :disabled="!selectedDriver" @click="runCalibration(c)">Run</v-btn>
								</template>
							</v-list-item>
						</v-list>
					</v-card-text>
				</v-card>
			</v-col>

			<!-- PID + wizard -->
			<v-col cols="12" md="6" lg="4">
				<v-card class="mb-2">
					<v-card-title class="py-2 text-subtitle-1 d-flex align-center">
						PID parameters <v-spacer />
						<v-btn size="x-small" variant="text" :disabled="!selectedDriver" @click="loadPid">Reload</v-btn>
					</v-card-title>
					<v-card-text>
						<v-row dense>
							<v-col cols="4"><v-text-field v-model.number="pid.p" type="number" label="P (R)" density="compact" variant="outlined" hide-details /></v-col>
							<v-col cols="4"><v-text-field v-model.number="pid.i" type="number" label="I" density="compact" variant="outlined" hide-details /></v-col>
							<v-col cols="4"><v-text-field v-model.number="pid.d" type="number" label="D" density="compact" variant="outlined" hide-details /></v-col>
							<v-col cols="6"><v-text-field v-model.number="pid.v" type="number" label="V (vel ff)" density="compact" variant="outlined" hide-details /></v-col>
							<v-col cols="6"><v-text-field v-model.number="pid.a" type="number" label="A (accel ff)" density="compact" variant="outlined" hide-details /></v-col>
						</v-row>
						<v-btn class="mt-2" size="small" color="primary" :disabled="!selectedDriver" :loading="applyingPid" @click="applyPid">Apply (M569.1)</v-btn>
						<div class="text-caption text-medium-emphasis mt-1">{{ pidPreview }}</div>
					</v-card-text>
				</v-card>

				<v-card>
					<v-card-title class="py-2 text-subtitle-1">Guided tuning</v-card-title>
					<v-card-text>
						<div class="d-flex align-center mb-2">
							<v-btn size="small" variant="text" icon="mdi-chevron-left" :disabled="wizardIndex === 0" @click="wizardIndex--" />
							<div class="flex-grow-1 text-center text-subtitle-2">{{ wizardStep.title }} ({{ wizardIndex + 1 }}/{{ steps.length }})</div>
							<v-btn size="small" variant="text" icon="mdi-chevron-right" :disabled="wizardIndex === steps.length - 1" @click="wizardIndex++" />
						</div>
						<div class="text-caption mb-1"><strong>Goal:</strong> {{ wizardStep.goal }}</div>
						<div class="text-caption text-medium-emphasis mb-2">{{ wizardStep.instructions }}</div>
						<v-btn size="small" color="info" :disabled="!selectedDriver || recording" :loading="recording" @click="runWizardCapture">Run step &amp; analyse</v-btn>
						<v-alert v-if="recommendation" :type="verdictType" variant="tonal" density="compact" class="mt-2">
							{{ recommendation.message }}
							<template v-if="recommendation.suggested !== undefined" #append>
								<v-btn size="x-small" variant="text" @click="applySuggestion">Set {{ wizardStep.term?.toUpperCase() }}={{ recommendation.suggested }}</v-btn>
							</template>
						</v-alert>
					</v-card-text>
				</v-card>
			</v-col>

			<!-- Recorder + analysis -->
			<v-col cols="12" lg="4">
				<v-card class="mb-2">
					<v-card-title class="py-2 text-subtitle-1">Record</v-card-title>
					<v-card-text>
						<v-row dense>
							<v-col cols="6"><v-text-field v-model.number="samples" type="number" label="Samples" density="compact" variant="outlined" hide-details /></v-col>
							<v-col cols="6"><v-text-field v-model.number="sampleRate" type="number" label="Rate (/s, 0=max)" density="compact" variant="outlined" hide-details /></v-col>
						</v-row>
						<v-radio-group v-model="moveMode" density="compact" hide-details class="mt-1">
							<v-radio label="Step manoeuvre (4 full steps)" value="step" />
							<v-radio label="Custom move (recorded while it runs)" value="custom" />
						</v-radio-group>
						<v-text-field v-if="moveMode === 'custom'" v-model="customMove" label="Move G-code" density="compact" variant="outlined" hide-details class="mb-2"
									  placeholder="G91 G1 H2 X50 F6000 G90" />
						<div class="text-caption mb-1">Record variables:</div>
						<div class="d-flex flex-wrap">
							<v-checkbox v-for="v in captureVariables" :key="v.key" v-model="recordKeys" :value="v.key" :label="v.header" density="compact" hide-details class="cl-var" />
						</div>
						<v-btn class="mt-2" size="small" color="info" :disabled="!canRecord || recording" :loading="recording" @click="record()">
							<v-icon class="mr-1">mdi-record</v-icon> Record
						</v-btn>
						<div v-if="selectedDriver" class="text-caption text-medium-emphasis mt-1"><code>{{ capturePreview }}</code></div>
						<v-progress-linear v-if="recording" indeterminate class="mt-2" />
					</v-card-text>
				</v-card>

				<v-card>
					<v-card-title class="py-2 text-subtitle-1">Analysis</v-card-title>
					<v-card-text>
						<div v-if="!metrics" class="text-medium-emphasis text-caption">Record a step to see rise time, overshoot and steady-state error.</div>
						<v-table v-else density="compact">
							<tbody>
								<tr><td>Step size</td><td>{{ metrics.stepSize.toFixed(2) }} steps</td></tr>
								<tr><td>Rise time</td><td>{{ metrics.riseTime === null ? "—" : (metrics.riseTime * 1000).toFixed(0) + " ms" }}</td></tr>
								<tr><td>Overshoot</td><td>{{ metrics.overshootPct.toFixed(0) }} %</td></tr>
								<tr><td>Settling time</td><td>{{ metrics.settlingTime === null ? "—" : (metrics.settlingTime * 1000).toFixed(0) + " ms" }}</td></tr>
								<tr><td>Steady-state error</td><td>{{ metrics.steadyStateError.toFixed(3) }} steps</td></tr>
								<tr><td>Peak / RMS error</td><td>{{ metrics.peakError.toFixed(3) }} / {{ metrics.rmsError.toFixed(3) }} steps</td></tr>
							</tbody>
						</v-table>
					</v-card-text>
				</v-card>
			</v-col>
		</v-row>

		<v-row dense class="mt-1">
			<v-col cols="12" md="9">
				<CaptureChart :capture="capture" :overlay="overlayCapture" :selected-keys="viewKeys" :sample-rate="sampleRate" :raw-text="rawText" />
			</v-col>
			<v-col cols="12" md="3">
				<v-card class="fill-height">
					<v-card-title class="py-2 text-subtitle-1 d-flex align-center">
						Plot <v-spacer />
						<v-btn size="x-small" variant="text" :disabled="!capture || !!overlayCapture" @click="pinOverlay">Overlay</v-btn>
						<v-btn v-if="overlayCapture" size="x-small" variant="text" @click="overlayCapture = null">Clear</v-btn>
					</v-card-title>
					<v-card-text>
						<div class="d-flex flex-wrap">
							<v-checkbox v-for="v in availableViewVars" :key="v.key" v-model="viewKeys" :value="v.key" :label="v.header" density="compact" hide-details class="cl-var" />
						</div>
					</v-card-text>
				</v-card>
			</v-col>
		</v-row>

		<v-dialog v-model="confirmOpen" max-width="460">
			<v-card>
				<v-card-title>Confirm movement</v-card-title>
				<v-card-text>
					This will move the selected driver and may not respect endstops. Make sure the axis is in a safe position (usually the centre) with room to move.
					<div class="text-caption text-medium-emphasis mt-2"><code>{{ confirmCommand }}</code></div>
				</v-card-text>
				<v-card-actions>
					<v-spacer />
					<v-btn variant="text" @click="confirmOpen = false">Cancel</v-btn>
					<v-btn color="primary" @click="confirmProceed">Proceed</v-btn>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</v-container>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";

import { useMachineStore } from "@/stores/machine";
import { LogLevel, useUiStore } from "@/stores/ui";

import CaptureChart from "./CaptureChart.vue";
import { CAPTURE_DIR } from "../model/constants";
import {
	buildCalibrationCommand, buildCaptureCommand, buildModeCommand, buildPidCommand,
	CALIBRATION_MOVES, CAPTURE_VARIABLES, DEFAULT_MODE_D, ENCODER_TYPES, MODE_LABELS,
	parsePidReply, type CalibrationMove, type EncoderType, type LoopMode, type PidConfig,
} from "../model/m569";
import { parseCapture, type ParsedCapture } from "../model/csv";
import { analyzeCapture, type StepMetrics } from "../model/analysis";
import { WIZARD_STEPS, type Recommendation } from "../model/wizard";
import { applying, applyUpdateNow, dismissCurrentUpdate, pendingReload, updateState } from "../model/updateCheck";

/* eslint-disable @typescript-eslint/no-explicit-any */

const machineStore = useMachineStore();
const uiStore = useUiStore();

const captureVariables = CAPTURE_VARIABLES;
const encoderTypes = ENCODER_TYPES;
const steps = WIZARD_STEPS;
const modeList = (Object.keys(MODE_LABELS) as Array<LoopMode>).map((value) => ({ value, label: MODE_LABELS[value] }));

const selectedDriver = ref<string | null>(null);
const encoderType = ref<EncoderType>(2);
const modeD = reactive({ ...DEFAULT_MODE_D });
const pid = reactive<PidConfig>({ p: 100, i: 0, d: 0, v: 0, a: 0, warn: null, err: null });
const applyingPid = ref(false);

const samples = ref(2000);
const sampleRate = ref(2000);
const moveMode = ref<"step" | "custom">("step");
const customMove = ref("");
const recordKeys = ref<Array<string>>(["measuredMotorSteps", "targetMotorSteps", "currentError", "pidPTerm"]);
const recording = ref(false);

const capture = ref<ParsedCapture | null>(null);
const overlayCapture = ref<ParsedCapture | null>(null);
const rawText = ref<string>("");
const metrics = ref<StepMetrics | null>(null);
const viewKeys = ref<Array<string>>(["measuredMotorSteps", "targetMotorSteps", "currentError"]);

const wizardIndex = ref(0);
const recommendation = ref<Recommendation | null>(null);

const confirmOpen = ref(false);
const confirmCommand = ref("");
let confirmAction: (() => Promise<void>) | null = null;

// --- Update banner ---
const updateBanner = computed(() => {
	const s = updateState.value;
	return s?.updateAvailable ? `Closed Loop Tuning v${s.latestVersion} is available.` : "";
});
function reloadPage(): void { window.location.reload(); }

// --- Drivers from the object model ---
interface DriverEntry { name: string; value: string }
const drivers = computed<Array<DriverEntry>>(() => {
	const model = machineStore.model as any;
	const boards = model.boards ?? [];
	const hasCl = (boardAddr: string) => boards.some((b: any) => b && b.canAddress === parseInt(boardAddr) && b.closedLoop != null);
	const out: Array<DriverEntry> = [];
	for (const axis of model.move?.axes ?? []) {
		for (const drv of axis.drivers ?? []) {
			const id = `${drv.board}.${drv.driver}`;
			if (hasCl(String(drv.board))) { out.push({ name: `${axis.letter} axis (driver ${id})`, value: id }); }
		}
	}
	(model.move?.extruders ?? []).forEach((ex: any, idx: number) => {
		const drv = ex?.driver;
		if (!drv) { return; }
		const id = `${drv.board}.${drv.driver}`;
		if (hasCl(String(drv.board))) { out.push({ name: `Extruder ${idx} (driver ${id})`, value: id }); }
	});
	return out;
});

const selectedBoard = computed<any>(() => {
	if (!selectedDriver.value) { return null; }
	const addr = parseInt(selectedDriver.value.split(".")[0]);
	return (machineStore.model as any).boards?.find((b: any) => b && b.canAddress === addr) ?? null;
});

// --- Mode ---
const modePreview = computed(() => selectedDriver.value ? `${buildModeCommand(selectedDriver.value, "open", modeD)}  /  ${buildModeCommand(selectedDriver.value, "closed", modeD)}` : "");
async function setMode(mode: LoopMode): Promise<void> {
	if (!selectedDriver.value) { return; }
	await send(buildModeCommand(selectedDriver.value, mode, modeD));
}

// --- Calibration ---
const calibrationMoves = computed<Array<CalibrationMove>>(() =>
	CALIBRATION_MOVES.filter((c) => c.encoders.length === 0 || c.encoders.includes(encoderType.value)));
function runCalibration(c: CalibrationMove): void {
	if (!selectedDriver.value) { return; }
	askConfirm(buildCalibrationCommand(selectedDriver.value, c.id), async () => { await send(buildCalibrationCommand(selectedDriver.value!, c.id)); });
}

// --- PID ---
const pidPreview = computed(() => selectedDriver.value ? buildPidCommand(selectedDriver.value, pid) : "");
async function loadPid(): Promise<void> {
	if (!selectedDriver.value) { return; }
	try {
		const reply = await machineStore.sendCode(`M569.1 P${selectedDriver.value}`, false, false);
		const parsed = parsePidReply(reply);
		Object.assign(pid, parsed);
	} catch (e) { console.warn("[ClosedLoopTuning] loadPid failed", e); }
}
async function applyPid(): Promise<void> {
	if (!selectedDriver.value) { return; }
	applyingPid.value = true;
	try { await send(buildPidCommand(selectedDriver.value, pid)); }
	finally { applyingPid.value = false; }
}

// --- Recording ---
const canRecord = computed(() => !!selectedDriver.value && recordKeys.value.length > 0);
const capturePreview = computed(() => selectedDriver.value ? buildCaptureCommand(captureOptions()) : "");

function stepMoveGcode(): string | undefined {
	return moveMode.value === "custom" ? (customMove.value || undefined) : undefined;
}
function captureOptions() {
	return {
		driver: selectedDriver.value ?? "",
		samples: samples.value,
		activate: (moveMode.value === "custom" ? 1 : 0) as 0 | 1,
		rate: sampleRate.value,
		variables: recordKeys.value.map((k) => CAPTURE_VARIABLES.find((v) => v.key === k)?.id ?? 0),
		manoeuvre: moveMode.value === "step" ? 64 : 0,
		move: stepMoveGcode(),
	};
}

let runsAtStart = -1;
async function record(): Promise<void> {
	if (!canRecord.value) { return; }
	if (moveMode.value === "custom" && !customMove.value) {
		uiStore.makeNotification(LogLevel.warning, "Closed Loop Tuning", "Enter a custom move before recording.");
		return;
	}
	runsAtStart = selectedBoard.value?.closedLoop?.runs ?? -1;
	recording.value = true;
	try {
		const reply = await machineStore.sendCode(buildCaptureCommand(captureOptions()), false, false);
		if (reply && reply.startsWith("Error:")) {
			uiStore.makeNotification(LogLevel.error, "Closed Loop Tuning", reply);
			recording.value = false;
		}
	} catch (e) {
		console.warn("[ClosedLoopTuning] record failed", e);
		recording.value = false;
	}
}

// Detect capture completion via the object model's run counter, then load the newest CSV.
watch(() => selectedBoard.value?.closedLoop?.runs, async (runs) => {
	if (!recording.value || runs == null || runs === runsAtStart) { return; }
	await loadLatestCapture();
	recording.value = false;
});

async function loadLatestCapture(): Promise<void> {
	try {
		const list = await machineStore.getFileList(CAPTURE_DIR);
		const files = list.filter((f: any) => !f.isDirectory && f.name.endsWith(".csv"))
			.sort((a: any, b: any) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
		if (files.length === 0) { return; }
		const text = await (machineStore as any).download({ filename: `${CAPTURE_DIR}/${files[0].name}`, type: "text" }, false, false, false) as string;
		rawText.value = text;
		capture.value = parseCapture(text);
		metrics.value = analyzeCapture(capture.value, sampleRate.value);
	} catch (e) { console.warn("[ClosedLoopTuning] loadLatestCapture failed", e); }
}

const availableViewVars = computed(() => CAPTURE_VARIABLES.filter((v) => capture.value && capture.value.columns[v.header]));
function pinOverlay(): void { overlayCapture.value = capture.value; }

// --- Wizard ---
const wizardStep = computed(() => steps[wizardIndex.value]);
const verdictType = computed(() => {
	switch (recommendation.value?.verdict) {
		case "accept": return "success";
		case "decrease": return "warning";
		case "increase": return "info";
		default: return "info";
	}
});
watch(wizardIndex, () => { recommendation.value = null; });

async function runWizardCapture(): Promise<void> {
	// Force a step-manoeuvre capture recording the keys this step needs.
	moveMode.value = "step";
	recordKeys.value = Array.from(new Set([...wizardStep.value.recordKeys]));
	await record();
}
// After a wizard capture finishes, analysis runs; recompute the recommendation.
watch(metrics, (m) => {
	const term = wizardStep.value.term;
	if (!term) { return; }
	recommendation.value = wizardStep.value.recommend(m, (pid as any)[term] ?? 0);
});
function applySuggestion(): void {
	const term = wizardStep.value.term;
	if (term && recommendation.value?.suggested !== undefined) {
		(pid as any)[term] = recommendation.value.suggested;
		void applyPid();
	}
}

// --- Shared confirm + send ---
function askConfirm(command: string, action: () => Promise<void>): void {
	confirmCommand.value = command;
	confirmAction = action;
	confirmOpen.value = true;
}
async function confirmProceed(): Promise<void> {
	confirmOpen.value = false;
	const action = confirmAction;
	confirmAction = null;
	if (action) { await action(); }
}
async function send(code: string): Promise<void> {
	try {
		const reply = await machineStore.sendCode(code, false, true);
		if (reply && reply.startsWith("Error:")) {
			uiStore.makeNotification(LogLevel.error, "Closed Loop Tuning", reply);
		}
	} catch (e) { console.warn("[ClosedLoopTuning] send failed", code, e); }
}

watch(selectedDriver, (d) => { if (d) { void loadPid(); } });
</script>

<style scoped>
.cl-var {
	flex: 0 0 50%;
}
:deep(.cl-var .v-label) {
	font-size: 0.8rem;
}
</style>
