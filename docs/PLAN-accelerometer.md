# Plan: accelerometer-based vibration measurement alongside closed-loop tuning

**Status:** planned, not started. Written 2026-09-05 from a user question ("could we use an accelerometer
on the toolhead or motor to measure noise?") after a firmware-source investigation confirmed it's
feasible.

**Audience:** written to be implemented directly. Every firmware claim in §1 was read out of the real
RRF source in this repo's sibling checkout (`RRFBuild/RepRapFirmware`, 3.7.0-beta.1, commit `dc265c5`),
not from memory or documentation. §11 lists what NOT to do.

**Readiness — read this before picking up any phase:**

| Phase | Items | Ready to implement? |
|---|---|---|
| 1 | **A** detection, **C** parser | **Yes** — literal code in §3/§4, synthetic tests in §9, no hardware needed |
| 3 | **E** metrics (the pure half) | **Yes** — literal code in §7, synthetic tests in §9 |
| 2 | **B** combined capture, **D** correlation | **BLOCKED** on §12 — the command shape is not knowable from source |
| 3b | **E**'s frequency-match threshold, the evaluate.ts finding | **BLOCKED** on §12 — needs one real capture pair to calibrate |
| 4 | **F** UI + report | Yes, but pointless before Phase 2 works |

Phases 1 and 3 are pure model code with no machine interaction and can be built and merged
independently — they're useful on their own (a parser and metrics with tests) and de-risk the rest.

**Why this is worth doing:** the plugin currently infers "is this ripple mechanical or is it the control
loop?" indirectly, from encoder data alone — see `cruiseRing` (docs/PLAN-v2.4-feedback.md §2.3), which is
explicitly report-only *because* it's a signature match rather than evidence. An accelerometer measures
the mechanical side directly. It also answers the question the encoder structurally cannot: "is the
machine actually quieter after this tune?" — encoder error is what the loop is *trying* to minimise, so
it's a biased judge of its own work.

---

## 1. Verified firmware facts (the load-bearing evidence)

All read from `RRFBuild/RepRapFirmware` @ `dc265c5` (3.7.0-beta.1).

**1.1 There is no interlock between the two captures.**
`ClosedLoop::StartDataCollection` (M569.5, `src/ClosedLoop/ClosedLoop.cpp:105`) refuses only if
`closedLoopFile != nullptr` — its own state. `Accelerometers::StartAccelerometer` (M956,
`src/Accelerometers/Accelerometers.cpp:399`) refuses only if `accelerometerFile != nullptr` — its own
state. Neither checks the other. Separate files, separate CAN message types, separate "busy" flags.

**1.2 They are independent subsystems.** The accelerometer runs in its own FreeRTOS task
(`AccelerometerTaskCode`, `TaskPriority::Accelerometer` = 6, `Accelerometers.cpp:102`). Closed-loop
sampling happens on the driver board and is streamed to the mainboard over CAN
(`CanMessageClosedLoopData`), which only writes the file. On a typical modular setup — accelerometer on
a toolboard, closed-loop driver on an axis board — these are **different MCUs entirely**.

**1.3 The object model advertises an accelerometer the same way it advertises closed loop.**
`src/CAN/ExpansionManager.cpp:47-49`:
```
boards[n].accelerometer   present only if hasAccelerometer   → { orientation, points, runs }
boards[n].closedLoop      present only if hasClosedLoop      → { points, runs }
```
`accelerometerRuns` is incremented on completion (`ExpansionManager.cpp:485-488`) — the exact analogue
of `closedLoop.runs`, which this plugin already watches for capture completion
(`useClosedLoopTuning.ts`'s `waitForRuns()` and the `record()` watcher).

**1.4 The accelerometer CSV is NOT shaped like the closed-loop CSV.** From
`Accelerometers.cpp:150-200`:
- Header: `Sample,X,Y,Z` (only the axes requested) — **no `Timestamp` column.**
- Rows: `<index>,<x>,<y>,<z>`, values in **g** as floats.
- **Trailer line: `Rate <actual>, overflows <n>`** — the *achieved* rate and a dropped-data count.
- On failure the file instead contains `Failed to start accelerometer`.

The trailer carries the **authoritative sample rate**, which is the only way to build a time axis for a
file with no timestamps, and `overflows > 0` is a data-quality signal. Both must be parsed, not skipped.

**1.5 Command + move on one line is the established pattern.** DWC's own InputShaping plugin does
exactly this (`DuetWebControl/src/plugins/InputShaping/RecordMotionProfileDialog.vue:560`):
```
M400 M956 P{accel} S{samples} A0 F"{file}" G1 {move} F{speed}
```
Note it uses `A0` (immediate), not `A1` (on next move), and prefixes `M400`.

---

## 2. Implementation order

1. **Phase 1 — A + C** (§3, §4). Pure, no hardware. Merge on its own.
2. **Phase 3 — E's pure half** (§7). Pure, no hardware. Merge on its own.
3. **§12 hardware validation.** Blocks everything below.
4. **Phase 2 — B + D** (§5, §6). Shape determined by §12's answers.
5. **Phase 3b + 4 — the finding and the UI** (§7.4, §8).

---

## 3. Item A — detection and gating  ✅ READY

**File: `src/model/accelerometer.ts`** (new — detection plus the M956 builder. Not `m569.ts`: that file's
own header scopes it to "The M569 command family", and M956 is a different command family.)

```ts
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
	/** M955 I-parameter orientation, or null when the board didn't report one. */
	orientation: number | null;
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
			orientation: typeof a.orientation === "number" ? a.orientation : null,
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
	/** 0 = start immediately (what DWC's InputShaping uses), 1 = on next move. */
	activate: 0 | 1;
	/** Axes to record. Empty/omitted records all three — X/Y/Z are bare presence flags, not values
	 *  (Accelerometers.cpp:411-418). */
	axes?: Array<"X" | "Y" | "Z">;
	/** Bare filename; RRF combines it with 0:/sys/accelerometer/ (Accelerometers.cpp:449). */
	filename?: string;
}

export function buildAccelCaptureCommand(opts: AccelCaptureOptions): string {
	const parts = [`M956 P${opts.device}`, `S${opts.samples}`, `A${opts.activate}`];
	for (const axis of opts.axes ?? []) { parts.push(axis); }
	if (opts.filename) { parts.push(`F"${opts.filename}"`); }
	return parts.join(" ");
}
```

**Wiring in `useClosedLoopTuning.ts`** (mirrors the existing `drivers`/`selectedBoard` computeds):

```ts
const accelerometers = computed(() => findAccelerometers(host.model()));
/** Prefer the tuned driver's own board if it has one, else the first available — a toolhead
 *  accelerometer is usually a DIFFERENT board from the axis driver being tuned. */
const accelerometerBoard = computed<AccelerometerInfo | null>(() => {
	const all = accelerometers.value;
	if (all.length === 0) { return null; }
	const own = selectedBoard.value?.canAddress;
	return all.find((a) => a.boardAddress === own) ?? all[0];
});
```

The whole feature is hidden when `accelerometers.value.length === 0`, and is never required.

---

## 4. Item C — parsing the accelerometer CSV  ✅ READY

**File: `src/model/accelCsv.ts`** (new — separate from `csv.ts`: different shape, different trailer
semantics, and `csv.ts`'s contract is deliberately narrow).

```ts
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
	/** Every non-data line, verbatim (trailer and failure lines included). */
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
		for (const c of axisCols) { axes[c.axis]!.push(parseFloat(cells[c.index])); }
		rowCount++;
	}
	return { axes, rowCount, rateHz, overflows, failed, notes };
}
```

---

## 5. Item B — the combined capture  ⛔ BLOCKED on §12

Extend `captureRaw()` in `useClosedLoopTuning.ts`. Today it builds one M569.5 command with the move
appended; with the accelerometer enabled it must also arm M956 for the *same* move.

Two candidate shapes, in preference order — **§12.1 decides which**:

1. **One line:**
   `M400 M569.5 P{drv} S{n} A1 R{rate} D{bits} M956 P{accel} S{aN} A0 F"{file}" G1 H2 {axis}{dist} F{feed}`
2. **Two commands, move on the second:** arm M569.5 with `A1` (on next move), then send
   `M400 M956 … G1 …` as InputShaping does; M569.5's `A1` fires on the move the M956 line carries.

Completion detection: watch **both** `closedLoop.runs` and `accelerometer.runs` on their respective
boards, reusing `waitForRuns()`'s existing shape. Both must advance before reading files. The
accelerometer file lives in `0:/sys/accelerometer/` (`Accelerometers.cpp:452`), listed and downloaded
with the `getFileList`/`download` host calls already used for `0:/sys/closed-loop/`.

**Safety and failure rules — non-negotiable:**
- An accelerometer failure must **never** fail the tuning run. No accelerometer, a failed start, a
  missing trailer, a mismatched sample count: log it, drop the vibration data for that attempt, carry on
  with the closed-loop capture exactly as today. This is a diagnostic overlay, not a dependency.
- `deleteCapturesAfterRead` must cover accelerometer CSVs too, or a run now fills *two* directories.
- `isCancelled()` gates this identically — checked before the capture is issued, so no new gap.

---

## 6. Item D — putting both on one time base  ⛔ BLOCKED on §12

```
accel time(i)       = i / rateHz     // trailer rate, never assumed
closed-loop time(i)                  // its own Timestamp column, via existing timeAxisSeconds()
```

Both start from the same physical trigger **only if** §12.1/§12.2 confirm it. Expect a small constant
offset (arming order, firmware latency).

- **v1: assume a common t=0, report the caveat.** Adequate for "how much vibration, at what frequency" —
  neither is offset-sensitive.
- **Later, only if §12.2 shows a variable offset:** cross-correlate accelerometer magnitude against the
  commanded acceleration profile. Do not build this speculatively.

---

## 7. Item E — metrics  ✅ READY (§7.1-7.3) / ⛔ §7.4 BLOCKED

**File: `src/model/vibration.ts`** (new).

### 7.1 Two signal-processing traps — both found by running the code, not by reading it

An earlier draft of this section used the vector magnitude for everything and reused
`autocorrelationPeriod` directly. Both were wrong; a scratch run against a synthetic 50 Hz sine at
1000 Hz proved it. Do not "simplify" back to either.

**Trap 1 — the magnitude rectifies the signal.** `sqrt(x²+y²+z²)` of a signed vibration is `|x|` for
single-axis motion. Rectification doubles the fundamental and injects harmonics: the 50 Hz sine came
back as **2.8 Hz** with an RMS of **0.318** instead of 0.707. So:
- **Frequency work uses the per-axis SIGNED series**, each with its own mean removed (that mean is
  gravity plus static bias — real, but not vibration).
- **Amplitude uses the combined per-axis RMS**, `sqrt(Σ var(axis))`, which returns the correct 0.7071.
  Magnitude is not used for either.

**Trap 2 — `autocorrelationPeriod` picks the strongest peak, which can be a harmonic.** A pure sine has
near-equal autocorrelation maxima at *every* multiple of its period, so "strongest" landed on the 3rd
multiple: the 50 Hz sine came back as **16.7 Hz**. For Ku/Tu estimation (what dsp.ts was built for)
landing on a multiple is tolerable; for "what frequency is this vibration" it is simply wrong. So
vibration.ts gets its own small peak-picker that walks lags ascending and takes the **first** local
maximum clearing the strength floor — the fundamental. Verified: 50→50.0 Hz, 17→16.9 Hz, white
noise→null.

**Known accuracy limit:** lag is an integer number of samples, so resolution coarsens as frequency rises
relative to the sample rate — a 120 Hz tone at 1000 Hz sampling reads as 125 Hz (8 samples/cycle). Report
`dominantHz` as indicative, and do not build any equality comparison tighter than §7.2's tolerance.

### 7.2 Constants

```ts
/** Same floor dsp.ts uses for its own peak acceptance — one convention, not two. */
export const VIBRATION_MIN_STRENGTH = 0.4;
/**
 * Two regions count as "the same frequency" within this relative tolerance. PROVISIONAL — invented, not
 * measured, because no capture pair exists yet. §12.5 replaces it with a real number; until then it is
 * used ONLY by §7.4's report-only finding, never by a decision.
 */
export const VIBRATION_FREQ_MATCH = 0.15;
```

### 7.3 The code

```ts
import type { SegmentClass } from "./analysis";
import type { AccelCapture } from "./accelCsv";

export interface RegionVibration {
	/** Combined per-axis RMS, in g: sqrt(Σ var(axis)). See §7.1 trap 1 — NOT the magnitude's RMS. */
	rmsG: number;
	/** Largest single-axis excursion from that axis's own mean, in g. */
	peakG: number;
	/** Dominant vibration frequency, or null when nothing periodic cleared VIBRATION_MIN_STRENGTH. */
	dominantHz: number | null;
	/** Normalised autocorrelation strength behind `dominantHz` (0 when null). */
	strength: number;
	samples: number;
}

export interface Vibration {
	overall: RegionVibration;
	cruise: RegionVibration;
	rest: RegionVibration;
	rateHz: number | null;
	overflows: number;
	/** False when there's nothing trustworthy here. Every consumer must SKIP on false, never fail. */
	valid: boolean;
}

const EMPTY_REGION: RegionVibration = { rmsG: 0, peakG: 0, dominantHz: null, strength: 0, samples: 0 };

/**
 * Dominant period of a signed, single-axis window, as a lag in samples.
 *
 * Deliberately NOT dsp.ts's `autocorrelationPeriod`, which returns the STRONGEST local maximum. A
 * periodic signal has near-equal maxima at every multiple of its period, so "strongest" can land on a
 * harmonic — measured: a 50 Hz sine came back as 16.7 Hz (§7.1 trap 2). Walking ascending and taking the
 * FIRST qualifying maximum returns the fundamental. Everything else here matches dsp.ts's approach.
 */
function dominantLag(values: Array<number>, start: number, end: number): { lagSamples: number; strength: number } | null {
	const w: Array<number> = [];
	for (let i = Math.max(0, start); i < Math.min(end, values.length); i++) {
		if (Number.isFinite(values[i])) { w.push(values[i]); }
	}
	const n = w.length;
	const minLag = 3;
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

/** The recorded axes as signed, mean-removed series — the form both traps in §7.1 require. */
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

	// Combined RMS is sqrt of the summed per-axis variances (§7.1 trap 1). Peak is the largest single-
	// axis excursion — a scalar "worst shake", not a vector length.
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

	return {
		rmsG: Math.sqrt(sumVar),
		peakG: peak,
		dominantHz: best && rateHz != null ? rateHz / best.lagSamples : null,
		strength: best?.strength ?? 0,
		samples,
	};
}

/**
 * Vibration metrics for a capture, split by the CLOSED-LOOP capture's own move segmentation.
 *
 * `clTime`/`clClasses` come from the closed-loop capture (timeAxisSeconds + segmentMove, same length).
 * Accelerometer sample j is placed at t = j / rateHz and takes the class of the nearest closed-loop
 * sample in time — both series are monotonic, so this is a single linear merge walk. This is where §6's
 * "assume a common t=0" assumption lives; it is the ONLY place that assumption is made.
 */
export function computeVibration(
	capture: AccelCapture, clTime: Array<number>, clClasses: Array<SegmentClass>,
): Vibration {
	const series = axisSeries(capture);
	const rateHz = capture.rateHz;
	const base = { rateHz, overflows: capture.overflows };
	const total = capture.rowCount;
	if (capture.failed || series.length === 0 || total === 0 || rateHz == null) {
		return { overall: { ...EMPTY_REGION }, cruise: { ...EMPTY_REGION }, rest: { ...EMPTY_REGION }, ...base, valid: false };
	}

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

	return {
		overall: regionStats(series, 0, total, rateHz),
		cruise: regionStats(series, cFrom, cTo, rateHz),
		rest: regionStats(series, rFrom, rTo, rateHz),
		...base,
		valid: true,
	};
}
```

### 7.4 The evaluate.ts finding  ⛔ BLOCKED on §12.5

When `cruiseRing`/`restRing` already say "possibly mechanical" **and** the accelerometer shows the same
`dominantHz` in both cruise and rest (within `VIBRATION_FREQ_MATCH`, both clearing
`VIBRATION_MIN_STRENGTH`), upgrade the existing "Rings after stopping" detail from a hedge to a
statement. Follow PLAN-v2.4-feedback.md §2.3's rules exactly: **append to the existing finding's detail,
never add a finding, never change severity, score, term or direction.**

Blocked because `VIBRATION_FREQ_MATCH` is currently invented. Do not ship this sub-item on a guessed
threshold — that is the mistake avoided twice already this cycle (the RP2350 ceiling and the D-ripple
gate both waited for real numbers).

---

## 8. Item F — UI and report

- **Advanced tuning options** (where Samples/Rate/E now live): a "Record vibration" checkbox and an
  accelerometer selector, rendered only when `accelerometers.length > 0`. Persist alongside the other
  settings (`SavedState` + `persistState` + the `watch` list).
- **Chart:** the accelerometer capture has its own time base and cannot become a `CAPTURE_VARIABLES`
  entry (those all read columns out of one `ParsedCapture`). For v1, a separate small chart beneath the
  main one sharing the x-range. **Do not bolt a second time base onto `CaptureChart`'s dataset builder.**
- **Report:** add the `Vibration` object to the per-capture record. `ReportCapture.metrics` is typed
  `unknown` and carries whole objects, so fields flow through with no `report.ts` change — prove that
  with a round-trip test rather than assuming (exactly how `restEffort` was added).

Both `.vue` files get markup only, and their destructure lists must stay identical — check with the diff
script used throughout this repo's UI work.

---

## 9. Test plan

**Phase 1 — `accelCsv.test.ts`** (all synthetic, no fixture files needed):
- `"Sample,X,Y,Z\n0,0.1,0.2,0.3\n1,0.1,0.2,0.3\nRate 1344, overflows 0\n"` → `rowCount 2`,
  `rateHz 1344`, `overflows 0`, `axes.X.length === 2`, trailer in `notes`, `failed false`.
- Same with `Rate 1344, overflows 7` → `overflows 7`.
- `"Sample,X\nFailed to start accelerometer\n"` → `failed true`, `rowCount 0`.
- No trailer at all → `rateHz null` (**and not a default**), data still parsed.
- Axis subset `"Sample,X,Z\n0,1,2\nRate 1000, overflows 0\n"` → `axes.X`/`axes.Z` present, `axes.Y`
  `undefined`.
- A short/garbled row (wrong cell count) → skipped into `notes`, never NaN in a series.

**Phase 1 — `accelerometer.test.ts`:**
- `findAccelerometers` on a model with two boards, one with `accelerometer`, one without → one entry,
  right `boardAddress`/`runs`/`points`; missing `orientation` → `null`.
- Empty/absent `boards` → `[]` (no throw).
- `buildAccelCaptureCommand({ device: "121.0", samples: 1000, activate: 0 })` →
  `M956 P121.0 S1000 A0`; with `axes: ["X","Z"], filename: "t.csv"` →
  `M956 P121.0 S1000 A0 X Z F"t.csv"`.

**Phase 3 — `vibration.test.ts`.** Every number below was produced by actually running §7.3's code, not
estimated — they are exact expectations, not approximations to be adjusted until they pass.

Base fixture: `X = sin(2π·50·t) + 1.0` (a 50 Hz tone on a 1 g gravity offset), `rateHz 1000`, 300
samples, `clClasses` = 100 `accel` / 100 `cruise` / 100 `rest`, `clTime[i] = i/1000`.
- `valid === true`; `overall.rmsG` ≈ **0.7071** (±0.001) — proves the gravity offset was removed, since
  it would otherwise dominate.
- `overall.dominantHz` === **50.0** (±0.5) — proves the fundamental, not a harmonic (§7.1 trap 2 gave
  16.7 Hz here).
- `overall.samples === 300`, `cruise.samples === 100`, `rest.samples === 100`.
- `rateHz: null` → `valid false`, all regions empty. `failed: true` → `valid false`.
- Uniform random noise → `dominantHz null` in every region.
- **Rectification guard:** the same tone analysed via `sqrt(x²)` instead of the signed series must NOT
  reproduce 50 Hz — pin this so nobody "simplifies" §7.3 back to a magnitude (it returned 2.8 Hz).
- **Quantisation:** a 120 Hz tone at 1000 Hz reads **125.0** Hz (8-sample lag). Assert that, don't
  assert 120 — it documents the §7.1 accuracy limit rather than hiding it.

**Phase 2/3b — integration (blocked):** one real capture pair from §12 as fixtures; regions align, and
the §7.4 finding upgrades only when both signals agree.

**Regression:** with the feature off, every existing capture path is byte-for-byte unchanged; with an
accelerometer that fails mid-run, the tuning run still completes normally.

---

## 10. Verification checklist

- [ ] `npm test` — all existing pass, plus new
- [ ] `DWC_DIR=<3.7> npm run typecheck` and `npm run verify-build`
- [ ] `DWC36_DIR=<3.6> npm run check-ui36` **and** a real 3.6 webpack build (only once `.vue` files change
      in Phase 4 — Phases 1 and 3 touch no UI)
- [ ] Hardware: a tuning run with vibration recording produces two aligned captures; a run with the
      accelerometer unplugged mid-way completes normally with the vibration data simply absent

---

## 11. Explicit non-goals — do NOT do these

- **Do not feed vibration into `signalCost` or any accept/reject decision.** Report-only for v1, exactly
  as the D-term ripple and `cruiseRing` items were.
- **Do not make the tuning run depend on the accelerometer in any way.** Every failure mode is "log it
  and carry on with the tune".
- **Do not add an FFT library or a Web Worker.** dsp.ts's docstring documents the benchmark: O(n²)
  autocorrelation over a few hundred lags is low-single-digit milliseconds, negligible beside the
  multi-second physical move. That reasoning still holds here — the cost was never the problem.
- **Do not replace §7.3's `dominantLag` with a call to `autocorrelationPeriod`.** They differ in one
  deliberate way (first qualifying peak vs strongest), and that difference is the whole point — see
  §7.1 trap 2, where reusing it returned 16.7 Hz for a 50 Hz tone. The duplication is ~15 lines and is
  intentional; do not "de-duplicate" it.
- **Do not compute frequency from the vector magnitude** (§7.1 trap 1).
- **Do not guess a sample rate when the trailer is missing.** `rateHz: null` → skip, never substitute.
- **Do not assume the accelerometer is on the driver's own board.** Toolhead-mounted is the common case.
- **Do not extend `CaptureChart`'s dataset builder to a second time base** (§8).
- **Do not touch M955.** Wiring, orientation and pins are config.g's job; this plugin only reads whether
  an accelerometer exists and uses M956.
- **Do not ship §7.4 on the provisional `VIBRATION_FREQ_MATCH`.** Wait for §12.5.

---

## 12. Hardware questions that block Phase 2

See the separate question list handed over with this plan. In short: whether a combined line works
(§12.1), whether both captures actually start together (§12.2), what rate/overflows the trailer reports
(§12.3), whether running both degrades the closed-loop data (§12.4), and one real capture pair to
calibrate the frequency-match tolerance (§12.5).
