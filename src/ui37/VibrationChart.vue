<template>
	<v-card class="fill-height">
		<v-card-title class="d-flex align-center py-2">
			<v-icon class="mr-2">mdi-vibrate</v-icon>
			Vibration
			<v-spacer />
			<span v-if="capture" class="text-caption text-medium-emphasis">{{ capture.rateHz }} Hz{{ capture.overflows > 0 ? `, ${capture.overflows} dropped samples` : "" }}</span>
		</v-card-title>
		<v-card-text>
			<div v-if="!capture" class="text-medium-emphasis text-center py-8">Record with vibration enabled to plot the accelerometer trace here.</div>
			<div v-if="summary" class="text-caption text-medium-emphasis mb-2">{{ summary }}</div>
			<v-alert v-if="shortCoverage" type="warning" density="compact" variant="tonal" class="mb-2 text-caption">
				The accelerometer only covered {{ coveragePercent }} of the capture, so the end of the move is missing. Any region shown as
				&ldquo;no data&rdquo; was not measured — it is not a reading of zero.
			</v-alert>
			<div v-show="capture" class="vib-chart-wrap"><canvas ref="canvas"></canvas></div>
		</v-card-text>
	</v-card>
</template>

<script setup lang="ts">
/**
 * Own time base, own chart — the accelerometer capture has no relationship to CaptureChart's
 * ParsedCapture/Timestamp shape (see docs/PLAN-accelerometer.md §8's non-goal against bolting this onto
 * CaptureChart's dataset builder), so this is a small, separate Chart.js instance rather than an
 * extension of the existing one.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Chart, registerables } from "chart.js";

import type { AccelCapture } from "../model/accelCsv";
import { VIBRATION_MIN_COVERAGE, type RegionVibration, type Vibration } from "../model/vibration";

Chart.register(...registerables);

const props = defineProps<{ capture: AccelCapture | null; vibration?: Vibration | null }>();

const shortCoverage = computed(() => !!props.vibration?.valid && props.vibration.coverage < VIBRATION_MIN_COVERAGE);
const coveragePercent = computed(() => `${((props.vibration?.coverage ?? 0) * 100).toFixed(0)}%`);

/**
 * The measured numbers in words. Two things this must not do, both of them ways of implying precision
 * the data doesn't have (docs/PLAN-accelerometer.md §7.1, and the `coverage`/`samples` contracts in
 * vibration.ts): report a region with no samples as 0 g, and report a dominant frequency without the
 * bucket it stands for.
 */
const summary = computed<string | null>(() => {
	const v = props.vibration;
	if (!v || !v.valid) { return null; }
	const region = (name: string, r: RegionVibration) => r.samples > 0 ? `${r.rmsG.toFixed(3)} g rms ${name}` : `no data ${name}`;
	let text = [region("overall", v.overall), region("cruising", v.cruise), region("at rest", v.rest)].join(", ");
	const d = v.overall;
	if (d.dominantHz != null && d.dominantHzLow != null && d.dominantHzHigh != null) {
		text += `. Dominant frequency around ${d.dominantHz.toFixed(0)} Hz (anywhere in ${d.dominantHzLow.toFixed(0)}-${d.dominantHzHigh.toFixed(0)} Hz at this sample rate)`;
	}
	return `${text}.`;
});

const canvas = ref<HTMLCanvasElement | null>(null);
let chart: Chart | null = null;

const AXIS_COLOURS: Record<"X" | "Y" | "Z", string> = { X: "#e60049", Y: "#0bb4ff", Z: "#50e991" };

function datasetsFor(capture: AccelCapture) {
	const rate = capture.rateHz ?? 0;
	const sets = [];
	for (const axis of ["X", "Y", "Z"] as const) {
		const series = capture.axes[axis];
		if (!series) { continue; }
		sets.push({
			label: axis,
			data: series.map((v, i) => ({ x: rate > 0 ? i / rate : i, y: v })),
			borderColor: AXIS_COLOURS[axis],
			backgroundColor: AXIS_COLOURS[axis],
			pointRadius: 0,
			borderWidth: 1,
			tension: 0,
		});
	}
	return sets;
}

function rebuild(): void {
	if (!chart || !props.capture) { return; }
	chart.data.datasets = datasetsFor(props.capture);
	chart.update("none");
}

onMounted(() => {
	// Skip when there's no 2D context (e.g. the headless test DOM) so mounting never throws.
	if (!canvas.value || !canvas.value.getContext("2d")) { return; }
	chart = new Chart(canvas.value, {
		type: "line",
		data: { datasets: [] },
		options: {
			animation: false,
			responsive: true,
			maintainAspectRatio: false,
			parsing: false,
			scales: {
				x: { type: "linear", title: { display: true, text: "Time (s)" } },
				y: { type: "linear", title: { display: true, text: "g" } },
			},
			plugins: { legend: { position: "bottom" } },
		},
	});
	rebuild();
});

watch(() => props.capture, rebuild);

onBeforeUnmount(() => { chart?.destroy(); chart = null; });
</script>

<style scoped>
.vib-chart-wrap {
	position: relative;
	height: 260px;
}
</style>
