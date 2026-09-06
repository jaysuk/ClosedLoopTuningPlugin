/**
 * Vibration metrics from an accelerometer capture (see accelCsv.ts), split by the closed-loop capture's
 * own move segmentation (accel/cruise/rest) so a machine's vibration can be compared during motion vs at
 * rest. Report-only for now — see docs/PLAN-accelerometer.md §11: never feeds a tuning decision.
 *
 * Two signal-processing traps found by running this code against a synthetic 50 Hz tone, not by reading
 * it — see docs/PLAN-accelerometer.md §7.1 for the measured wrong answers:
 *  - Frequency work uses the per-axis SIGNED series (each with its own mean removed), never the vector
 *    magnitude — the magnitude rectifies the signal and returns a fake low frequency full of harmonics.
 *  - Frequency picks the FIRST local autocorrelation maximum clearing the strength floor, not the
 *    strongest one (dsp.ts's `autocorrelationPeriod` picks strongest, which can land on a harmonic).
 */

import type { SegmentClass } from "./analysis";
import type { AccelCapture } from "./accelCsv";

/** Same floor dsp.ts uses for its own peak acceptance — one convention, not two. */
export const VIBRATION_MIN_STRENGTH = 0.4;

/**
 * Shortest autocorrelation lag considered, which sets the highest reportable frequency at rateHz/3 —
 * well below Nyquist. Frequencies are quantised to rateHz/lag for integer lags, so the buckets are wide
 * at the top of the range: at a real 800 Hz the only values near 200 Hz are 266.7 / 200.0 / 160.0.
 * `dominantHzLow`/`dominantHzHigh` report that bucket so nobody reads `dominantHz` as exact.
 */
export const MIN_LAG = 3;

/** Below this fraction of the closed-loop capture's span, an accelerometer capture is short enough that
 *  whole regions can be missing — see `Vibration.coverage`. */
export const VIBRATION_MIN_COVERAGE = 0.95;

/** First 30% of the at-rest span — where post-move ringing lives if there is any. */
export const REST_SETTLE_FRACTION = 0.30;
/** Last 40% of the at-rest span — the machine's own settled floor, used as this capture's baseline. Real
 *  hardware: two unrelated captures' tails agreed to within 4% of each other (0.0383 g vs 0.0370 g) —
 *  see docs/PLAN-accelerometer.md §17.2 — which is what makes comparing settle against tail self-
 *  calibrating instead of needing a universal threshold. */
export const REST_TAIL_FRACTION = 0.40;
/** Minimum at-rest samples before the settle/tail split is meaningful; below this both regions come back
 *  empty rather than splitting a handful of samples into two meaningless slivers. */
export const REST_SPLIT_MIN_SAMPLES = 60;

export interface RegionVibration {
	/** Combined per-axis RMS, in g: sqrt(Σ var(axis)). NOT the magnitude's RMS — see the module doc. */
	rmsG: number;
	/** Largest single-axis excursion from that axis's own mean, in g. */
	peakG: number;
	/** Dominant vibration frequency, or null when nothing periodic cleared VIBRATION_MIN_STRENGTH. */
	dominantHz: number | null;
	/** The frequency bucket `dominantHz` actually sits in (rateHz/(lag±0.5)) — the whole range is equally
	 *  consistent with the data. Null whenever `dominantHz` is. Report a range, never the bare figure:
	 *  the quantisation is coarse enough at high frequency to be mistaken for precision (see MIN_LAG). */
	dominantHzLow: number | null;
	dominantHzHigh: number | null;
	/** Normalised autocorrelation strength behind `dominantHz` (0 when null). */
	strength: number;
	/** Accelerometer samples in this region. ZERO MEANS NO DATA, not a measured zero — a capture that
	 *  ended before the move did leaves a region empty, and every other field then reads 0/null. Check
	 *  this before reporting any of them. */
	samples: number;
}

