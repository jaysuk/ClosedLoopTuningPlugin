# Plan: accelerometer-based vibration measurement alongside closed-loop tuning

**Status:** All phases implemented, including Phase 3b (§17), which replaces §7.4's original design after
frequency matching was tested against real data and rejected. **Nothing in this plan is outstanding.**
484 tests pass (8 new for §17), DWC 3.7 typecheck clean. No `.vue` files changed, so `verify-build`/
`check-ui36` were not re-run for this change; they are clean as of Phase 4/v2.6.0's own verification.

Written 2026-09-05 from a user question ("could we use an accelerometer on the toolhead or motor to
measure noise?"); audited the same day (§13); a real-hardware regression from that audit's own fix found
and corrected 2026-09-06 (§14). Read §14 before touching `ACCEL_ASSUMED_RATE_HZ` or the capture
error-handling.

**§15 and §16 must be read together, in that order, before touching the frequency maths or §7.4.** §15
concluded the ~200 Hz signal these captures show was a sensor artifact and §16 originally specified a fix
for it; both were wrong, built on a capture labelled "idle" whose motor was still energised. §16 is now
the correction: the sensor's real noise floor shows no periodicity, `VIBRATION_MIN_STRENGTH = 0.4` is
correctly placed, and the 200 Hz is genuine motor vibration. §16.5 records how the mistake survived three
rounds of internally-consistent checking, which is worth reading before trusting any similar analysis.

**Audience:** written to be implemented directly. Every firmware claim in §1 was read out of the real
RRF source in this repo's sibling checkout (`RRFBuild/RepRapFirmware`, 3.7.0-beta.1, commit `dc265c5`),
not from memory or documentation. §11 lists what NOT to do.

**Readiness — read this before picking up any phase:**

| Phase | Items | Ready to implement? |
|---|---|---|
| 1 | **A** detection, **C** parser | **DONE** — implemented, 11 tests passing. Do not rebuild. |
| 3 | **E** metrics (the pure half) | **DONE** — implemented, 10 tests passing. Do not rebuild. |
| 2 | **B** combined capture, **D** correlation | **DONE** — implemented in `m569.ts`/`useClosedLoopTuning.ts`, 8 new tests (2 unit + 6 integration against real hardware fixtures) passing. `npm test` and `DWC_DIR` typecheck both clean. Do not rebuild. |
| 3b | **E**'s evaluate.ts finding | **DONE** — implemented as §17's settle-vs-tail comparison (§7.4's original frequency-match design was rejected, §17.1). Do not rebuild. |
| 4 | **F** UI + report | **DONE** — settings, chart, and report wiring implemented in both `.vue` files; `verify-build`/`check-ui36`/a real 3.6 build all clean. Do not rebuild. |
| ~~16~~ | ~~Strength floor below the sensor's noise floor~~ | **RETRACTED — no such defect.** Built on a mislabelled capture; see §16. No code change needed. |

Phases 1 and 3 are pure model code with no machine interaction and can be built and merged
independently — they're useful on their own (a parser and metrics with tests) and de-risk the rest.

---

## START HERE (implementer handoff)

### Already done — do NOT rebuild any of this

Phases 1, 2, 3, and 4 are **implemented, audited (§13) and on disk**, with 49 passing tests (including 8
integration tests and a report round-trip test against real hardware fixtures), a clean DWC 3.7 typecheck
+ verify-build, a clean `check-ui36` (5/5), and a clean real DWC 3.6 webpack build. The feature works
end to end: detection, capture, parsing, metrics, settings, chart, and report — all off by default
(`recordVibration`).
- `src/model/accelerometer.ts`, `src/model/accelCsv.ts`, `src/model/vibration.ts` (Phases 1/3)
- `src/model/m569.ts`'s `CaptureOptions.alongside`; `src/model/signal.ts`'s `TuneSignal.vibration` and
  `medianSignal`'s pass-through; `src/core/useClosedLoopTuning.ts`'s accelerometer selection,
  `recordVibration`/`selectedAccelerometerAddress`, `accelCapture`, and `captureRaw()`'s extension
  (Phase 2, §5)
- `src/ui37/VibrationChart.vue`, `src/ui36/VibrationChart.vue`, and both pages' checkbox/selector/chart
  markup (Phase 4, §8)
- Every file under `src/__tests__/` matching `accel*`, `src/__tests__/fixtures/accel-2026-09-05/`, and
  the vibration-related additions to `m569.test.ts`/`report.test.ts`

### Nothing left to implement

**§17 is done** — implemented 2026-09-06: `Vibration.restSettle`/`restTail` in `vibration.ts`,
`evaluateTune`'s optional `vibration` parameter and non-scoring `note()` finding in `evaluate.ts`, wired
through `useClosedLoopTuning.ts`'s `evaluateCapture()`. 8 new tests against real fixtures, all passing;
`VIBRATION_FREQ_MATCH` deleted (unreferenced). Do not rebuild any of it.

Two designs were tried and rejected before landing on §17's approach — §17.1 has the measurements, worth
reading before assuming either would work if this area is touched again:
- **§7.4's frequency matching.** The two sensors can't be compared on frequency at these sample rates.
- **§16.4's directional asymmetry.** Recomputed with a metric that isn't broken, it doesn't separate the
  cases; motor hum is directional too.

An earlier §16 also specified a detection-threshold fix. **That was retracted** — it rested on a capture
labelled "idle" whose motor was still energised. §16 explains why the threshold is already correct.

### Background — how §7.4 got here

§7.4 (the evaluate.ts finding) is still not implementable, but the reason has changed from "missing data"
to "the design doesn't work". Four real captures (§16.2) show a ~200 Hz signal that appears whenever the
motor is ENERGISED — present at standstill with the driver merely holding current, and growing with
excitation — and vanishes entirely when the motor is off. It is real motor vibration, not sensor noise
(§16 corrects §15 on that point). A cruise-vs-rest frequency match would therefore match at 200 Hz on
almost any capture from an energised machine, which says nothing about whether that axis has a fault.

**Read §16.3 and §16.4 before touching §7.4.** §16.4 records the better approach — per-axis directional
asymmetry, since motor hum couples into the mount isotropically (measured 1.13–1.23 across axes) while a
real resonance is directional (3.78) — along with the measurements behind it. That is a design decision
plus an API change to `RegionVibration` (which today keeps only the strongest axis), not a threshold to
plug in, and it is unvalidated beyond one sensor on one board. Do not implement §7.4 on the current
invented `VIBRATION_FREQ_MATCH` regardless — that repeats a mistake this plan's own §11 already calls out
(the RP2350 ceiling and the D-ripple gate both waited for real numbers before shipping a gate).

**Read §7.4's audit note before designing it.** 0.15 is narrower than the measurement's own quantisation
at these rates, so a ±15% match test would fire on adjacent frequency buckets by construction. The
recommended design compares the `dominantHzLow`/`dominantHzHigh` intervals for overlap instead, which
needs no invented constant at all.

### Do NOT do these

- Any change to `csv.ts`, `analysis.ts`, `dsp.ts`, or any file listed as already-done above.
- Ship §7.4 on the current `VIBRATION_FREQ_MATCH` (0.15) without a second capture pair to justify it.
- See §11 for the traps, especially: do not fold `dominantLag` into `dsp.ts`'s `autocorrelationPeriod`.
- Report a region's `rmsG` without checking its `samples` first, or a `dominantHz` without its bucket —
  §13's findings 1 and 3 exist because both read as confident answers when there was nothing behind them.

### Verification, once §7.4 is implemented

```
npm test
DWC_DIR="C:/Users/live/Documents/Github/DuetWebControl" npm run typecheck
```
`§7.4` only touches `evaluate.ts` and its test — no `.vue` files, so `verify-build`/`check-ui36`/a 3.6
build aren't needed for that change alone (though re-running them costs little if in doubt).

**Do not commit to `main` and do not push** without being asked — this repo pushes straight to
`origin/main`, so a push is immediately public.

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

1. ~~**Phase 1 — A + C** (§3, §4)~~ — **done.**
2. ~~**Phase 3 — E's pure half** (§7)~~ — **done.**
3. ~~**§12 hardware validation**~~ — **done** for §12.1/12.2/12.4; §12.3/12.5 outstanding but not blocking.
4. **Phase 2 — B + D** (§5, §6). ← **next**, and fully specified.
5. **Phase 3b + 4 — the finding and the UI** (§7.4, §8). 3b still blocked on §12.5; §8 is not yet written
   to the same level of detail as §5 — write that out properly before handing Phase 4 to anyone, the same
   way §5 was expanded from prose to literal code before Phase 2 was handed over.

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

> **The code in this section is the ORIGINAL spec, kept for the reasoning behind it. The audit in
> §13 changed some of it — read §13 before treating any snippet here as current.**

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

## 5. Item B — the combined capture  ✅ READY — shape confirmed on real hardware (§12.1/12.2/12.4)

> **The code in this section is the ORIGINAL spec, kept for the reasoning behind it. The audit in
> §13 changed some of it — read §13 before treating any snippet here as current.**

Extend `captureRaw()` in `useClosedLoopTuning.ts`. Today it builds one M569.5 command with the move
appended; with the accelerometer enabled it must also arm M956 for the *same* move.

**Confirmed shape (§12.1) — one line:**
```
M400 M569.5 P{drv} S{n} A1 R{rate} D{bits} M956 P{accel} S{aN} A0 F"{file}" G1 H2 {axis}{dist} F{feed}
```
Verified on real RP2350 hardware: produces a full closed-loop CSV and a full accelerometer CSV (0
overflows) from one line, no errors. The two-command fallback in the previous draft of this section is no
longer needed — keep it only as a mental fallback if a *different* board/firmware version rejects the
combined form.

**Safety and failure rules — non-negotiable:**
- An accelerometer failure must **never** fail the tuning run (see START HERE).
- `deleteCapturesAfterRead` must cover accelerometer CSVs too, or a run now fills *two* directories.
- `isCancelled()` gates this identically — checked before the capture is issued, so no new gap.

### 5.1 `src/model/m569.ts` — carry a second command on the same line

`buildCaptureCommand` already appends `opts.move`; the M956 must land *between* the M569.5 parameters and
the move, matching the shape verified above. Add one optional field:

```ts
export interface CaptureOptions {
	// … existing fields unchanged …
	/** Another complete command to place on the same line, between the M569.5 parameters and `move`.
	 *  Used to arm an M956 accelerometer capture on the same trigger (docs/PLAN-accelerometer.md §5). */
	alongside?: string;
}
```

and in `buildCaptureCommand`, immediately before the existing `if (opts.move …)` block:

```ts
	if (opts.alongside && opts.alongside.trim()) {
		cmd += ` ${opts.alongside.trim()}`;
	}
```

Test it directly (`m569.test.ts`): with `alongside` set, the M956 text appears after `V0` and **before**
the move; with it unset, the command is byte-for-byte what it is today.

### 5.1a Imports you will need to add to `useClosedLoopTuning.ts`

Verified against the current file — it imports only `analyzeCapture` from `analysis.ts` today, so
`buildSeries`/`segmentMove` are **not** in scope yet and §5.5's code won't compile without this:

```ts
import { analyzeCapture, buildSeries, segmentMove, type StepMetrics } from "../model/analysis";
import { findAccelerometers, buildAccelCaptureCommand, type AccelerometerInfo } from "../model/accelerometer";
import { parseAccelCapture, type AccelCapture } from "../model/accelCsv";
import { computeVibration, type Vibration } from "../model/vibration";
```

`maybeDeleteCapture` is already a module-level export in this same file — no import needed for it.

### 5.2 Accelerometer selection (the §3 wiring, needed here — not Phase 4)

In `useClosedLoopTuning.ts`, next to the existing `selectedBoard` computed:

```ts
const accelerometers = computed(() => findAccelerometers(host.model()));
/** Prefer the tuned driver's own board if it has an accelerometer, else the first available. Confirmed
 *  in the field: the accelerometer is often on a DIFFERENT board from the driver being tuned, so this
 *  must never assume they're the same one. */
const accelerometerBoard = computed<AccelerometerInfo | null>(() => {
	const all = accelerometers.value;
	if (all.length === 0) { return null; }
	const own = selectedBoard.value?.canAddress;
	return all.find((a) => a.boardAddress === own) ?? all[0];
});
/** Off by default: it writes an extra file per capture and most users have no accelerometer. */
const recordVibration = ref(saved.recordVibration ?? false);
const canRecordVibration = computed(() => recordVibration.value && accelerometerBoard.value != null);
```

Persist `recordVibration` exactly like `deleteCapturesAfterRead`: add it to `SavedState`, to
`persistState()`'s serialised object, and to the **first** `watch([...])` array (the one near it, not the
later one — that second array is declared before some of these refs exist).

### 5.3 Waiting for the accelerometer's own run counter

`waitForRuns()` watches `selectedBoard.value?.closedLoop?.runs`, which is the wrong board here. Add a
sibling that watches the accelerometer's board by CAN address:

```ts
/** Like waitForRuns, but for `boards[n].accelerometer.runs` on the accelerometer's OWN board — which
 *  is frequently not the board being tuned. */
async function waitForAccelRuns(boardAddress: number, startRuns: number, timeoutMs: number): Promise<boolean> {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		if (autoCancel.value) { return false; }
		/* eslint-disable @typescript-eslint/no-explicit-any */
		const board = (host.model() as any)?.boards?.find((b: any) => b && b.canAddress === boardAddress);
		const r = board?.accelerometer?.runs;
		if (r != null && r !== startRuns) { return true; }
		await delay(200);
	}
	return false;
}
```

### 5.4 Reading the accelerometer CSV back

The plugin gives M956 an explicit `F"…"` filename, so — unlike the closed-loop path — there is no need to
guess "the newest file". Fetch that exact path:

```ts
const ACCEL_DIR = "0:/sys/accelerometer";

/** Download + parse one accelerometer capture. Returns null on ANY problem — never throws into the
 *  tuning path. */
async function loadAccelCapture(filename: string): Promise<AccelCapture | null> {
	try {
		const text = await host.download(`${ACCEL_DIR}/${filename}`);
		const parsed = parseAccelCapture(text);
		if (parsed.failed) { log("Vibration: the accelerometer reported a failed start — no vibration data for this capture."); return null; }
		if (parsed.rateHz == null) { log("Vibration: no rate in the accelerometer file's trailer — skipping frequency analysis for this capture."); return null; }
		await maybeDeleteCapture(host, `${ACCEL_DIR}/${filename}`, deleteCapturesAfterRead.value);
		return parsed;
	} catch (e) {
		console.warn("[ClosedLoopTuning] loadAccelCapture failed", e);
		log("Vibration: couldn't read the accelerometer capture — continuing without it.");
		return null;
	}
}
```

### 5.5 `captureRaw()` — the actual change

`RawCaptureResult` gains one optional field; everything else in the tuning path ignores it:

```ts
interface RawCaptureResult {
	capture: ParsedCapture;
	rateHz: number;
	/** Present only when vibration recording was on AND the accelerometer capture came back usable. */
	vibration?: Vibration;
}
```

Inside `captureRaw()`, immediately **before** the existing `const c = await runCapture({…})` call:

```ts
		// Arm the accelerometer on the SAME line as the closed-loop capture and the move. Confirmed
		// working on real hardware (§12.1); both captures start together closely enough to share a t=0
		// (§12.2), and running both showed no measurable effect on the closed-loop data (§12.4).
		const accel = canRecordVibration.value ? accelerometerBoard.value : null;
		const accelFile = accel ? `cl-${Date.now()}.csv` : null;
		const accelStartRuns = accel?.runs ?? -1;
		const alongside = accel && accelFile
			? buildAccelCaptureCommand({
				device: `${accel.boardAddress}.0`,
				// Match the closed-loop capture's own window so the two cover the same move. The
				// accelerometer's rate is fixed by its M955 config, not requested here, so this is a
				// sample COUNT chosen to span roughly the same wall-clock time.
				samples: Math.max(1, Math.round(profile.samples * (ACCEL_ASSUMED_RATE_HZ / profile.sampleRateHz))),
				activate: 0,
				filename: accelFile,
			})
			: undefined;
```

then pass `alongside` into the existing `runCapture({ … })` call (one added property, nothing else in
that object changes), and **after** it, before the `return`:

```ts
		let vibration: Vibration | undefined;
		if (c && accel && accelFile) {
			// The closed-loop file is already back by here, so the accelerometer's run counter has almost
			// certainly advanced too — but wait explicitly rather than assume, then read it.
			const ok = await waitForAccelRuns(accel.boardAddress, accelStartRuns, ACCEL_WAIT_MS);
			if (!ok) { log("Vibration: the accelerometer capture didn't finish in time — continuing without it."); }
			else {
				const parsed = await loadAccelCapture(accelFile);
				if (parsed) {
					const series = buildSeries(c, profile.sampleRateHz);
					const seg = series ? segmentMove(series.target, series.time, profile.sampleRateHz) : null;
					if (series && seg) {
						vibration = computeVibration(parsed, series.time, seg.classes);
						log(`Vibration: ${vibration.overall.rmsG.toFixed(3)} g rms overall, ${vibration.cruise.rmsG.toFixed(3)} g cruising, ${vibration.rest.rmsG.toFixed(3)} g at rest`
							+ `${vibration.overall.dominantHz != null ? `, dominant ${vibration.overall.dominantHz.toFixed(0)} Hz` : ""}`
							+ `${parsed.overflows > 0 ? ` (${parsed.overflows} dropped samples)` : ""}.`);
					}
				}
			}
		}
		return c ? { capture: c, rateHz: profile.sampleRateHz, vibration } : null;
```

Two constants near the other capture constants:

```ts
/** The accelerometer's rate is set by its own M955 configuration, not by M956 — the plugin can't request
 *  one. This is only used to size the sample COUNT so the accelerometer window roughly matches the
 *  closed-loop one; the REAL rate is read back from the file's trailer and is what all analysis uses.
 *  Measured on real hardware: 800 Hz (§12.1). Over-requesting is harmless (the file is simply longer). */
const ACCEL_ASSUMED_RATE_HZ = 800;
/** The closed-loop file is already back before we start waiting, so this only covers the tail of the
 *  accelerometer's own write — it does not need to cover the move. */
const ACCEL_WAIT_MS = 8000;
```

---

## 6. Item D — putting both on one time base  ✅ READY — common t=0 confirmed good enough (§12.2)

> **The code in this section is the ORIGINAL spec, kept for the reasoning behind it. The audit in
> §13 changed some of it — read §13 before treating any snippet here as current.**

```
accel time(i)       = i / rateHz     // trailer rate, never assumed
closed-loop time(i)                  // its own Timestamp column, via existing timeAxisSeconds()
```

**v1: assume a common t=0.** Confirmed on real hardware, not just assumed: `computeVibration` (this
plan's own §7.3 code, already implemented) run against a real capture pair puts the vibration RMS drop
(0.50 g → 0.12 g, cruise to rest) at essentially the same instant `segmentMove` independently puts the
end of the commanded move (t=0.384 s) — using nothing but this common-t=0 assumption. No cross-
correlation step needed for v1. Revisit only if a future capture pair shows a variable offset.

**There is no separate code to write for item D.** The correlation lives entirely inside
`computeVibration` (already implemented, §7.3) — it takes the closed-loop capture's own `time` and
`classes` arrays and walks them against `i / rateHz`. §5.5's call site is the whole of item D:

```ts
const series = buildSeries(c, profile.sampleRateHz);
const seg = series ? segmentMove(series.target, series.time, profile.sampleRateHz) : null;
vibration = computeVibration(parsed, series.time, seg.classes);
```

If you find yourself writing alignment logic anywhere else, stop — it belongs in `computeVibration` or
nowhere.

---

## 7. Item E — metrics  ✅ READY (§7.1-7.3) / ⛔ §7.4 BLOCKED

> **The code in this section is the ORIGINAL spec, kept for the reasoning behind it. The audit in
> §13 changed some of it — read §13 before treating any snippet here as current.**

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

**A hard constraint on that calibration, found by the 2026-09-05 audit.** A tolerance of 0.15 is
*narrower than the measurement's own quantisation* at the rates this runs at. `dominantHz` is
`rateHz / lag` for an integer lag ≥ `MIN_LAG`, so on the real 800 Hz fixture the only reachable values
near the answer are 266.7 / 200.0 / 160.0 Hz: the bucket around "200 Hz" is ±13% wide, and nothing above
266.7 Hz is reachable at all (despite a 400 Hz Nyquist limit). A ±15% match test therefore compares two
figures whose own uncertainty is ±13% — it would fire on adjacent buckets by construction and prove
nothing. `RegionVibration` now carries `dominantHzLow`/`dominantHzHigh` for exactly this reason.

So §7.4 must not compare `dominantHz` to `dominantHz` at all. Compare the **buckets**: two regions match
when their `[dominantHzLow, dominantHzHigh]` intervals overlap. That needs no invented constant, and the
second capture pair (§12.5) is then for confirming the detector stays quiet on a machine with no
mechanical signature — its original purpose — rather than for inventing a tolerance. Whichever way it
goes, calibrate against the bucket width at the rate in use, never against the point value.

---

## 8. Item F — UI and report  ✅ DONE

> **The code in this section is the ORIGINAL spec, kept for the reasoning behind it. The audit in
> §13 changed some of it — read §13 before treating any snippet here as current.**

Implemented exactly as follows — recorded here for reference, not as a spec to build from.

**Report wiring, needed before either UI change was useful:** `captureRaw()`'s `RawCaptureResult.vibration`
(Phase 2) only reaches the auto-tune decision loop's `TuneSignal`, not the report — `computeTuneSignal`
has no reason to know about accelerometer data. `TuneSignal` gained an optional `vibration?: Vibration`
field (`signal.ts`), attached post-hoc in `captureSignal()` after `computeTuneSignal` runs — the same
pattern `restEffort`/`pTermSatDuty` already use. `medianSignal` (for `medianOf > 1`) just carries the
first signal's `vibration` through rather than trying to combine N of them — it's a report-only overlay,
never a decision input, so there's no meaningful way to "median" a whole region-split object anyway.
`ReportCapture.metrics: unknown` then carries it through with **no `report.ts` change**, confirmed by a
round-trip test using the real hardware fixture (`report.test.ts`), the same way `restEffort`'s round
trip was proven rather than assumed.

**Settings, in `useClosedLoopTuning.ts`:** `recordVibration` (persisted boolean, off by default) and
`selectedAccelerometerAddress` (persisted `number | null`, re-validated against the live accelerometer
list on every read rather than trusted blindly — a stale saved address just falls back to auto-pick).
`accelerometerBoard`'s computed now prefers an explicit selection, then the driver's own board, then the
first available. A new `accelCapture` ref holds the last raw `AccelCapture` for the chart (`Vibration` is
only the computed summary; a chart needs the actual per-axis series) — cleared to `null` at the start of
every `captureRaw()` so a failed/disabled attempt never leaves a previous run's chart looking current.

**UI, in both `.vue` files** (Advanced tuning options, next to Samples/Rate/E, gated on
`accelerometers.length > 0`): a "Record vibration" checkbox, and — only when more than one accelerometer
is available — a selector bound to `selectedAccelerometerAddress`.

**Chart:** `VibrationChart.vue` (ui37 and ui36, mirroring `CaptureChart.vue`'s own split) — a small,
separate Chart.js instance on the accelerometer's own `i / rateHz` time base, plotting whichever of
X/Y/Z were recorded. Confirmed NOT bolted onto `CaptureChart`'s dataset builder, which only ever reads
columns out of one `ParsedCapture` and has no route to a second time base. Shown in its own row beneath
the main chart, only when `accelCapture` is non-null.

Both `.vue` files' destructure lists stay identical — verified with the diff script (120 names each).

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

**Phase 2 — `m569.test.ts` (extend the existing file):**
- `buildCaptureCommand` with `alongside: 'M956 P121.0 S1000 A0 F"t.csv"'` and a `move` → the M956 text
  appears after `V0` and **before** the move.
- Without `alongside` → the command is byte-for-byte unchanged from today (pin this; it's the regression
  that would silently break every existing capture).

**Phase 2 — integration, using the REAL fixtures now committed** at
`src/__tests__/fixtures/accel-2026-09-05/`:
- `closed-loop.csv` + `accelerometer.csv` (captured together) through
  `parseCapture`/`buildSeries`/`segmentMove`/`parseAccelCapture`/`computeVibration` produce, exactly:
  `valid: true`, `rateHz 800`, `overflows 0`, `cruise.rmsG ≈ 0.501`, `rest.rmsG ≈ 0.125`,
  `overall.dominantHz === 200`, `cruise.samples === 121`, `rest.samples === 692`. These are values the
  implemented code actually produced against this hardware data — treat a mismatch as a regression, not
  as a number to update.
- `closed-loop-baseline-no-accel.csv` (same move, captured *without* the accelerometer) is the §12.4
  control: `tuneStats` on it gives `restRing 0` and `restNoise ≈ 0.035`, statistically indistinguishable
  from the combined run. Worth a test asserting both files agree on `restRing`/`restNoise` — it pins the
  "concurrent capture doesn't degrade the loop" finding so a future change can't quietly break it.

**Phase 3b — blocked:** the §7.4 finding needs a second capture pair (§12.5) before its threshold is
real. Do not write tests that bake in the current invented `VIBRATION_FREQ_MATCH`.

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

## 12. Hardware validation — results

**§12.1 — ANSWERED, yes.** A combined line (`M400 M569.5 ... A1 ... D46 M956 ... A0 ... G1 ...`) produced
two full, error-free files: closed-loop CSV with real `Measured/Target Motor Steps`, `Current Error`,
`PID P Term` (2000 rows, ~1000 Hz), accelerometer CSV (1000 rows, trailer `Rate 800, overflows 0`). No
errors, no dropped samples, on real RP2350 hardware. (An earlier attempt on the same hardware came back
with only `Sample,Timestamp` — the `D` bitmask hadn't reached the driver, most likely dropped when the
command was retyped rather than copy-pasted. Copy-paste the exact line next time to avoid re-diagnosing
this.)

**§12.2 — ANSWERED, yes, with real evidence, not just plausibility.** Ran the actual implemented Phase 1
code (`parseCapture`/`segmentMove`/`parseAccelCapture`/`computeVibration` — not a hand-rolled script)
against the pair above:
- `segmentMove` on the closed-loop capture: move ends at **t = 0.384 s**, matching the raw
  `Target Motor Steps` column directly (stops changing meaningfully at row 384–393).
- The accelerometer's own combined RMS drops from **0.50 g (cruise) to 0.12 g (rest)** at essentially the
  same point in ITS independent timeline — computed assuming nothing more than a common t=0 between the
  two captures, per §6.
That is real, on-hardware confirmation that the two captures start together closely enough for a common
t=0 to be a good v1 assumption — no cross-correlation step needed yet.

**Bonus finding, not asked for but worth flagging:** both regions show a **dominant frequency of exactly
200 Hz** (`cruise` strength 0.79, `rest` strength 0.68 — both well clear of `VIBRATION_MIN_STRENGTH`).
The `rest` region's RMS (0.12 g) sitting well above the ~0.04 g quiet baseline visible later in the same
capture indicates the machine keeps ringing for roughly 100–150 ms after the commanded stop — a direct,
measured instance of exactly the phenomenon `cruiseRing` (docs/PLAN-v2.4-feedback.md §2.3) could only
infer indirectly from encoder data. One capture isn't enough to know if 200 Hz is a real structural mode
or specific to this axis/mount — worth another capture on a different axis to see if it repeats.

**This pair is saved as a fixture** at `src/__tests__/fixtures/accel-2026-09-05/{closed-loop,accelerometer}.csv`
— real, non-synthetic data for the Phase 2/3b integration tests §9 already calls for.

**Still open:**
- **§12.3** (rate/overflows across the range the plugin would actually request) — one clean data point so
  far (800 Hz achieved, 0 overflows); not yet swept.
- **§12.4 — ANSWERED, no evidence of degradation.** The accelerometer is confirmed on a **different
  board** from the closed-loop driver (124.0) — two independent MCUs, ruling out the most severe failure
  mode (one MCU's control loop starved by also running accelerometer sampling) by construction. Then ran
  `tuneStats` (the plugin's own real analysis code) on a closed-loop-only baseline of the identical move
  (same driver, same PID, same `D46`, same `G1 H2 {AXIS}20 F6000`) against the combined-capture run
  already in hand:

  | metric | combined (+M956) | baseline (alone) |
  |---|---|---|
  | `restBias` | 0.0162 | 0.0086 |
  | `restNoise` | 0.0348 | 0.0350 |
  | `restRing` | 0 | 0 |
  | `settleOvershoot` | 0.0100 | 0.0600 |

  The metrics that actually matter for "is the control loop still working correctly" — bias, noise floor,
  ringing — are statistically indistinguishable, and overshoot was *better*, not worse, on the combined
  run. `moveRms`/`movePeak`/rest P-term peak differ by a modest amount (both directions, no consistent
  "combined is always worse" pattern), consistent with ordinary run-to-run mechanical variance rather
  than a systematic effect — though this is N=1 pair, not a proper variance study, so "no red flag" is
  the honest conclusion, not "proven safe". Both files saved as fixtures
  (`closed-loop.csv` / `closed-loop-baseline-no-accel.csv`) for the Phase 2/3b tests.
- **§12.5 — ANSWERED, but not the way it was expected to be.** See §15: the second, deliberately-quiet
  capture pair arrived 2026-09-06 and found a 200 Hz signal at rest even with nothing meaningfully
  exciting the axis — but its per-axis SHAPE looks like sensor/electrical noise, not mechanical vibration,
  unlike §12.2's original capture. **Phase 3b should not be implemented as designed until this is
  resolved** — see §15's recommendation.

---

## 13. Audit, 2026-09-05

Phases 1-4 were audited after implementation. Seven findings, all fixed; the two that mattered were both
**silent wrong answers** — cases where the feature reported a plausible, good-looking number instead of
admitting it had no data. That is the worst failure mode for a diagnostic someone compares across runs,
and it is the thing to keep testing for if this code grows.

**1. A truncated accelerometer capture read as "perfectly still".** M956 takes a sample COUNT, not a
duration, so an accelerometer faster than the count was sized for stops before the move ends. The `rest`
region then came back empty, and empty rendered as `0.000 g at rest` — the best possible result. Measured
on the real fixture: at 0.375 s of coverage `rest.rmsG` read 0.000 g against a true 0.125 g; at 0.5 s it
read 0.324 g, a 2.6× over-report. Fixed three ways: `Vibration.coverage` reports the overlap;
`RegionVibration.samples === 0` is documented as "no data, not a measured zero" and every consumer (log
line and chart) now says "no data" rather than printing 0 g; and `accelSampleCount` sizes the request
against a deliberately-HIGH assumed rate (1600 Hz, since guessing high only lengthens the file while
guessing low loses the move), replaced by the real rate read from the trailer after the first capture.

**2. One malformed cell silently zeroed a whole axis.** `parseAccelCapture` only diverted rows of the
wrong *width*; a right-width row with a blank field (`5,,0.1,0.2`) pushed a `NaN`, which made that axis's
mean `NaN` in `axisSeries`, which zeroed the axis's entire contribution to RMS and peak — with
`valid: true` throughout. Now a row with any non-finite axis value is rejected into `notes` like any
other malformed row, and the run log reports how many were dropped.

**3. `dominantHz` looked far more precise than it is.** See §7.4 above — this is now recorded as a hard
constraint on that sub-item's design, and `dominantHzLow`/`dominantHzHigh`/`maxReportableHz` exist so no
consumer has to guess.

**4. The vibration chart went stale on a manual capture.** The trace was only cleared inside
`captureRaw()`, so a manual Record after a tuning run drew a fresh closed-loop chart beside the previous
run's vibration trace. Clearing now lives in `collectAccel()`, which every path goes through.

**5. "Record vibration" did nothing for manual captures.** Only the wizard/auto-tune path armed M956;
`record()` built its own options and ignored the setting. Both paths now share `armAccel`/`collectAccel`,
and `capturePreview` shows the M956 it will send.

**6. A dead accelerometer cost 8 s per capture, indefinitely.** There was no failure latch, so an offline
accelerometer board added its full timeout to every capture of a run — hundreds of times — while the run
otherwise proceeded normally. `accelDisabledReason` now latches recording off (surfaced in both UIs, and
cleared by toggling the checkbox). A *timeout* latches immediately rather than after N tries, because a
capture that never finished may still hold the accelerometer, and the next M956 shares its line with a
closed-loop capture that must not be put at risk. Read/parse failures get 3 attempts first. Separately,
the file is now deleted before the failure returns, so the repeating-failure case stops accumulating
files on the SD card.

**7. Tidying.** `ACCEL_CAPTURE_DIR` moved to `constants.ts` beside `CAPTURE_DIR`; the never-read
`AccelerometerInfo.orientation` removed (its "null when not reported" contract was wrong anyway — the
object model defaults it to 20); the sizing arithmetic extracted to a pure, tested `accelSampleCount`.

**Checked and found correct, recorded so nobody "fixes" them:**
- `P{board}.0` is right for every board including the main board. DWC's own `useAccelerometer.ts` emits
  a bare `"0"` there, which looks like a bug in this code but isn't: RRF's `ReadDriverIdValue` accepts
  `0.0` on CAN builds and explicitly allows the `"0.x"` form on non-CAN builds.
- `boards[].accelerometer` really is in the DWC 3.6 object model (`@duet3d/objectmodel`'s `Board` wraps
  it, defaulting `null`), so the 3.6 UI does appear. `canAddress: null` means board 0, as DWC treats it.
- Per-region RMS uses the globally mean-removed series. The residual offset in the rest region of the
  real fixture is `-1.4e-4 g` against a rest RMS of `0.125 g` — negligible, not worth per-region means.
- **M956's `A` parameter is parsed and discarded by RRF** (`(void)mode; // TODO implement mode`), so
  collection always starts immediately. The alignment this feature relies on comes from sharing a G-code
  line, which is how §12.2 validated it — not from `A`. Do not start relying on `A` to delay a capture.

---

## 14. Real-hardware failure, 2026-09-06: accelerometer busy → whole tuning capture lost

An auto-tune run with vibration recording on failed to ever get past preflight, with this log:

```
Firmware rejected the capture: Error: M956: Accelerometer 123.0 is busy collecting data
Firmware rejected the capture: Error: M569.5: Closed loop data is already being collected
Preflight: the driver isn't tracking a commanded move — attempting calibration.
Timed out waiting for the capture to finish — is the driver calibrated and in closed loop?
```

**Root cause, confirmed by reading RRF's own line-processing source, not guessed.** `runCapture()` sent
one line containing `M569.5 ... M956 ... G91 G1 H2 ...` and treated ANY `Error:`/`Warning:` text in the
reply as "the whole capture failed." But RRF does not abort the rest of a line when one command on it
errors — `StringParser::SetFinished` advances to the next command regardless of the previous one's result
— so the M956 accelerometer rejection did not stop the M569.5 capture or the move from running. The
plugin discarded a capture that had, in all likelihood, actually succeeded, and — worse — never waited for
that orphaned M569.5 capture to finish, so the retry's own M569.5 collided with it ("Closed loop data is
already being collected"), which is exactly the second line in the log above. Two failures cascaded from
one: an accelerometer problem took the tuning capture down with it, which §11's non-goals explicitly
forbid ("an accelerometer problem must never break a tuning run") — this is that rule being violated in
practice, on real hardware, despite every existing test passing.

**The underlying trigger** was very likely `ACCEL_ASSUMED_RATE_HZ` being biased HIGH (1600 Hz, from the
2026-09-05 audit's finding 1 fix): if the real accelerometer is slower than that, the sample count sized
against 1600 Hz takes proportionally longer to actually collect than the tuning move needs, so it can
still be running when the very next capture attempt tries to arm a new one — precisely the "busy" state
observed. Finding 1's fix (guess high to avoid truncation) traded one silent failure mode for a
session-breaking one; this section corrects that trade.

**Fixes:**

1. **`isAccelOnlyError()`** (`src/model/accelerometer.ts`) — parses the reply for whether every
   `Error:`/`Warning:` segment is attributable to `M956` (RRF prepends the failing sub-command's own name
   to its message via `gb.PrintCommand()`, so `M956: ...` and `M569.5: ...` are never blended). `runCapture()`
   and `record()` now use this: an accel-only rejection marks that capture's `PendingAccel.armFailed`,
   backs off (below), and logs a soft failure — but the tuning capture itself proceeds exactly as if
   nothing had gone wrong, since RRF's own line processing says it did.
2. **`ensureAccelRateKnown()`** — before the first real capture of a session, runs one cheap, short,
   STANDALONE M956 (50 samples) to measure the accelerometer's real rate from its trailer, so every real
   capture afterward is sized from a KNOWN rate via `accelSampleCount`, not a guess. This is the direct
   answer to "calculate the number of samples needed" — after this, guessing only happens if the probe
   itself couldn't complete.
3. **`ACCEL_ASSUMED_RATE_HZ` lowered from 1600 Hz to 800 Hz** — now used only as that rare probe-failure
   fallback, so its risk profile was re-examined: guessing too LOW under-covers the move (handled honestly
   via `coverage`/`samples`, a well-understood failure); guessing too HIGH risks exactly the cascade this
   section describes. With the probe covering the normal case, erring low is now the safer default for the
   fallback.
4. **A 5-second backoff (`accelRetryAfter`) after any accel-only rejection** — without it, a retry
   triggered by an unrelated failure (e.g. "driver isn't tracking a move yet") would immediately re-arm
   M956 while the first attempt's capture might still be genuinely running, hit "busy" again, and repeat
   for the whole retry budget. `armAccel` skips arming (no `alongside`) while backed off.
5. **Soft-failure counting extended to accel-arm rejections** (`noteAccelSoftFailure`, shared with the
   existing read/parse-failure counter) — a few busy rejections in a row are tolerated (a stale capture
   from before this session, or slow real-world timing) before recording latches off with a clear message,
   rather than either silently retrying forever or hard-latching on the very first one-off collision.

**Tests:** `isAccelOnlyError` is covered directly in `accelerometer.test.ts` against the real reply text
from this incident, RRF's exact source wording, a genuine M569.5 failure (must NOT be treated as
accel-only), and mixed-failure lines. `accelSampleCount`'s tests were updated for the new fallback
direction — the "under-covers when the real rate is faster than the fallback guess" case is now an
intentional, documented tradeoff rather than a bug.

**Still not covered by a test:** the composable-level retry/backoff/probe sequencing in
`useClosedLoopTuning.ts` itself (`runCapture`, `record`, `ensureAccelRateKnown`, `armAccel`'s backoff
check) — consistent with the 2026-09-05 audit's finding 7, which already noted no test exercises this
composable's wiring. Extracting `isAccelOnlyError` to a pure, tested function was a small step toward
narrowing that gap for the highest-stakes piece of it; the rest remains a real gap if this area needs
touching again.

---

## 15. §12.5 follow-up, 2026-09-06: a persistent ~200 Hz signal  ⚠️ PARTLY SUPERSEDED BY §16

> **Read §16 first.** This section's measurements are sound, but its central conclusion — that the ~200 Hz
> signal is a sensor/electrical artifact — is **wrong**. It was inferred from a capture labelled "idle"
> whose motor was in fact still energised and vibrating. A genuinely idle capture shows no periodicity at
> all. The 200 Hz is real motor vibration. §16 has the correction and the corrected numbers; what remains
> valid here is the per-axis asymmetry observation, which §16.4 builds on.

A second capture pair arrived, deliberately planned to be quiet: a short (5 mm), slow (F600) move on the
same driver, specifically to check whether the frequency-match detector §7.4 depends on would stay quiet
with nothing much exciting the axis. It didn't stay quiet, and the reason why is more useful than a clean
"no vibration" result would have been.

**What the implemented pipeline reported** (`computeVibration` run against the real files, not by eye):

| | rest region |
|---|---|
| samples | 1185 |
| rmsG | 0.0509 g |
| dominantHz | **200 Hz** (bucket 177.8–228.6 Hz) |
| strength | 0.400 — exactly at `VIBRATION_MIN_STRENGTH` |

Coverage was 1.0 (the accelerometer spanned the whole capture) and the cruise region had only 2 samples
(the move was too short/slow to have a meaningful constant-velocity phase) — so this pair can't test the
cruise-vs-rest MATCH directly, but it answered a more fundamental question first: **is 200 Hz at rest a
real, move-specific signature, or is it there regardless?**

**The same 200 Hz bucket that §12.2's original (genuinely vibrating) capture found is present here too**,
in a capture with an order of magnitude less real excitation (rest RMS 0.051 g here vs 0.125 g there).
Coincidence at n=2 was the first suspicion — MIN_LAG's coarse quantisation at 800 Hz only has a handful of
reachable buckets (266.7/200/160/...), so two unrelated signals landing in the same one isn't shocking on
its own. Per-axis autocorrelation breaks the tie:

```
                        lag 4 (200 Hz) correlation, rest region
                X        Y        Z
ORIGINAL (§12.2, real vibration):   0.70     0.32     0.61   <- clearly directional (X >> Y)
QUIET (this capture):               0.40     0.35     0.40   <- nearly IDENTICAL on all three axes
```

The original capture's 200 Hz is markedly stronger on X than Y — consistent with a real mechanical mode
that has a preferred direction, which is what an actual resonance, a loose belt, or motor cogging would
look like. The quiet capture's 200 Hz is close to identical in magnitude on X, Y, AND Z, and all three
axes also share a matching negative lag-5 dip (-0.31/-0.28/-0.33). Three independently-mounted
accelerometer axes moving in near-lockstep at a specific frequency, with almost no real mechanical
excitation present to drive them, is the signature of a COMMON-MODE artifact — something shared across
all three channels equally (an ADC/decimation ripple internal to the sensor, or electrical
interference/PWM coupling into all three readings alike) — not a direction-specific physical resonance.

**This means §7.4's design, as written, is not safe to implement yet.** A frequency-bucket-overlap check
between cruise and rest would very plausibly fire on this ~200 Hz floor on almost every capture from this
hardware, real vibration or not — which is a worse outcome than not shipping the finding at all: it would
tell a user their machine has a mechanical problem when what actually matched was sensor noise.

**⚠️ The paragraph that used to sit here claimed an idle capture had CONFIRMED the artifact. It did not —
that capture's motor was still energised. See §16 for the correction.** With a genuinely idle machine the
detector reports nothing at all, so the 200 Hz is real motor vibration, not sensor noise, and no code
change is needed.

What survives from this section is the per-axis observation: motor hum couples into the mount
isotropically (max/min 1.13–1.23 across axes) while a real axis resonance is directional (3.78). §16.4
builds the recommendation for §7.4 on that, with a physical explanation rather than the mistaken
artifact one.

Fixtures for this section's captures are listed in §16.6, correctly labelled.

---

## 16. RETRACTED — the "sensor noise floor" was a mislabelled capture

**An earlier version of this section claimed `VIBRATION_MIN_STRENGTH = 0.4` sat below the sensor's own
noise floor and specified a fix raising it to 0.55. That was wrong. There is no defect, and no code change
is needed.** It is left here as a correction rather than deleted, because the reasoning failure is worth
not repeating.

### 16.1 What happened

The §15 analysis rested on a capture labelled "idle". It wasn't — the motor was still energised and
audibly vibrating when it was taken. A genuinely idle capture (motor off) was taken immediately after and
settles it:

| | motor energised, at standstill | **genuinely idle (motor off)** |
|---|---|---|
| overall RMS | 0.0139 g | **0.0029 g** |
| per-axis sd | 0.0072 / 0.0096 / 0.0070 g | **0.0016 / 0.0016 / 0.0017 g** |
| shipped code reports | 200 Hz, strength 0.435 | **`null`, strength 0.000** |
| lag-4 correlation, per axis | 0.354 / 0.393 / 0.435 | **−0.022 / 0.026 / −0.050** |
| strongest local max anywhere | 0.435 @ 200 Hz | **0.098 @ ~1 Hz** (slow drift) |

Both captures are healthy readings of the same sensor in the same orientation (identical means to four
decimals, gravity magnitude 0.9901 g, 38–46 distinct values per axis — live data, not a stuck channel).

**The sensor's true noise floor produces no detectable periodicity at all.** `VIBRATION_MIN_STRENGTH = 0.4`
is correctly positioned: comfortably above the real floor (~0.098, and that at ~1 Hz drift, nowhere near
200 Hz) and below every real signal measured. The shipped v2.6.0 behaviour is right as it stands.

### 16.2 What the 200 Hz actually is

Not a sensor artifact — **real vibration from the energised motor**, present whenever the driver is holding
current, and growing with excitation:

| state | 200 Hz strength | rest RMS | axis spread (max/min) |
|---|---|---|---|
| motor off | none detected | 0.003 g | — |
| motor energised, standstill | 0.435 | 0.014 g | 1.23 (isotropic) |
| quiet move, at rest | 0.400 | 0.051 g | 1.13 (isotropic) |
| vibrating move, at rest | 0.685 | 0.125 g | 3.78 (**directional**) |

That is a coherent physical picture: the closed-loop driver's current regulation makes the motor buzz at a
characteristic ~200 Hz whenever energised, shaking the whole mount fairly evenly in all directions; a real
axis resonance adds energy at the same frequency but with a clear directional preference.

### 16.3 What this means for §7.4 (Phase 3b)

Still blocked, but for a better-understood and more legitimate reason than §15 gave.

The original worry ("the detector fires on sensor noise") is **disproven** — with the machine genuinely
idle, the detector correctly reports nothing. The remaining worry is real but different: a cruise-vs-rest
frequency match would match at 200 Hz because *the motor hums at 200 Hz whenever it is energised*, which is
not the same thing as "this axis has a mechanical fault". A finding built on frequency agreement alone
would therefore fire on almost any capture from an energised machine.

**§16.4's directional-asymmetry approach survives this correction and is strengthened by it.** It now has a
clean physical justification rather than just an empirical one: motor hum couples into the mount
isotropically (measured 1.13–1.23), a real axis resonance is directional (measured 3.78). That is a
distinction worth detecting, and it is exactly what the current single-value `RegionVibration` throws away.

### 16.4 The approach worth taking, if §7.4 is revisited  ⚠️ SUPERSEDED BY §17.1 — DO NOT IMPLEMENT

> This subsection recommended per-axis directional asymmetry as the discriminator, on correlation ratios
> of 1.13–1.23 vs 3.78. **That metric was broken** — a correlation can go negative, making a max/min ratio
> meaningless. Recomputed with per-axis RMS (always positive), directionality does NOT separate the cases:
> 2.98 for real vibration vs 1.99 for the quiet capture, and motor hum is itself directional (1.39),
> because the largest axis is simply the one the motor drives. §17.1 has the full table. §17 uses a
> settle-vs-tail magnitude comparison instead, which does separate cleanly and is self-calibrating.

Expose per-axis results from `regionStats` (today it picks the strongest axis and discards the other two)
and key the finding on the strong/weak axis ratio rather than on frequency agreement. Measured separation:
1.13–1.23 for motor hum vs 3.78 for real vibration — roughly twice as sharp as any absolute strength
threshold, and it needs no per-sensor calibration.

This is an API change to `RegionVibration`, not a threshold tweak. **n=4 captures, one sensor, one board —
promising, not proven.** Do not implement it without more data, and specifically not without at least one
capture from a different machine/mount to check the isotropy claim generalises.

### 16.5 The lesson

Three sections of analysis (§15 and the original §16) were built on one mislabelled input, and the error
survived because every downstream check was internally consistent — the maths was right, the replica
matched the shipped code 6/6, the synthetic tests all passed. None of that could catch a wrong premise.

The one check that would have caught it early: **the energised "idle" capture had 5× the RMS of a truly
still sensor (0.0139 g vs 0.0029 g).** That was visible in the very first analysis and was not questioned,
because the conclusion it pointed to ("something is vibrating") was the thing being assumed away. Sanity
-check the input against physical expectation before building on it — 0.014 g is not what "nothing is
moving" looks like.

### 16.6 Fixtures

All four captures are saved, correctly labelled this time:
- `accel-2026-09-05/{closed-loop,accelerometer}.csv` — the original vibrating pair (§12.2)
- `accel-2026-09-05/closed-loop-baseline-no-accel.csv` — same move, no M956 (§12.4)
- `accel-2026-09-06-quiet/{closed-loop,accelerometer}.csv` — deliberately quiet move
- `accel-2026-09-06-motor-energised/accelerometer.csv` — standstill, motor energised (**not** idle)
- `accel-2026-09-06-idle/accelerometer.csv` — genuinely idle, motor off. No closed-loop counterpart.

---

## 17. Phase 3b, redesigned  ✅ DONE

**Status: implemented 2026-09-06.** Written after the §15/§16 investigation and implemented the same day.
This **replaced §7.4's design entirely** — frequency matching was tested against real data and does not
work (§17.1). What replaced it is simpler, self-calibrating, and needs no cross-sensor comparison.

Every number below came from running the shipped code against the four real captures in §16.6.

### 17.1 Two designs tested and rejected, with the evidence

**Rejected: frequency matching (the original §7.4).** The premise was that if the encoder's ringing
frequency matches the accelerometer's dominant frequency, the ringing is confirmed mechanical. Measured on
the one genuinely-vibrating capture:

```
encoder    oscPeriod 0.00400 s  ->  250.0 Hz
accelerometer  dominantHz 200 Hz  [bucket 177.8 - 228.6 Hz]
```

They disagree, and neither figure is precise enough for the disagreement to mean anything:
- The accelerometer's frequency is coarsely lag-quantised — at 800 Hz the only reachable values near the
  signal are 266.7 / 200 / 160 Hz.
- The encoder's comes from zero-crossings of a sub-step error signal (peak 0.31 of ONE motor step) whose
  half-cycle gaps in that window ranged from 0.001 s to 0.041 s — implying anything from 12 Hz to 521 Hz.
  The single "period" it reports is a mean over wildly inconsistent gaps.

Two sensors, sampling at different rates, cannot be compared on frequency at this resolution. **Do not
revive this approach without much higher sample rates on both sides.**

**Rejected: directional asymmetry (§16.4's own recommendation).** §16.4 proposed using per-axis asymmetry,
based on correlation ratios of 1.13–1.23 (motor hum) vs 3.78 (real vibration). That metric is broken: a
correlation can go negative, making a max/min ratio meaningless — one window produced "0.62", which is
impossible for a ratio of a maximum to a minimum. Recomputed with per-axis **RMS**, which is always
positive and physically meaningful:

| capture | window | X | Y | Z | max/min |
|---|---|---|---|---|---|
| vibrating | settle | 0.1126 | 0.1774 | 0.0595 | 2.98 |
| vibrating | tail | 0.0150 | 0.0313 | 0.0161 | 2.09 |
| quiet | settle | 0.0344 | 0.0575 | 0.0288 | 1.99 |
| quiet | tail | 0.0196 | 0.0245 | 0.0196 | 1.25 |
| motor energised, standstill | whole | 0.0072 | 0.0096 | 0.0070 | 1.39 |
| motor off | whole | 0.0017 | 0.0016 | 0.0017 | 1.05 |

Directionality does **not** separate the cases: 2.98 (real) vs 1.99 (quiet) overlap, and the vibrating
capture's own quiet tail (2.09) scores higher than the quiet capture's active settle (1.99). The reason is
visible in the table — the Y axis is the largest in *every* row, including motor hum at standstill, because
that is simply the axis the motor drives. Hum is directional too. **§16.4 is superseded by this section.**

### 17.2 What does work: the capture's own settled tail as its baseline

Split the at-rest span into the **settle** window (right after the move stops) and the **tail** (once
settled), and compare them. Measured:

| capture | settle RMS | tail RMS | **settle/tail** |
|---|---|---|---|
| vibrating | 0.2184 g | 0.0383 g | **5.70×** |
| quiet | 0.0729 g | 0.0370 g | **1.97×** |

The two tails agree closely (0.0383 vs 0.0370 g) despite completely different moves — that is the same
machine's own settled floor, measured twice, and it is what makes this self-calibrating. No universal g
threshold, no cross-sensor comparison, no per-machine configuration.

**This is also the most valuable thing the accelerometer has shown so far**: on the vibrating capture the
encoder's own `restRing` is **0** — the loop's error signal is too coarse (sub-step) to see the ringing at
all, while the accelerometer measures it at 5.7× the settled level. That is the accelerometer earning its
place: reporting real mechanical behaviour the encoder structurally cannot see.

### 17.3 The API change

`Vibration` needs the at-rest span split. In `src/model/vibration.ts`:

```ts
export interface Vibration {
	overall: RegionVibration;
	cruise: RegionVibration;
	rest: RegionVibration;
	/** The at-rest span split in two, for comparing "just after the move stopped" against "settled".
	 *  `settle` is the first REST_SETTLE_FRACTION of the rest span, `tail` the last REST_TAIL_FRACTION.
	 *  Both are `samples: 0` when the rest span is too short to split meaningfully — check before use,
	 *  same contract as every other region (see RegionVibration.samples). */
	restSettle: RegionVibration;
	restTail: RegionVibration;
	rateHz: number | null;
	overflows: number;
	maxReportableHz: number | null;
	coverage: number;
	valid: boolean;
}

/** First 30% of the at-rest span — where post-move ringing lives if there is any. */
export const REST_SETTLE_FRACTION = 0.30;
/** Last 40% of the at-rest span — the machine's own settled floor, used as this capture's baseline. */
export const REST_TAIL_FRACTION = 0.40;
/** Minimum at-rest samples before the split is meaningful; below this both regions come back empty. */
export const REST_SPLIT_MIN_SAMPLES = 60;
```

`computeVibration` already computes the rest span; add the two sub-spans from it using the existing
`regionStats`. Nothing else in the file changes.

### 17.4 The finding — and how it stays report-only

**`evaluateTune`'s `add()` penalises the score for every finding** (`bad` −34, `warn` −15, `info` −3), so
adding a finding is NOT report-only. This is exactly why §7.4 originally said "append to an existing
finding, never add one". That constraint is sound and must be preserved — but the finding it wanted to
append to (`Rings after stopping`, gated on `restRing > 0`) **does not fire on the one capture where the
accelerometer proves there is real ringing.** Appending is therefore useless here.

Resolve it by adding a non-scoring channel, not by penalising:

```ts
// In evaluateTune, alongside the existing `add`:
/** Adds a finding that does NOT affect the score. For measurements from a sensor OUTSIDE the control
 *  loop — the accelerometer — which must never move an encoder-derived grade. `add` penalises; this
 *  deliberately does not. See docs/PLAN-accelerometer.md §17.4. */
const note = (f: Finding) => { findings.push(f); };
```

Then, gated on vibration being present and usable:

```ts
// Report-only: never changes severity, score, term or direction (docs/PLAN-accelerometer.md §11, §17.4).
if (v?.valid && v.restSettle.samples > 0 && v.restTail.samples > 0 && v.restTail.rmsG > 0) {
	const ratio = v.restSettle.rmsG / v.restTail.rmsG;
	if (ratio >= VIBRATION_RING_RATIO) {
		const alsoEncoder = s.restRing > 0
			? " The encoder sees this too."
			: " The encoder's own error signal is too coarse to show this.";
		note({
			severity: "info",
			title: "Vibration after stopping (accelerometer)",
			detail: `${v.restSettle.rmsG.toFixed(3)} g measured just after the move stopped, `
				+ `${ratio.toFixed(1)}x this machine's own settled level (${v.restTail.rmsG.toFixed(3)} g).`
				+ alsoEncoder,
		});
	}
}
```

`evaluateTune` must accept the `Vibration` — it currently takes `(capture, sampleRateHz)`. Add an optional
third parameter rather than changing the existing signature:

```ts
export function evaluateTune(capture: ParsedCapture, sampleRateHz: number, vibration?: Vibration): TuneEvaluation
```

Only `useClosedLoopTuning.ts`'s evaluation call site passes it; every other caller keeps working unchanged.

```ts
/** settle/tail RMS ratio above which post-move vibration is called out. PROVISIONAL: measured 5.70x on a
 *  real ringing capture and 1.97x on a deliberately quiet one (n=2 — one positive, one negative), so this
 *  sits roughly midway. Report-only, so a wrong call costs a line of text, not a bad tune. */
export const VIBRATION_RING_RATIO = 3.0;
```

### 17.5 Tests

```ts
it("splits the at-rest span and measures the settled tail as its own baseline", () => {
	// Real vibrating fixture — exact measured values, not estimates.
	expect(v.restSettle.rmsG).toBeCloseTo(0.2184, 3);
	expect(v.restTail.rmsG).toBeCloseTo(0.0383, 3);
});

it("reports both regions empty when the rest span is too short to split", () => {
	// Guard against a short capture (see §14's capture-window work) producing a meaningless ratio.
	expect(shortRest.restSettle.samples).toBe(0);
	expect(shortRest.restTail.samples).toBe(0);
});

it("calls out post-move vibration the encoder cannot see", () => {
	const ev = evaluateTune(vibratingCl, 1000, vibration);
	const f = ev.findings.find((x) => x.title === "Vibration after stopping (accelerometer)");
	expect(f).toBeDefined();
	expect(f!.detail).toContain("5.7x");
	expect(f!.detail).toContain("too coarse");   // restRing is 0 on this capture
});

it("does NOT fire on the quiet capture (1.97x, below the ratio)", () => {
	const ev = evaluateTune(quietCl, 1000, quietVibration);
	expect(ev.findings.some((x) => x.title.includes("accelerometer"))).toBe(false);
});

// The safety property this whole design turns on.
it("leaves the score and grade byte-identical whether vibration is supplied or not", () => {
	const without = evaluateTune(vibratingCl, 1000);
	const with_ = evaluateTune(vibratingCl, 1000, vibration);
	expect(with_.score).toBe(without.score);
	expect(with_.grade).toBe(without.grade);
	// …and the only difference in findings is the added informational one.
	expect(with_.findings.length).toBe(without.findings.length + 1);
});
```

### 17.6 Non-goals

- **Do not let this touch the score, grade, `fix`, `term` or `direction`.** The accelerometer is outside
  the control loop; an encoder-derived grade must not move because of it. The test above pins this.
- **Do not revive frequency matching** (§17.1) or **directional asymmetry** (§17.1) without much better
  data than exists — both were tested and rejected on measurements, not opinion.
- **Do not feed vibration into `signalCost` or any tuning decision.** Unchanged from §11.
- **`VIBRATION_FREQ_MATCH` should be deleted in this change.** Verified 2026-09-06: it is referenced
  nowhere in code — only its own definition in `vibration.ts:24`, plus one passing mention in a comment in
  `accelIntegration.test.ts:72`. It exists solely for §7.4's rejected design. Remove the constant and
  reword that comment; leaving an invented, unused threshold behind is how it gets picked up later as if
  it meant something.

### 17.7 Confidence, stated plainly

The mechanism is solid: comparing a capture against its own settled tail is self-calibrating and the two
independent tails agreed to within 4%. The **threshold** is n=2 — one positive (5.70×), one negative
(1.97×). The gap is wide, and the consequence of a wrong call is one informational line of text, which is
why shipping on n=2 is defensible here where it would not be for anything touching a tuning decision.

Revisit `VIBRATION_RING_RATIO` once more captures exist, particularly from a different machine.

### 17.8 Verification

```
npm test
DWC_DIR="C:/Users/live/Documents/Github/DuetWebControl" npm run typecheck
```
No `.vue` changes are strictly required — the finding renders through the existing findings list. If the
UI is touched at all, `verify-build` and `check-ui36` become mandatory.

**Do not commit to `main` and do not push** without being asked.

### 17.9 Implementation note

Built as specified in §17.2-§17.4. Wired into **both** evaluation paths:
- `evaluateCapture()` — the final-verification grading used by auto-tune, which reaches the downloaded
  report via `tuneSession.evaluation`.
- The reactive `evaluation` computed — the live on-screen panel.

> **Corrected after audit.** The first implementation deliberately skipped the reactive computed, on the
> stated grounds that `capture.value` and `lastVibration` could desync because "loading an arbitrary
> capture from a file does not touch `lastVibration`." **That path does not exist.** There is exactly one
> assignment to `capture.value` (`loadLatestCsv`, line ~739), reached from exactly two callers, both
> immediately after this plugin's own M569.5 capture completes — the file even documents that invariant.
> Skipping the computed made the finding invisible in the panel users actually look at, for a risk that
> was never real. `collectAccel` also clears `lastVibration` on entry, so the only transient is a brief
> window where it is null (absent, never mismatched). Both paths now pass it.

11 tests, all against the real fixtures in §16.6 (no synthetic data) — final numbers:
- Settle/tail ratios: 5.70× (vibrating) and 1.97× (quiet), both pinned exactly.
- The two captures' settled tails agreed to within 4% of each other, tested explicitly — the property
  that makes this self-calibrating.
- The short-rest-span guard, `evaluateTune`'s score/grade invariance with vibration supplied vs omitted,
  and the omitted/undefined/invalid-vibration no-throw path.
- **`planCorrections` produces byte-identical output with and without the finding.** It is already
  excluded twice over (no `term`/`direction`, and severity `info` not warn/bad), but nothing else locked
  that in — giving this finding a `term` later (e.g. "which axis is shaking") is a plausible enhancement
  that would otherwise silently start feeding accelerometer data into real PID corrections.
- A degenerate near-zero tail (`VIBRATION_TAIL_MIN_G`) refuses to produce a ratio rather than dividing
  into an enormous spurious one. Not reachable with real hardware — the quietest real tail measured was
  0.0029 g, motor off — but the guard was `> 0`, which only excluded exactly zero.
- The finding survives the report's JSON round-trip with score and grade unchanged.

`npm test`: 487 passed. `DWC_DIR` typecheck: clean. No `.vue` files touched.
