<!--
  DWC 3.6 (Vue 2.7 / Vuetify 2) copy of ../ui37/CaptureChart.vue. The drawing logic is identical —
  Chart.js and the canvas API are framework-agnostic, and Vue 2.7 backported the Composition API, so
  only the template's Vuetify prop/slot names differ (prepend-icon -> a <v-icon left> slot). Keep the
  two in step when changing chart behaviour.
-->
<template>
	<v-card class="fill-height">
		<v-card-title class="d-flex align-center py-2">
			<v-icon class="mr-2">mdi-chart-line</v-icon>
			Data chart
			<v-spacer />
			<v-btn text small :disabled="!capture" @click="exportCsv"><v-icon left small>mdi-download</v-icon>Export CSV</v-btn>
		</v-card-title>
		<v-card-text>
			<div v-if="!capture" class="text--secondary text-center py-12">Record or select a capture to plot it here.</div>
			<div v-show="capture" class="chart-wrap"><canvas ref="canvas"></canvas></div>
		</v-card-text>
	</v-card>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Chart, registerables } from "chart.js";

import { P_TERM_RAIL } from "../model/analysis";
import { CAPTURE_VARIABLES } from "../model/m569";
import { column, timeAxisSeconds, type ParsedCapture } from "../model/csv";

/** The PID term/control-signal capture variables share a known real scale (± the effort rail) — unlike
 * the other "unitless" variables (coil current, motor current fraction), whose true range isn't known
 * here. Anchoring the right axis to this range when only these are plotted stops Chart.js's per-axis
 * auto-fit from zooming tight around a calm signal's own small noise band and making it look alarming —
 * a P-term genuinely near zero should visually read as "near zero out of ±250", not fill the chart. */
const PID_TERM_KEYS = new Set(["pidControlSignal", "pidPTerm", "pidITerm", "pidDTerm", "pidVTerm", "pidATerm"]);
const PID_TERM_AXIS_PAD = 1.1;

Chart.register(...registerables);

const props = defineProps<{
	capture: ParsedCapture | null;
	overlay?: ParsedCapture | null;
	selectedKeys: Array<string>;
	sampleRate: number;
	rawText?: string;
}>();

const canvas = ref<HTMLCanvasElement | null>(null);
let chart: Chart | null = null;

const PALETTE = ["#e60049", "#0bb4ff", "#50e991", "#e6d800", "#9b19f5", "#ffa300", "#dc0ab4", "#b3d4ff", "#00bfa0", "#fd7f6f", "#7eb0d5", "#b2e061", "#bd7ebe", "#8bd3c7", "#ebdc78", "#beb9db"];

function axisIdFor(axis: string): string {
	if (axis === "steps" || axis === "count") { return "yLeft"; }
	if (axis === "error") { return "yError"; }
	return "yRight";
}

function datasetsFor(capture: ParsedCapture, time: Array<number>, dashed: boolean) {
	const sets = [];
	for (const key of props.selectedKeys) {
		const v = CAPTURE_VARIABLES.find((cv) => cv.key === key);
		if (!v) { continue; }
		const col = column(capture, v.header);
		if (!col) { continue; }
		const scaled = v.scaleToDegrees ? col.map((x) => (x / 4095) * 360) : col;
		const colour = PALETTE[CAPTURE_VARIABLES.indexOf(v) % PALETTE.length];
		sets.push({
			label: dashed ? `${v.header} (prev)` : v.header,
			data: time.map((t, i) => ({ x: t, y: scaled[i] })),
			borderColor: colour,
			backgroundColor: colour,
			borderDash: dashed ? [4, 4] : [],
			yAxisID: axisIdFor(v.axis),
			pointRadius: 0,
			borderWidth: 1.5,
			tension: 0,
		});
	}
	return sets;
}

/** True when every variable currently sharing the yRight axis is a PID term/control-signal variable —
 * the only ones with a known real scale to anchor the axis to. */
function rightAxisIsPidTerms(): boolean {
	const rightAxisVars = props.selectedKeys
		.map((k) => CAPTURE_VARIABLES.find((cv) => cv.key === k))
		.filter((v): v is NonNullable<typeof v> => !!v && axisIdFor(v.axis) === "yRight");
	return rightAxisVars.length > 0 && rightAxisVars.every((v) => PID_TERM_KEYS.has(v.key));
}

function rebuild(): void {
	if (!chart || !props.capture) { return; }
	const time = timeAxisSeconds(props.capture, props.sampleRate);
	let datasets = datasetsFor(props.capture, time, false);
	if (props.overlay) {
		const otime = timeAxisSeconds(props.overlay, props.sampleRate);
		datasets = datasets.concat(datasetsFor(props.overlay, otime, true));
	}
	chart.data.datasets = datasets;
	const yRight = chart.options.scales!.yRight!;
	if (rightAxisIsPidTerms()) {
		yRight.suggestedMin = -P_TERM_RAIL * PID_TERM_AXIS_PAD;
		yRight.suggestedMax = P_TERM_RAIL * PID_TERM_AXIS_PAD;
	} else {
		delete yRight.suggestedMin;
		delete yRight.suggestedMax;
	}
	chart.update("none");
}

function exportCsv(): void {
	const text = props.rawText;
	if (!text) { return; }
	const blob = new Blob([text], { type: "text/csv" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = `closed-loop-capture-${Date.now()}.csv`;
	a.click();
	URL.revokeObjectURL(url);
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
				yLeft: { type: "linear", position: "left", title: { display: true, text: "Steps / counts" } },
				yRight: { type: "linear", position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "Unitless / degrees" } },
				// Its own axis, not sharing yLeft with the raw trapezoid position — see the CaptureVariable
				// "error" axis comment in m569.ts for why sharing distorts both signals.
				yError: { type: "linear", position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "Error (steps)" } },
			},
			plugins: { legend: { position: "bottom" } },
		},
	});
	rebuild();
});

watch(() => [props.capture, props.overlay, props.selectedKeys], rebuild, { deep: true });

onBeforeUnmount(() => { chart?.destroy(); chart = null; });
</script>

<style scoped>
.chart-wrap {
	position: relative;
	height: calc(100vh - 540px);
	min-height: 320px;
}
</style>
