# Plan: accelerometer-based vibration measurement alongside closed-loop tuning

**Status:** planned, not started. Written 2026-09-05 from a user question ("could we use an accelerometer
on the toolhead or motor to measure noise?") after a firmware-source investigation confirmed it's
feasible.

**Audience:** written to be implemented directly. Every firmware claim in §1 was read out of the real
RRF source in this repo's sibling checkout (`RRFBuild/RepRapFirmware`, 3.7.0-beta.1, commit `dc265c5`),
not from memory or documentation. §11 lists what NOT to do. §12 lists what must be answered on real
hardware **before** Phase 1 starts.

**Why this is worth doing:** the plugin currently infers "is this ripple mechanical or is it the control
loop?" indirectly, from encoder data alone — see `cruiseRing` (docs/PLAN-v2.4-feedback.md §2.3), which is
explicitly report-only *because* it's a signature match rather than evidence. An accelerometer measures
the mechanical side directly. It also answers the question the encoder structurally cannot: "is the
machine actually quieter after this tune?" — encoder error is what the loop is *trying* to minimise, so
it's a biased judge of its own work.

---

## 0. Scope

| # | Item | Ready? |
|---|---|---|
| **0** | Hardware validation of the combined capture (§12) — **blocks everything** | **No** — must be done first |
| **A** | Detect an accelerometer, gate the whole feature on it | Yes |
| **B** | Capture accelerometer data on the same move as a closed-loop capture | Yes, pending §0 |
| **C** | Parse the accelerometer CSV (incl. its trailer line) | Yes |
| **D** | Correlate the two streams onto one time base | Yes, pending §0 |
| **E** | Vibration metrics + a "mechanical vs loop" finding | Yes |
| **F** | UI: opt-in toggle, chart overlay, report inclusion | Yes |

**Explicitly deferred (not this plan):** feeding vibration into `signalCost` so the optimiser tunes for
quietness. Same discipline as every previous metric in this repo — measure and report first, gate
decisions on it only once there's calibration data from real machines. See §11.

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
a toolboard, closed-loop driver on an axis board — these are **different MCUs entirely**, so there is no
contention to reason about at all.

**1.3 The object model advertises an accelerometer the same way it advertises closed loop.**
`src/CAN/ExpansionManager.cpp:47-49`:
```
boards[n].accelerometer   present only if hasAccelerometer   → { orientation, points, runs }
boards[n].closedLoop      present only if hasClosedLoop      → { points, runs }
```
`accelerometerRuns` is incremented on completion (`ExpansionManager.cpp:485-488`) — the exact analogue
of `closedLoop.runs`, which this plugin already watches for capture completion
(`useClosedLoopTuning.ts`'s `waitForRuns()` and the `record()` watcher). **The completion-detection
pattern is already built; it just needs pointing at a second field.**

**1.4 The accelerometer CSV is NOT shaped like the closed-loop CSV.** From
`Accelerometers.cpp:150-200`:
- Header: `Sample,X,Y,Z` (only the axes requested) — **no `Timestamp` column.**
- Rows: `<index>,<x>,<y>,<z>`, values in **g** as floats.
- **Trailer line: `Rate <actual>, overflows <n>`** — the *achieved* rate and a dropped-data count.
- On failure the file instead contains `Failed to start accelerometer`.

Two consequences, both important:
- The trailer is a non-data line. `parseCapture` already skips lines whose cell count doesn't match the
  header and records them in `notes` (the v2.4.0 `Data lost` fix), so it degrades safely — but the
  trailer carries the **authoritative sample rate**, which is the only way to build a time axis for a
  file with no timestamps. It must be parsed, not just skipped.
- `overflows > 0` is a data-quality signal that should be surfaced, not silently ignored.

**1.5 Command + move on one line is the established pattern.** DWC's own InputShaping plugin does
exactly this (`DuetWebControl/src/plugins/InputShaping/RecordMotionProfileDialog.vue:560`):
```
M400 M956 P{accel} S{samples} A0 F"{file}" G1 {move} F{speed}
```
This plugin already appends its move to the M569.5 line the same way (`buildCaptureCommand`'s
`opts.move`). Note InputShaping uses `A0` (immediate), not `A1` (on next move), and prefixes `M400`.

---

## 2. Implementation order

0. **§12 hardware validation** — by hand, no code. Blocks everything below.
1. **A + C** — detection and the parser. Pure, unit-testable, no machine interaction.
2. **B + D** — the combined capture and time-base correlation.
3. **E** — metrics and the finding.
4. **F** — UI and report.

Phases 1 and 3 are pure model code and can be written/tested without hardware. Phase 2 is the only part
that needs a machine, and §12 determines its shape.

---

## 3. Item A — detection and gating

New in `src/model/m569.ts` (or a small new `accelerometer.ts` — implementer's call, but keep it pure):

```ts
/** The board's accelerometer, if the object model advertises one (boards[n].accelerometer is present
 *  only when the board actually has one — see ExpansionManager.cpp:47). */
export interface AccelerometerInfo { boardAddress: number; orientation: number | null; runs: number; }
export function findAccelerometers(model: unknown): Array<AccelerometerInfo>;
```

In `useClosedLoopTuning.ts`, mirroring the existing `drivers`/`selectedBoard` computeds:
- `accelerometers` — every board advertising one.
- `accelerometerBoard` — the one to use. **Default to the selected driver's own board if it has one,
  otherwise the first available.** A toolhead accelerometer will usually be a *different* board from the
  axis driver being tuned, so this must not assume they're the same board.
- The whole feature is hidden when `accelerometers.length === 0`. It is never required.

---

## 4. Item C — parsing the accelerometer CSV

New `src/model/accelCsv.ts` (separate from `csv.ts`: different shape, different trailer semantics, and
`csv.ts`'s contract is deliberately narrow):

```ts
export interface AccelCapture {
	/** Per-axis series, in g. Only the axes actually recorded are present. */
	axes: { x?: Array<number>; y?: Array<number>; z?: Array<number> };
	rowCount: number;
	/** Achieved rate from the trailer line — authoritative, and the ONLY way to build a time axis
	 *  (this CSV has no timestamp column). Null when the trailer was missing/unparseable. */
	rateHz: number | null;
	/** Dropped-sample count from the trailer. > 0 means the data has gaps. */
	overflows: number;
	/** True when the file says "Failed to start accelerometer" instead of holding data. */
	failed: boolean;
	notes: Array<string>;
}
export function parseAccelCapture(text: string): AccelCapture;
```

Parsing rules (all verified against `Accelerometers.cpp:150-215`):
- Trailer regex: `/^Rate\s+(\d+),\s*overflows\s+(\d+)/i` → `rateHz`, `overflows`.
- `/failed to start accelerometer/i` → `failed = true`.
- Any other non-matching line → `notes`, never parsed as data (same discipline as `parseCapture`).
- **`rateHz === null` must degrade to "can't build a time axis", never to a guessed rate.** A wrong rate
  silently corrupts every frequency result downstream — the same class of bug as the clamped-rate/
  analysis mismatch fixed in the sample-rate ceiling work.

---

## 5. Item B — the combined capture

Extend `captureRaw()` in `useClosedLoopTuning.ts`. Today it builds one M569.5 command with the move
appended. With the accelerometer enabled it must additionally arm M956 for the *same* move.

**Exact command shape depends on §12's answer.** Two candidate shapes, in preference order:

1. **One line** (preferred if §12.1 confirms it works):
   `M400 M569.5 P{drv} S{n} A1 R{rate} D{bits} M956 P{accel} S{aN} A0 F"{file}" G1 H2 {axis}{dist} F{feed}`
2. **Two commands, move on the second** (fallback): arm M569.5 with `A1` (on next move), then send
   `M400 M956 ... G1 ...` as InputShaping does. M569.5's `A1` fires on the move the M956 line carries.

Completion detection: watch **both** `closedLoop.runs` **and** `accelerometer.runs` on their respective
boards, reusing `waitForRuns()`'s existing shape. Both must advance before reading the files. The
accelerometer file lives in `0:/sys/accelerometer/` (`Accelerometers.cpp:452`), listed and downloaded
with the same `getFileList`/`download` host calls already used for `0:/sys/closed-loop/`.

**Safety and failure rules — non-negotiable:**
- An accelerometer failure must **never** fail the tuning run. No accelerometer, a failed start,
  a missing trailer, a mismatched sample count: log it, drop the vibration data for that attempt, carry
  on with the closed-loop capture exactly as today. This is a diagnostic overlay, not a dependency.
- The existing `deleteCapturesAfterRead` setting must cover accelerometer CSVs too, or an auto-tune run
  now leaves *two* directories filling with files instead of one.
- `isCancelled()` (emergency stop / lost connection / abort) gates this identically — it is checked
  before the capture is issued, so no new gap is introduced.

---

## 6. Item D — putting both on one time base

The closed-loop CSV has real timestamps; the accelerometer CSV has an index and a trailer rate. So:

```
accel time(i) = i / rateHz          // rateHz from the trailer, never assumed
closed-loop time(i)                 // from its own Timestamp column (timeAxisSeconds, already exists)
```

Both start from the same physical trigger **only if** §12.1 confirms both arm off the same move. Even
then, expect a small constant offset (arming order, firmware latency). Options, cheapest first:
- **v1: assume a common t=0 and report the caveat.** Adequate for "how much vibration, at what
  frequency" — neither is offset-sensitive.
- **Later, only if needed:** cross-correlate the accelerometer magnitude against the commanded
  acceleration profile (which the closed-loop capture already segments via `segmentMove`) to recover the
  offset. Do not build this speculatively.

`segmentMove`'s existing accel/cruise/rest classification is derived from the closed-loop capture and,
once both are on a shared time base, maps directly onto the accelerometer samples — which is what makes
"vibration during cruise vs at rest" computable without any new segmentation logic.

---

## 7. Item E — metrics

New `computeVibration(accel: AccelCapture, seg, sampleRate)` in a new `src/model/vibration.ts`:

| Metric | Why |
|---|---|
| `rmsG` overall, and per region (accel / cruise / rest) | "Is the machine actually quieter?" — the question encoder error structurally cannot answer |
| `peakG` | Transient severity at the stop |
| `dominantHz` per region + strength | The mechanical-vs-loop discriminator |
| `overflows`, `rateHz`, `valid` | Data quality; `valid: false` must skip every consumer, never fail one |

**Use the existing `autocorrelationPeriod` from `src/model/dsp.ts` for `dominantHz` — do not add an FFT
or a Web Worker.** That module's own docstring documents the benchmark and the decision: O(n²)
autocorrelation over a few hundred lags is low-single-digit milliseconds, negligible against a
multi-second physical move, and a worker costs bundle size and plumbing for no perceptible gain. The
same reasoning applies unchanged here.

**The finding (`evaluate.ts`), report-only:** when the existing `restRing`/`cruiseRing` signature says
"possibly mechanical" *and* the accelerometer shows a matching `dominantHz` present in both cruise and
rest, upgrade the existing "Rings after stopping" detail from a hedge to a statement — it stops being an
inference and becomes a measurement. Follow §2.3's rules exactly: **append to the existing finding's
detail, never add a finding, never change severity, score, term or direction.**

---

## 8. Item F — UI and report

- **Advanced tuning options** (where Samples/Rate/E now live): a "Record vibration" checkbox plus an
  accelerometer selector, both rendered only when `accelerometers.length > 0`. Persist with the other
  settings (`SavedState` + `persistState` + the `watch` list).
- **Chart:** the accelerometer series is a *different capture* with its own time base, so it cannot just
  become another `CAPTURE_VARIABLES` entry (those all read columns out of one `ParsedCapture`). Simplest
  honest option for v1: a separate small chart beneath the main one, sharing the x-axis range. Do not
  bolt a second time base onto `CaptureChart`'s existing dataset builder.
- **Report:** add the vibration metrics to the per-capture record. `ReportCapture.metrics` is typed
  `unknown` and carries whole objects, so fields flow through with no `report.ts` change — verify that
  with a round-trip test rather than assuming (this is exactly how the `restEffort` fields were added).

Both `.vue` files get markup only. Their destructure lists must stay identical — check with the diff
script used throughout this repo's UI work.

---

## 9. Test plan

**C** — `accelCsv.test.ts`: a real fixture with the trailer parses to the right `rateHz`/`overflows`; a
`Failed to start accelerometer` file sets `failed` and yields no data; a truncated/garbled trailer gives
`rateHz: null` (and **not** a guessed default); axis subsets (X only, XZ) parse correctly.

**E** — `vibration.test.ts`: a synthetic 50 Hz sine at a known rate returns `dominantHz ≈ 50`; white
noise returns no confident dominant frequency; `rateHz: null` gives `valid: false`; per-region RMS
splits correctly against a hand-built `segmentMove` result.

**Integration** — a captured pair (one closed-loop CSV + one accelerometer CSV from the same move, from
§12) as fixtures: the correlation produces sane, aligned regions, and the evaluate.ts finding upgrades
only when both signals agree.

**Regression** — with the feature off, every existing capture path is byte-for-byte unchanged. With an
accelerometer that fails mid-run, the tuning run still completes normally.

---

## 10. Verification checklist

- [ ] `npm test` — all existing pass, plus new
- [ ] `DWC_DIR=<3.7> npm run typecheck` and `npm run verify-build`
- [ ] `DWC36_DIR=<3.6> npm run check-ui36` **and** a real 3.6 webpack build (`.vue` files change)
- [ ] Hardware: a tuning run with vibration recording produces two aligned captures; a run with the
      accelerometer unplugged mid-way completes normally with the vibration data simply absent

---

## 11. Explicit non-goals — do NOT do these

- **Do not feed vibration into `signalCost` or any accept/reject decision.** Report-only for v1, exactly
  as the D-term ripple and `cruiseRing` items were. Gate decisions on it only with calibration data from
  more than one machine.
- **Do not make the tuning run depend on the accelerometer in any way.** Every failure mode is "log it
  and carry on with the tune".
- **Do not add an FFT library or a Web Worker.** Reuse `dsp.ts`'s autocorrelation (§7).
- **Do not guess a sample rate when the trailer is missing.** `rateHz: null` → skip, never substitute.
- **Do not assume the accelerometer is on the driver's own board.** Toolhead-mounted is the common case.
- **Do not extend `CaptureChart`'s dataset builder to a second time base** (§8).
- **Do not touch M955.** Wiring, orientation and pins are config.g's job; this plugin only reads whether
  an accelerometer exists and uses M956.

---

## 12. Hardware questions that block Phase 1

These cannot be answered from source — they need a machine with both a closed-loop driver and an
accelerometer. Each is a few minutes at the console.

1. **Does a combined line work?** Send §5's shape 1 by hand. Do *both* `closedLoop.runs` and
   `accelerometer.runs` advance, and do both files contain a full move's worth of data? If not, does
   shape 2 (two commands, move on the M956 line) work?
2. **Do they actually start together?** Run a move with a sharp, unambiguous acceleration transient.
   Does the accelerometer's transient land at the same relative time as the closed-loop capture's accel
   region? A constant offset is fine (§6); a variable one changes the design.
3. **What rate does the trailer report** at the rates the plugin would ask for, and does `overflows`
   stay 0? This also tells us whether the combined capture stresses either board.
4. **Does either capture degrade the other?** Compare a closed-loop capture taken alone against one
   taken alongside an accelerometer capture — same tune, same move. If the closed-loop data gets worse,
   that decides the whole feature's viability, and it is much better to find out now than in Phase 2.

Answer 1 and 2 and the design is settled. Answer 3 and 4 and we know whether it's worth building at all.
