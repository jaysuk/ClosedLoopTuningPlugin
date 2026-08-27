/**
 * Session-report shaping for the downloadable auto-tune JSON. Pure and unit-tested — the UI supplies
 * the raw captures/model fields, this decides what actually gets serialised.
 *
 * The full session used to embed the raw CSV for every capture (30-60+ captures × ~50-100 KB each) plus
 * the entire sanitised object model — several MB before anyone even opens it, and the one thing that
 * WAS truncated (the log) was the display log capped to 40 lines, not the report's own copy. This module
 * fixes both: `downsampleCapture` replaces most captures' raw CSV with a small peak-preserving error
 * series, `shapeCapturesForDownload` decides which captures keep their full CSV, and `slimModelForReport`
 * embeds only the board/axis/kinematics fields analysis actually uses instead of the whole model.
 */
import { buildSeries, REST_EFFORT_RIPPLE_LIMIT } from "./analysis";
import type { ParsedCapture } from "./csv";

export interface DownsampledSeries {
	time: Array<number>;
	measured: Array<number>;
	target: Array<number>;
}

const DEFAULT_MAX_POINTS = 200;

/**
 * Peak-preserving decimation of a capture's measured/target series to at most `maxPoints` samples: each
 * output point is the sample with the largest |error| in its bucket, so overshoot/ringing spikes survive
 * downsampling instead of being averaged away. Returns the series unchanged if it's already short enough.
 */
export function downsampleCapture(capture: ParsedCapture, sampleRateHz: number, maxPoints = DEFAULT_MAX_POINTS): DownsampledSeries | null {
	const series = buildSeries(capture, sampleRateHz);
	if (!series) { return null; }
	const { time, measured, target } = series;
	const n = time.length;
	if (n <= maxPoints) { return { time, measured, target }; }

	const bucketSize = Math.ceil(n / maxPoints);
	const outTime: Array<number> = [];
	const outMeasured: Array<number> = [];
	const outTarget: Array<number> = [];
	for (let start = 0; start < n; start += bucketSize) {
		const end = Math.min(n, start + bucketSize);
		let bestIdx = start;
		let bestAbsErr = -1;
		for (let i = start; i < end; i++) {
			const err = Math.abs(measured[i] - target[i]);
			if (err > bestAbsErr) { bestAbsErr = err; bestIdx = i; }
		}
		outTime.push(time[bestIdx]); outMeasured.push(measured[bestIdx]); outTarget.push(target[bestIdx]);
	}
	return { time: outTime, measured: outMeasured, target: outTarget };
}

export interface ReportCapture {
	seq: number;
	phase: string;
	value?: number;
	metrics?: unknown;
	series?: DownsampledSeries;
	csv?: string;
	/** Saturating/unstable (pTermSatDuty) OR standstill-dithering (restEffort) capture — always kept
	 *  in full. Set by the caller via isNotableCapture below. */
	notable?: boolean;
}

/** Instability threshold shared with signal.ts's SAT_DUTY_LIMIT — TuneSignal/StepMetrics both carry
 *  this field. */
export const REPORT_NOTABLE_SAT_DUTY = 0.12;

/**
 * Whether a capture's metrics are worth keeping the full raw CSV for in a downloaded report — either
 * it was saturating/unstable (pTermSatDuty), or it shows a standstill control-effort dither the
 * position-error stats alone can't see (restEffort — see docs/PLAN-standstill-effort.md; a dithering
 * capture is exactly the evidence a future D-term calibration needs, and it's otherwise invisible in
 * the downsampled report series). `metrics` is whatever the tuning orchestrator's onAttempt passed
 * (a TuneSignal or StepMetrics), read structurally rather than importing either type — this module's
 * own dependencies stay limited to what report-shaping itself needs.
 */
export function isNotableCapture(metrics: unknown): boolean {
	const m = metrics as { pTermSatDuty?: number; restEffort?: { restTailValid: boolean; pTermRestRipple: number } } | null | undefined;
	if (!m) { return false; }
	if (typeof m.pTermSatDuty === "number" && m.pTermSatDuty >= REPORT_NOTABLE_SAT_DUTY) { return true; }
	return !!(m.restEffort?.restTailValid && m.restEffort.pTermRestRipple > REST_EFFORT_RIPPLE_LIMIT);
}

/**
 * Which captures keep their full raw CSV in a downloaded report: every `notable` (saturating/unstable)
 * capture, plus the LAST capture recorded for each phase — ramp/refine/package attempts for a phase are
 * sequential, so the last one is the closest available proxy for "the value that was actually kept"
 * without threading extra state through the tuning orchestrator. Pass `includeAll: true` for a
 * power-user "attach every capture" download.
 */
export function shapeCapturesForDownload<T extends ReportCapture>(captures: Array<T>, includeAll: boolean): Array<T> {
	if (includeAll) { return captures; }
	const lastIndexOfPhase = new Map<string, number>();
	captures.forEach((c, i) => lastIndexOfPhase.set(c.phase, i));
	return captures.map((c, i) => (
		(c.notable || lastIndexOfPhase.get(c.phase) === i) ? c : { ...c, csv: undefined }
	));
}

export interface SlimBoardInfo {
	firmwareName?: string;
	firmwareVersion?: string;
	canAddress?: number;
	closedLoop?: unknown;
}
export interface SlimAxisInfo {
	letter?: string;
	min?: number;
	max?: number;
	stepsPerMm?: number;
	microstepping?: unknown;
	homed?: boolean;
}

/** The small subset of the object model a report actually needs to diagnose a tune — not the whole thing. */
export function slimModelForReport(
	board: SlimBoardInfo | null, kinematicsName: string | undefined, axis: SlimAxisInfo | null,
): Record<string, unknown> {
	return {
		boards: board ? [board] : [],
		move: { kinematics: kinematicsName ? { name: kinematicsName } : undefined, axis: axis ?? null },
	};
}
