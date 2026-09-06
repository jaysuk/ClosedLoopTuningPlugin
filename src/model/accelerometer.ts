/**
 * Accelerometer discovery and the M956 capture command.
 *
 * `boards[n].accelerometer` exists in the object model ONLY when that board actually has one (RRF's
 * ExpansionManager.cpp:47 gates the whole sub-object on `hasAccelerometer`), so its presence IS the
 * capability check — exactly how this plugin already detects closed-loop support via `board.closedLoop`.
 */

export interface AccelerometerInfo {
	/** CAN address of the board the accelerometer is attached to — NOT necessarily the tuned driver's. */
	boardAddress: number;
	/** Completed-run counter — the accelerometer's analogue of `closedLoop.runs`. */
	runs: number;
	/** Data points in the last run. */
	points: number;
}

export function findAccelerometers(model: unknown): Array<AccelerometerInfo> {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	const boards = (model as { boards?: Array<any> } | null | undefined)?.boards ?? [];
	const out: Array<AccelerometerInfo> = [];
	for (const b of boards) {
		const a = b?.accelerometer;
		if (!a) { continue; }
		out.push({
			boardAddress: Number(b?.canAddress ?? 0),
			runs: Number(a.runs ?? 0),
			points: Number(a.points ?? 0),
		});
	}
	return out;
}

export interface AccelCaptureOptions {
	/** The accelerometer's own device id for M956 P (e.g. "121.0"). */
	device: string;
	samples: number;
	/**
	 * Nominally 0 = start immediately, 1 = on the next move. In RRF 3.7 the value is parsed and then
	 * DISCARDED (`Accelerometers.cpp`: `(void)mode; // TODO implement mode`), so collection always starts
	 * immediately whatever is passed. Alignment with a closed-loop capture therefore comes from sharing a
	 * G-code line, not from this parameter — which is how it was validated on real hardware
	 * (docs/PLAN-accelerometer.md §12.2). Do not start relying on A to delay a capture.
	 */
	activate: 0 | 1;
	/** Axes to record. Empty/omitted records all three — X/Y/Z are bare presence flags, not values
	 *  (Accelerometers.cpp:411-418). */
	axes?: Array<"X" | "Y" | "Z">;
	/** Bare filename; RRF combines it with 0:/sys/accelerometer/ (Accelerometers.cpp:449). */
	filename?: string;
}

/**
 * Rate to assume ONLY when `useClosedLoopTuning.ts`'s `ensureAccelRateKnown` probe couldn't measure the
 * real one first (a rare fallback, not the normal path — the probe runs before every session's first real
 * capture specifically so this guess is almost never what actually sizes a request).
 *
 * Deliberately biased toward the LOW side of the values seen in the field (800 Hz on the testbench,
 * docs/PLAN-accelerometer.md §12.1) rather than the high end (a fast ADXL345 can reach 1600 Hz+), because
 * the two ways to get this wrong are not equally bad: guessing too LOW under-covers the move, which
 * `Vibration.coverage`/`RegionVibration.samples` already report honestly as missing data, not a false
 * reading — a well-handled failure. Guessing too HIGH makes the accelerometer collect for far longer than
 * the move needs, and a second capture arriving before that first one finishes gets rejected with
 * "already collecting data" — confirmed on real hardware to cascade into the closed-loop capture on the
 * SAME line being lost too (see `isAccelOnlyError`'s doc comment for the full mechanism). Erring low here
 * is the safer default for whatever the one-off probe failure case turns out to be.
 */
export const ACCEL_ASSUMED_RATE_HZ = 800;

/** Extra window, on top of an exact match, to absorb the skew between the two captures' starts. */
export const ACCEL_WINDOW_MARGIN = 1.2;

/**
 * M956 sample count that covers the same wall-clock window as a closed-loop capture of `clSamples` at
 * `clRateHz`, for an accelerometer running at `accelRateHz`. Round UP and keep the margin: over-running
 * costs file size, under-running silently loses the end of the move.
 */
export function accelSampleCount(
	clSamples: number, clRateHz: number, accelRateHz: number, margin = ACCEL_WINDOW_MARGIN,
): number {
	if (!(clSamples > 0) || !(clRateHz > 0) || !(accelRateHz > 0)) { return 1; }
	return Math.max(1, Math.ceil(clSamples * (accelRateHz / clRateHz) * margin));
}

export function buildAccelCaptureCommand(opts: AccelCaptureOptions): string {
	const parts = [`M956 P${opts.device}`, `S${opts.samples}`, `A${opts.activate}`];
	for (const axis of opts.axes ?? []) { parts.push(axis); }
	if (opts.filename) { parts.push(`F"${opts.filename}"`); }
	return parts.join(" ");
}

/**
 * True when every Error:/Warning: segment in a capture line's reply is attributable to the M956
 * accelerometer command sharing that line, not to the M569.5 capture or the move itself.
 *
 * RRF prepends the failing sub-command's own name to its message whenever the code didn't come from a
 * running file — exactly the DWC/plugin case (`GCodes2.cpp`'s `GCodeResult::error`/`warning` handling:
 * `gb.PrintCommand()` + ": " + the original text) — so an M956 failure reads as "M956: <reason>" and a
 * closed-loop failure as "M569.5: <reason>", never blended into one indistinguishable string.
 *
 * This matters because RRF does NOT abort the rest of a multi-command line when one command on it errors:
 * `StringParser::SetFinished` advances to the next command in the line regardless of the previous one's
 * result (confirmed by reading it, not assumed). So an M956-only rejection genuinely means "the
 * closed-loop capture and the move most likely still ran fine," not "the whole line failed." Treating any
 * error text as a full capture failure was a real bug, caught on real hardware: it left the just-armed
 * M569.5 capture uncollected, so a retry's own M569.5 then failed too ("Closed loop data is already being
 * collected"), which escalated into the driver looking like it wasn't tracking a move at all.
 */
export function isAccelOnlyError(reply: string): boolean {
	if (!/M956\b/i.test(reply)) { return false; }
	const stripped = reply.replace(/(?:Error|Warning):\s*M956\b[^\r\n]*/gi, "");
	return !/error:|warning:/i.test(stripped);
}