export interface Vibration {
	overall: RegionVibration;
	cruise: RegionVibration;
	rest: RegionVibration;
	/** The at-rest span split in two, for comparing "just after the move stopped" against "settled".
	 *  `restSettle` is the first REST_SETTLE_FRACTION of the rest span, `restTail` the last
	 *  REST_TAIL_FRACTION. Both are `samples: 0` when the rest span is shorter than
	 *  REST_SPLIT_MIN_SAMPLES — check before use, same contract as every other region (see
	 *  RegionVibration.samples). See docs/PLAN-accelerometer.md §17. */
	restSettle: RegionVibration;
	restTail: RegionVibration;
	rateHz: number | null;
	overflows: number;
	/** Highest frequency this capture could report at all (rateHz/MIN_LAG). Null when untimed. */
	maxReportableHz: number | null;
	/**
	 * Fraction of the closed-loop capture's time span the accelerometer actually covered. 1 = the whole
	 * capture; below VIBRATION_MIN_COVERAGE, later regions (typically `rest`) may be empty or cut short,
	 * which reads as "no vibration" unless the caller checks `samples`. Happens when the accelerometer's
	 * real rate is higher than the one used to size the M956 sample count.
	 */
	coverage: number;
	/** False when there's nothing trustworthy here. Every consumer must SKIP on false, never fail. */
	valid: boolean;
}

const EMPTY_REGION: RegionVibration = {
	rmsG: 0, peakG: 0, dominantHz: null, dominantHzLow: null, dominantHzHigh: null, strength: 0, samples: 0,
};

/**
 * Dominant period of a signed, single-axis window, as a lag in samples.
 *
 * Deliberately NOT dsp.ts's `autocorrelationPeriod`, which returns the STRONGEST local maximum. A
 * periodic signal has near-equal maxima at every multiple of its period, so "strongest" can land on a
 * harmonic — measured: a 50 Hz sine came back as 16.7 Hz. Walking ascending and taking the FIRST
 * qualifying maximum returns the fundamental. Everything else here matches dsp.ts's approach.
 */
function dominantLag(values: Array<number>, start: number, end: number): { lagSamples: number; strength: number } | null {
	const w: Array<number> = [];
	for (let i = Math.max(0, start); i < Math.min(end, values.length); i++) {
		if (Number.isFinite(values[i])) { w.push(values[i]); }
	}
	const n = w.length;
	const minLag = MIN_LAG;
	if (n < minLag * 4) { return null; }
	const mean = w.reduce((a, b) => a + b, 0) / n;
	const c = w.map((v) => v - mean);
	const variance = c.reduce((a, v) => a + v * v, 0) / n;
	if (variance <= 1e-12) { return null; }

	const maxLag = Math.floor(n / 2);
	const r: Array<number> = new Array(maxLag);
	for (let lag = 0; lag < maxLag; lag++) {
		let sum = 0;
		for (let i = 0; i < n - lag; i++) { sum += c[i] * c[i + lag]; }
		r[lag] = sum / ((n - lag) * variance);
	}
	for (let lag = minLag; lag < maxLag - 1; lag++) {
		if (r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1] && r[lag] >= VIBRATION_MIN_STRENGTH) {
			return { lagSamples: lag, strength: r[lag] };
		}
	}
	return null;
}

/** The recorded axes as signed, mean-removed series — the form the frequency/RMS work above requires. */
export function axisSeries(capture: AccelCapture): Array<Array<number>> {
	const out: Array<Array<number>> = [];
	for (const axis of ["X", "Y", "Z"] as const) {
		const s = capture.axes[axis];
		if (!s || s.length === 0) { continue; }
		const mean = s.reduce((a, b) => a + b, 0) / s.length;
		out.push(s.map((v) => v - mean));
	}
	return out;
}

function regionStats(series: Array<Array<number>>, from: number, to: number, rateHz: number | null): RegionVibration {
	const samples = Math.max(0, to - from);
	if (samples === 0 || series.length === 0) { return { ...EMPTY_REGION }; }

	// Combined RMS is sqrt of the summed per-axis variances. Peak is the largest single-axis excursion —
	// a scalar "worst shake", not a vector length.
	let sumVar = 0, peak = 0;
	for (const s of series) {
		let sumSq = 0, count = 0;
		for (let i = from; i < to; i++) {
			const v = s[i];
			if (!Number.isFinite(v)) { continue; }
			sumSq += v * v; count++;
			peak = Math.max(peak, Math.abs(v));
		}
		if (count > 0) { sumVar += sumSq / count; }
	}

	// Frequency: take the strongest-periodicity axis, since a machine's dominant vibration is usually
	// along one direction and averaging across axes would dilute it.
	let best: { lagSamples: number; strength: number } | null = null;
	if (rateHz != null) {
		for (const s of series) {
			const d = dominantLag(s, from, to);
			if (d && (!best || d.strength > best.strength)) { best = d; }
		}
	}

	// A lag is an integer count of samples, so the reachable frequencies are rateHz/lag — a comb that gets
	// very sparse as lag falls. Report the bucket around the chosen lag (±half a sample) alongside the
	// point value, so a consumer can see how much of the spectrum "200 Hz" really stands for.
	const timed = best != null && rateHz != null;
	return {
		rmsG: Math.sqrt(sumVar),
		peakG: peak,
		dominantHz: timed ? rateHz! / best!.lagSamples : null,
		dominantHzLow: timed ? rateHz! / (best!.lagSamples + 0.5) : null,
		dominantHzHigh: timed ? rateHz! / (best!.lagSamples - 0.5) : null,
		strength: best?.strength ?? 0,
		samples,
	};
}

