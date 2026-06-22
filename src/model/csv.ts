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
}

export function parseCapture(text: string): ParsedCapture {
	const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
	if (lines.length === 0) {
		return { headers: [], columns: {}, rowCount: 0 };
	}
	const headers = lines[0].split(",").map((h) => h.trim());
	const columns: Record<string, Array<number>> = {};
	for (const h of headers) {
		columns[h] = [];
	}
	for (let r = 1; r < lines.length; r++) {
		const cells = lines[r].split(",");
		for (let c = 0; c < headers.length; c++) {
			columns[headers[c]].push(parseFloat(cells[c]));
		}
	}
	return { headers, columns, rowCount: lines.length - 1 };
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
