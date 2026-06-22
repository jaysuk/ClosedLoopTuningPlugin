<template>
	<v-card class="fill-height">
		<v-card-title class="d-flex align-center py-2">
			<v-icon class="mr-2">mdi-chart-line</v-icon>
			Data chart
			<v-spacer />
			<v-btn size="small" variant="text" prepend-icon="mdi-download" :disabled="!capture" @click="exportCsv">Export CSV</v-btn>
		</v-card-title>
		<v-card-text>
			<div v-if="!capture" class="text-medium-emphasis text-center py-12">Record or select a capture to plot it here.</div>
			<div v-show="capture" class="chart-wrap"><canvas ref="canvas"></canvas></div>
		</v-card-text>
	</v-card>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Chart, registerables } from "chart.js";

import { CAPTURE_VARIABLES } from "../model/m569";
import { column, timeAxisSeconds, type ParsedCapture } from "../model/csv";

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
	return axis === "steps" || axis === "count" ? "yLeft" : "yRight";
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

function rebuild(): void {
	if (!chart || !props.capture) { return; }
	const time = timeAxisSeconds(props.capture, props.sampleRate);
	let datasets = datasetsFor(props.capture, time, false);
	if (props.overlay) {
		const otime = timeAxisSeconds(props.overlay, props.sampleRate);
		datasets = datasets.concat(datasetsFor(props.overlay, otime, true));
	}
	chart.data.datasets = datasets;
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
