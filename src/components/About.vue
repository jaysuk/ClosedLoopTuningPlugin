<template>
	<v-dialog :model-value="modelValue" max-width="560" @update:model-value="$emit('update:modelValue', $event)">
		<v-card>
			<v-card-title class="d-flex align-center">
				<v-icon class="mr-2">mdi-information-outline</v-icon>
				About Closed Loop Tuning
				<v-spacer />
				<v-btn icon="mdi-close" variant="text" size="small" @click="$emit('update:modelValue', false)" />
			</v-card-title>
			<v-card-text>
				<div class="text-body-2 mb-1">
					Tunes Duet 3 closed-loop drivers (1HCL / M23CL): loop mode, encoder calibration, automatic
					PID + feed-forward tuning with capture analysis.
				</div>
				<v-table density="compact" class="mb-3">
					<tbody>
						<tr><td>Version</td><td>{{ version }}</td></tr>
						<tr><td>DWC</td><td>{{ dwcVersion }}</td></tr>
						<tr><td>Firmware</td><td>{{ firmware }}</td></tr>
					</tbody>
				</v-table>

				<!-- Updates -->
				<div class="text-subtitle-2 d-flex align-center mb-1">
					Updates
					<HelpTip class="ml-1" text="Checks this plugin's GitHub releases once a day. When a newer build exists you can install it here with one click." />
				</div>
				<v-alert v-if="update?.updateAvailable" type="info" variant="tonal" density="compact" class="mb-2">
					Version {{ update.latestVersion }} is available.
					<template #append>
						<v-btn v-if="!pendingReload" size="small" variant="text" :loading="applying" @click="applyUpdateNow">Update</v-btn>
						<v-btn v-else size="small" variant="text" @click="reload">Reload</v-btn>
					</template>
				</v-alert>
				<v-alert v-else type="success" variant="tonal" density="compact" class="mb-2">You're on the latest version.</v-alert>
				<div class="d-flex align-center flex-wrap ga-2 mb-3">
					<v-btn size="small" variant="tonal" :loading="checking" prepend-icon="mdi-refresh" @click="checkNow">Check now</v-btn>
					<v-switch v-model="autoCheck" label="Check automatically" density="compact" hide-details color="primary" @update:model-value="onToggleAuto" />
				</div>

				<!-- Diagnostics -->
				<div class="text-subtitle-2 d-flex align-center mb-1">
					Diagnostics &amp; support
					<HelpTip class="ml-1" text="Download a report to attach to a bug report. It bundles plugin/firmware versions, recent errors and (for the tuning report) the full auto-tune log + every capture, with your machine's host details scrubbed out." />
				</div>
				<div class="d-flex flex-column ga-2 mb-3">
					<v-btn size="small" variant="tonal" prepend-icon="mdi-bug-outline" @click="downloadDiagnostics">Download diagnostic report</v-btn>
					<v-btn size="small" color="primary" variant="tonal" prepend-icon="mdi-download" :disabled="!hasSession" @click="$emit('download-tuning')">
						Download tuning report{{ hasSession ? "" : " (run auto-tune first)" }}
					</v-btn>
				</div>

				<div class="text-subtitle-2 mb-1">Links</div>
				<div class="d-flex flex-column ga-1">
					<a class="cl-link" :href="DOCS.tuning" target="_blank" rel="noopener">Duet 1HCL tuning guide</a>
					<a class="cl-link" href="https://github.com/jaysuk/ClosedLoopTuningPlugin" target="_blank" rel="noopener">Plugin on GitHub (report an issue)</a>
				</div>
			</v-card-text>
		</v-card>
	</v-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

import { useMachineStore } from "@/stores/machine";

import { HelpTip, buildReport, downloadReport } from "dwc-plugin-runtime";

import { DOCS, PLUGIN_MANIFEST_ID, PLUGIN_ID } from "../model/constants";
import {
	applying, applyUpdateNow, checking, pendingReload, runUpdateCheck, updateState,
	updateChecksEnabled, setUpdateChecksEnabled,
} from "../model/updateCheck";

/* eslint-disable @typescript-eslint/no-explicit-any */
defineProps<{ modelValue: boolean; hasSession: boolean }>();
defineEmits<{ (e: "update:modelValue", v: boolean): void; (e: "download-tuning"): void }>();

const machineStore = useMachineStore();
const update = updateState;
const autoCheck = ref(updateChecksEnabled());

const installed = computed(() => {
	const plugins = (machineStore.model as any)?.plugins as Map<string, any> | undefined;
	return plugins?.get?.(PLUGIN_MANIFEST_ID) ?? null;
});
const version = computed(() => installed.value?.version ?? "unknown");
const dwcVersion = computed(() => installed.value?.dwcVersion ?? "—");
const firmware = computed(() => {
	const b = (machineStore.model as any)?.boards?.[0];
	return b ? `${b.firmwareName ?? "?"} ${b.firmwareVersion ?? ""}`.trim() : "—";
});

function reload(): void { window.location.reload(); }
function checkNow(): void { void runUpdateCheck({ force: true, notify: true }); }
function onToggleAuto(v: boolean | null): void { setUpdateChecksEnabled(!!v); }

function downloadDiagnostics(): void {
	const report = buildReport({ pluginId: PLUGIN_ID, pluginVersion: version.value, model: machineStore.model, note: "Closed Loop Tuning diagnostic report" });
	downloadReport(report);
}
</script>

<style scoped>
.cl-link { font-size: 0.85rem; }
</style>