/**
 * Vibration metrics for a capture, split by the CLOSED-LOOP capture's own move segmentation.
 *
 * `clTime`/`clClasses` come from the closed-loop capture (timeAxisSeconds + segmentMove, same length).
 * Accelerometer sample j is placed at t = j / rateHz and takes the class of the nearest closed-loop
 * sample in time — both series are monotonic, so this is a single linear merge walk. This is where the
 * "assume a common t=0" assumption between the two independently-triggered captures lives (see
 * docs/PLAN-accelerometer.md §6); it is the ONLY place that assumption is made.
 */
export function computeVibration(
	capture: AccelCapture, clTime: Array<number>, clClasses: Array<SegmentClass>,
): Vibration {
	const series = axisSeries(capture);
	const rateHz = capture.rateHz;
	const total = capture.rowCount;
	if (capture.failed || series.length === 0 || total === 0 || rateHz == null) {
		return {
			overall: { ...EMPTY_REGION }, cruise: { ...EMPTY_REGION }, rest: { ...EMPTY_REGION },
			restSettle: { ...EMPTY_REGION }, restTail: { ...EMPTY_REGION },
			rateHz, overflows: capture.overflows, maxReportableHz: null, coverage: 0, valid: false,
		};
	}

	// How much of the closed-loop capture the accelerometer actually spans. The two captures share a t=0
	// (see below) but not a length: M956 takes a sample COUNT, so if the accelerometer's real rate is
	// higher than whoever sized that count assumed, it stops early and the later regions come back empty.
	// An empty region is indistinguishable from a still machine unless this is reported — hence the field.
	const clSpan = clTime.length > 1 ? clTime[clTime.length - 1] - clTime[0] : 0;
	const coverage = clSpan > 0 ? Math.min(1, (total / rateHz) / clSpan) : 1;
	const base = { rateHz, overflows: capture.overflows, maxReportableHz: rateHz / MIN_LAG, coverage };

	// segmentMove's classes come out as contiguous runs (accel → cruise → transition → rest), so each
	// region is a [from, to) span rather than a scattered index set. Walk both monotonic time bases once.
	const n = Math.min(clTime.length, clClasses.length);
	const span = (want: SegmentClass): [number, number] => {
		let from = -1, to = 0, cl = 0;
		for (let j = 0; j < total; j++) {
			const t = j / rateHz;
			while (cl < n - 1 && Math.abs(clTime[cl + 1] - t) <= Math.abs(clTime[cl] - t)) { cl++; }
			if (clClasses[cl] === want) {
				if (from < 0) { from = j; }
				to = j + 1;
			}
		}
		return from < 0 ? [0, 0] : [from, to];
	};

	const [cFrom, cTo] = n > 0 ? span("cruise") : [0, 0];
	const [rFrom, rTo] = n > 0 ? span("rest") : [0, 0];

	// Split the rest span into "just after the move stopped" and "settled", so a capture can be compared
	// against its OWN baseline instead of a universal threshold — see docs/PLAN-accelerometer.md §17.2.
	const restLen = rTo - rFrom;
	const splittable = restLen >= REST_SPLIT_MIN_SAMPLES;
	const settleEnd = rFrom + Math.floor(restLen * REST_SETTLE_FRACTION);
	const tailStart = rFrom + Math.floor(restLen * (1 - REST_TAIL_FRACTION));

	return {
		overall: regionStats(series, 0, total, rateHz),
		cruise: regionStats(series, cFrom, cTo, rateHz),
		rest: regionStats(series, rFrom, rTo, rateHz),
		restSettle: splittable ? regionStats(series, rFrom, settleEnd, rateHz) : { ...EMPTY_REGION },
		restTail: splittable ? regionStats(series, tailStart, rTo, rateHz) : { ...EMPTY_REGION },
		...base,
		valid: true,
	};
}
