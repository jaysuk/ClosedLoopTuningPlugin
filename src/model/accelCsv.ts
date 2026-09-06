/**
 * Parser for RRF's M956 accelerometer CSV. Deliberately separate from csv.ts: this file has no
 * Timestamp column (time comes from the index and the trailer's achieved rate), and its last line is a
 * `Rate <n>, overflows <n>` summary rather than data — see RRF's Accelerometers.cpp:150-200.
 */

export interface AccelCapture {
	/** Per-axis series in g. Only axes actually present in the header appear. */
	axes: Partial<Record<"X" | "Y" | "Z", Array<number>>>;
	rowCount: number;
	/**
	 * Achieved rate from the trailer — authoritative, and the ONLY way to build a time axis for this
	 * file. Null when the trailer is missing or unparseable: callers must then treat the capture as
	 * untimed and SKIP frequency work, never substitute a guess (a wrong rate silently corrupts every
	 * frequency result downstream).
	 */
	rateHz: number | null;
	/** Dropped samples reported by the trailer. > 0 means the data has gaps. */
	overflows: number;
	/** The file says "Failed to start accelerometer" instead of holding data. */
	failed: boolean;
	/** Every line that produced no data, verbatim: the trailer, failure lines, and any row rejected for
	 *  a wrong cell count or a non-numeric axis value. A non-empty `notes` beyond the trailer means rows
	 *  were dropped, so `rowCount` is lower than the file's line count. */
	notes: Array<string>;
}

const TRAILER_RE = /^Rate\s+(\d+)\s*,\s*overflows\s+(\d+)/i;
const FAILED_RE = /failed to start accelerometer/i;

export function parseAccelCapture(text: string): AccelCapture {
	const axes: AccelCapture["axes"] = {};
	const notes: Array<string> = [];
	const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
	if (lines.length === 0) {
		return { axes, rowCount: 0, rateHz: null, overflows: 0, failed: false, notes };
	}

	const headers = lines[0].split(",").map((h) => h.trim());
	const axisCols: Array<{ axis: "X" | "Y" | "Z"; index: number }> = [];
	headers.forEach((h, i) => {
		const up = h.toUpperCase();
		if (up === "X" || up === "Y" || up === "Z") {
			axisCols.push({ axis: up as "X" | "Y" | "Z", index: i });
			axes[up as "X" | "Y" | "Z"] = [];
		}
	});

	let rateHz: number | null = null, overflows = 0, failed = false, rowCount = 0;
	for (let r = 1; r < lines.length; r++) {
		const line = lines[r];
		const trailer = TRAILER_RE.exec(line);
		if (trailer) {
			rateHz = Number(trailer[1]) > 0 ? Number(trailer[1]) : null;
			overflows = Number(trailer[2]);
			notes.push(line.trim());
			continue;
		}
		if (FAILED_RE.test(line)) { failed = true; notes.push(line.trim()); continue; }
		const cells = line.split(",");
		if (cells.length !== headers.length) { notes.push(line.trim()); continue; }
		// A row of the right WIDTH can still hold an unparseable cell — a blank field ("5,,0.1,0.2") is
		// exactly what a dropped sample looks like. Parse every axis first and reject the whole row if any
		// of them is non-finite, rather than pushing a NaN: one NaN makes that axis's mean NaN in
		// vibration.ts, which poisons the entire series and silently zeroes the axis's contribution to
		// both RMS and peak while still reporting the capture as valid.
		const values: Array<number> = [];
		for (const c of axisCols) {
			const v = parseFloat(cells[c.index]);
			if (!Number.isFinite(v)) { break; }
			values.push(v);
		}
		if (values.length !== axisCols.length) { notes.push(line.trim()); continue; }
		axisCols.forEach((c, i) => { axes[c.axis]!.push(values[i]); });
		rowCount++;
	}
	return { axes, rowCount, rateHz, overflows, failed, notes };
}
