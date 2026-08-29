/**
 * Minimal CSV parsing for the M569.5 capture files. Pure (no DWC import) so it can be unit-tested.
 * The firmware writes a header row followed by numeric rows; the first column is a sample index and
 * there may be a "Timestamp" column (milliseconds). Everything else is a recorded variable keyed by
 * the column header (matching CAPTURE_VARIABLES[].header).
 */

export interface ParsedCapture {
	headers: Array<string>;
	/** Column header → numeric values (NaN for blanks). */
	columns: Record<string, Array<number>>;
	rowCount: number;
	/** Non-data lines the firmware appended (e.g. RRF's "Data lost" buffer-overrun marker). Always
	 *  present ([] when none) so callers never need an optional check. */
	notes: Array<string>;
	/** True when the firmware reported it dropped samples — the capture is short but the rows it did
	 *  write are still valid; callers should keep using it above the usual minimum-sample floor. */
	truncated: boolean;
}

const DATA_LOST_RE = /data\s*lost/i;

/**
 * A line that doesn't split into the expected column count isn't a data row — RRF appends a bare
 * "Data lost" line when its capture buffer overruns, and a torn final line is possible too. Previously
 * every field of a malformed row parsed to NaN and silently poisoned every downstream stat (restBias,
 * computeTuneSignal, …) into null — an otherwise-usable multi-hundred-row capture was discarded
 * outright over one trailing marker. Skip such lines instead of parsing them as data.
 */
export function parseCapture(text: string): ParsedCapture {
	const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
	if (lines.length === 0) {
		return { headers: [], columns: {}, rowCount: 0, notes: [], truncated: false };
	}
	const headers = lines[0].split(",").map((h) => h.trim());
	const columns: Record<string, Array<number>> = {};
	for (const h of headers) {
		columns[h] = [];
	}
	const notes: Array<string> = [];
	let truncated = false;
	let rowCount = 0;
	for (let r = 1; r < lines.length; r++) {
		const cells = lines[r].split(",");
		if (cells.length !== headers.length) {
			notes.push(lines[r].trim());
			if (DATA_LOST_RE.test(lines[r])) { truncated = true; }
			continue;
		}
		for (let c = 0; c < headers.length; c++) {
			columns[headers[c]].push(parseFloat(cells[c]));
		}
		rowCount++;
	}
	// Derived "combined current" column: RRF has no such M569.5 variable (Coil A/B Current are separate
	// bits), but the vector magnitude is what actually relates to torque headroom — see
	// docs/PLAN-v2.4-feedback.md item I. Computed here (once, deterministically) rather than on every
	// chart/report read; only appears when both raw columns were actually recorded.
	const coilA = columns["Coil A Current"];
	const coilB = columns["Coil B Current"];
	if (coilA && coilB) {
		const combinedHeader = "Motor Current (combined)";
		headers.push(combinedHeader);
		columns[combinedHeader] = coilA.map((a, i) => Math.hypot(a, coilB[i] ?? 0));
	}
	return { headers, columns, rowCount, notes, truncated };
}

/** Find a column case-insensitively (header text varies slightly across firmware). */
export function column(capture: ParsedCapture, header: string): Array<number> | null {
	if (capture.columns[header]) {
		return capture.columns[header];
	}
	const lower = header.toLowerCase();
	const key = capture.headers.find((h) => h.toLowerCase() === lower);
	return key ? capture.columns[key] : null;
}

/**
 * A time axis in seconds. Uses a "Timestamp" column (assumed ms) when present, otherwise derives time
 * from the row index and the capture sample rate (Hz); 0 rate falls back to a unit index.
 */
export function timeAxisSeconds(capture: ParsedCapture, sampleRateHz: number): Array<number> {
	const ts = column(capture, "Timestamp");
	if (ts && ts.some((v) => Number.isFinite(v) && v !== 0)) {
		const t0 = ts.find((v) => Number.isFinite(v)) ?? 0;
		return ts.map((v) => (v - t0) / 1000);
	}
	const step = sampleRateHz > 0 ? 1 / sampleRateHz : 1;
	return Array.from({ length: capture.rowCount }, (_, i) => i * step);
}
