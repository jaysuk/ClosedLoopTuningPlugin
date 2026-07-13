/**
 * Dependency-free signal-processing helpers.
 *
 * `autocorrelationPeriod` is a second-chance dominant-period detector for `computeTuneSignal`'s Ku/Tu
 * measurement (signal.ts), used only when the primary method — amplitude-gated zero crossings
 * (`oscillationPeriod`) — finds nothing. A small, decaying oscillation can have a clear periodic shape
 * without ever completing enough full-amplitude half-cycles to clear the zero-crossing gate; a
 * normalised autocorrelation sees the periodicity directly instead of counting crossings.
 *
 * Deliberately NOT a Web Worker + fft.js: benchmarked on a real 2000-sample capture, a full O(n²)
 * autocorrelation over a few hundred lags costs low-single-digit milliseconds — negligible next to the
 * multi-second physical move + firmware capture + file download every measurement already costs (see
 * PLAN-tuning-v4.md's architecture review for the numbers). A worker would add real cost (bundle size,
 * Comlink plumbing) for no perceptible responsiveness gain.
 */

export interface AutocorrelationPeriodOptions {
	/** Minimum normalised autocorrelation value to trust a peak as real periodicity, not noise. */
	minPeakStrength?: number;
	/** Shortest period (in samples) worth considering — filters out sample-to-sample noise. */
	minLagSamples?: number;
}

const DEFAULT_MIN_PEAK_STRENGTH = 0.4;
const DEFAULT_MIN_LAG_SAMPLES = 3;
/** Need at least this many repeats of even the shortest trusted period before trusting any result. */
const MIN_REPEATS = 4;

export interface AutocorrelationResult {
	/** Dominant period, in samples (not seconds — the caller knows the actual sample spacing). */
	lagSamples: number;
	/** Normalised autocorrelation at that lag, in (0, 1] — how strong/clean the periodicity is. */
	strength: number;
}

/**
 * Dominant period of `values[start..end)` via normalised autocorrelation. Returns null when the window
 * is too short, effectively flat (no variance to correlate), or no lag's normalised autocorrelation
 * clears `minPeakStrength` — conservative by design, since a false "found a period" would seed a Ku/Tu
 * search from noise.
 */
export function autocorrelationPeriod(
	values: Array<number>, start: number, end: number, opts: AutocorrelationPeriodOptions = {},
): AutocorrelationResult | null {
	const minPeakStrength = opts.minPeakStrength ?? DEFAULT_MIN_PEAK_STRENGTH;
	const minLag = Math.max(1, opts.minLagSamples ?? DEFAULT_MIN_LAG_SAMPLES);

	const window: Array<number> = [];
	for (let i = Math.max(0, start); i < Math.min(end, values.length); i++) {
		const v = values[i];
		if (Number.isFinite(v)) { window.push(v); }
	}
	const n = window.length;
	if (n < minLag * MIN_REPEATS) { return null; }

	const mean = window.reduce((a, b) => a + b, 0) / n;
	const centered = window.map((v) => v - mean);
	const variance = centered.reduce((a, v) => a + v * v, 0) / n;
	if (variance <= 1e-12) { return null; } // flat signal — nothing periodic to find

	const maxLag = Math.floor(n / 2);
	const r: Array<number> = new Array(maxLag);
	for (let lag = 0; lag < maxLag; lag++) {
		let sum = 0;
		for (let i = 0; i < n - lag; i++) { sum += centered[i] * centered[i + lag]; }
		r[lag] = sum / ((n - lag) * variance);
	}

	// Any smooth (non-white) signal is strongly self-similar at a tiny shift, so r(lag) starts near 1 at
	// lag≈0 and decreases — that initial slope is NOT periodicity, it's just continuity. The dominant
	// PERIOD shows up as the first local maximum after that initial fall, i.e. where the correlation
	// turns around and rises again. Taking the single global-max lag instead would just re-discover the
	// shortest allowed lag on every smooth signal, periodic or not.
	let bestLag = -1;
	let bestStrength = 0;
	for (let lag = minLag; lag < maxLag - 1; lag++) {
		const isLocalMax = r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1];
		if (isLocalMax && r[lag] > bestStrength) { bestStrength = r[lag]; bestLag = lag; }
	}
	if (bestLag < 0 || bestStrength < minPeakStrength) { return null; }
	return { lagSamples: bestLag, strength: bestStrength };
}
