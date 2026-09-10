# Plan: 2026-09-10 field feedback — implementer handoff

Five reports (2026-09-10, same Y motor, CoreXY, driver 50.0, mostly 200 mm F18000 = 300 mm/s, 3 cycles).

**This document was rewritten after an audit of its own first draft.** Three findings changed it
materially — see "Corrections to the first draft" below before reading anything else. If you saw the
earlier version, discard it.

---

## START HERE

### Already done, do not redo

Two items from this feedback were v2.6.3 regressions, **fixed and released in v2.6.4** (commit
`e29c3c2`):
- Envelope check ran at 60x the intended feed (`move.axes[].speed` is mm/min, not mm/s).
- `dwc-page-fill` crushed the page layout — fully reverted to the v2.6.2 layout.

### Corrections to the first draft of this plan — read these first

1. **M569.5 *does* accept `F"filename"`.** The first draft said it didn't and sent the design toward
   snapshot-diffing directory listings. Wrong. RRF `src/ClosedLoop/ClosedLoop.cpp:168`:
   ```cpp
   if (gb.Seen('F')) { gb.GetQuotedString(tempFilename.GetRef(), false); }
   else { /* Create default filename as none was provided */ }
   ...
   MassStorage::CombineName(closedLoopFileName.GetRef(), "0:/sys/closed-loop/", tempFilename.c_str());
   ```
   A **bare** filename is combined with `0:/sys/closed-loop/` — which is exactly this plugin's
   `CAPTURE_DIR` (`src/model/constants.ts:18`). So §4 below is a small, well-precedented change, not a
   rework: **this plugin already does exactly this for the accelerometer** (`buildAccelCaptureCommand`
   appends `F"${opts.filename}"`, and `loadAccelCapture(pending.file)` downloads that path directly).
   Copy that pattern.

2. **`evaluateTune` has no access to P**, so the first draft's `rippleSteps ≈ pTermRestRipple / P` is not
   computable where the check lives. Signature is
   `evaluateTune(capture, sampleRateHz, vibration?)` (`evaluate.ts:235`) — no `PidConfig`. **Do not thread
   P in.** §2 below uses the position-error column directly instead, which needs no P at all and is a
   better measurement anyway.

3. **`pTermRestRms` already exists** (`RestEffort`, `analysis.ts`). The first draft implied RMS needed
   adding. It doesn't; only a *position-error* ripple field does.

### Also found during the audit — a real bug in shipped code

**The envelope check can report "holds at the machine's configured max" without ever reaching that
speed.** See §5. This is a false reassurance and is arguably worse than not checking. It is not a
regression from v2.6.4 — v2.6.4 fixed the feed *number*; this is about whether the move physically
achieves it.

### Do NOT do these

- **Do not thread `PidConfig` into `evaluateTune`.** See correction 2.
- **Do not add automatic sample-rate reduction.** The plugin does not auto-reduce the rate today — the
  "sample rate may be too high" line (`useClosedLoopTuning.ts:935`) is advisory only. The tester's point
  is a *guard for the future*: if rate reduction is ever added, gate it on RRF's real overrun signal
  (`Data lost` / buffer overflow, which `parseCapture` already detects as `capture.truncated`), never on
  a failed file read. Nothing to implement now.
- **Do not implement automatic tuning-speed selection.** The tester explicitly deferred it: *"I do not
  think this should be a priority right now."* Sketch kept in §6 for later.
- **Do not touch the `dwc-page-fill` layout again.** It was reverted for cause. Any future viewport work
  on this page needs its own design — it is a wizard plus a chart, not a single card.

### Verification (every section)

```
npm test
npx vitest run --typecheck                              # covers src/__tests__/, the others do not
DWC_DIR=<real DWC 3.7 checkout> npm run typecheck
```
Sections that touch `.vue` (only §1) additionally need:
```
DWC_DIR=<3.7> npm run verify-build
DWC36_DIR=<real DWC 3.6 checkout> node scripts/check-ui36.mjs
```
Known-good local paths: `DWC_DIR=c:/Users/live/Documents/Github/DuetWebControl`,
`DWC36_DIR=c:/Users/live/Documents/Github/DuetWebControl-3.6-dev`.

### Suggested order

§1 → §2 → §3 (§3 depends on §2). §4 and §5 are independent of all of the above and of each other.

---

## 1. Persistent "tuning move too aggressive" warning in the evaluation panel

Tester: *"it would already help a lot if the right-hand evaluation panel showed a persistent warning
when the tuning move is too aggressive… much easier to notice than having the warning only in the
scrolling console."*

### Why it matters (evidence)

Two of the five reports ran at F24000 (400 mm/s). In both, P=30's accel P-term read 222 and 224 — the
v2.6.3 confirmation re-measured and **agreed with itself**, so it correctly confirmed a rail at the seed
and backed off to P\*=19.5 (final P 16.46 and 24.38). The confirmation fix stops a *noisy one-off*
reading; it cannot help when the move is genuinely too aggressive for P=30 to have headroom. The three
300 mm/s runs all reached P=340.95. So the user-facing fix is to tell them the feed is too high.

### Already half-built

`identifyModelFitP` already detects this exact case and logs it (`modelfit.ts`, inside `railAt`):
> `Model fit: that rail is at the seed P=30, so P*=19.5 is 65% of the seed rather than anything measured
> about this axis — the tuning move is likely too aggressive for it (try a lower feedrate).`

It only needs surfacing. The condition is exactly `basis === "rail" && pRailOnset === SEED_START`.

### Implementation

1. `ModelFitPResult` already carries `basis` and `pRailOnset` — no change needed there.
2. `runModelFitIdentification` returns the fit; propagate a boolean up to `runAutoTune`.
3. `AutoRunResult` gains `identifiedAtSeed?: boolean` — mirror `ku` / `tu` / `envelopeCheck` exactly
   (declare beside them in `autorun.ts`, set in the success return).
4. `TuneSession` gains the same field (`useClosedLoopTuning.ts`, beside `ku`/`tu`/`envelopeCheck`), and
   the `finally` block copies it: `tuneSession.value.identifiedAtSeed = result?.identifiedAtSeed;`
   (right next to the existing `envelopeCheck` line). The downloadable report picks it up automatically
   — `downloadTuningReport` spreads the whole session object.
5. A card in the results column of **both** `ui37/ClosedLoopTuning.vue` and
   `ui36/ClosedLoopTuningPage.vue`, immediately after the envelope-check card, written in each file's
   own Vuetify idiom (ui37: `variant`/`size`/`density`; ui36: `outlined`/`dense`/`x-small` — do not mix
   them; copy the envelope-check card in each file as the template).

Wording (both UIs):
> **Tuning move too aggressive** — P identification may be unreliable. The P ramp hit its effort limit
> at the very first step, so the result comes from the starting value rather than a measurement of this
> axis. Try a lower Feed (mm/min) above and re-run.

Severity styling: `warning`, same treatment the envelope-check card uses for its non-holding state.

### Tests (`src/__tests__/autorun.test.ts`)

- A run whose model-fit rails at `SEED_START` → `result.identifiedAtSeed === true`.
- A run that rails later in the ramp (e.g. P=214.85) → `identifiedAtSeed` falsy.
- A run that never rails (extrapolated / best-measured basis) → falsy.

---

## 2. Quantisation-aware standstill-dither threshold

### The tester's arithmetic, verified

`REST_EFFORT_RIPPLE_LIMIT = 10` (`analysis.ts:440`) is a **fixed** P-term peak-to-peak threshold. Used at
`evaluate.ts:274`: `re.restTailValid && re.pTermRestRipple > REST_EFFORT_RIPPLE_LIMIT` → "Dithers at
standstill", a **scoring** `warn` (−15).

The P term is `P × positionError`. Tester's machine: 1000 PPR quadrature = 4000 counts/rev, 200
full-steps/rev → **0.05 step/count**. At P=340.95, one encoder count moves the P term by
`340.95 × 0.05 ≈ 17`. So the fixed limit of 10 is **~0.6 encoder counts** — below one quantisation step.
A reported ripple of 34.1 is **~2 counts** (≈0.10 step) peak-to-peak.

Consequence, straight from the reports: one 85-point run has ~0.044 step RMS tracking; the 100-point run
has ~0.060 step RMS. **The better-tracking run scored worse**, purely because its final capture happened
to catch a 2-count flutter. The threshold is meaningless at high P.

### Fix — measure position error directly, no P needed

The capture always records **"Current Error"** (position error, steps): `ALL_CAPTURE_KEYS` is every
non-derived variable (`useClosedLoopTuning.ts:893`) and the capture command sends `D65535` (all filter
bits). `computeRestEffort` already isolates the settled rest tail and already reads columns by name.

1. In `computeRestEffort` (`analysis.ts`), add to `RestEffort`:
   ```ts
   /** Peak-to-peak POSITION error (steps) over the same settled tail. The dither threshold is judged
    *  here, not on the P term: the P term is P x error, so a fixed P-term limit means a different
    *  real movement at every P (at P=340 the old fixed 10 was ~0.6 encoder counts — below one
    *  quantisation step, so any standstill motion at all tripped it). 0 when not recorded. */
   errorRestRipple: number;
   /** RMS about the mean of the same signal — companion to p2p, see the finding logic. */
   errorRestRms: number;
   ```
   Populate from `column(capture, "Current Error")` using the existing `tailOf` / `peakToPeak` /
   `rmsAboutMean` helpers. Add both to `EMPTY_REST_EFFORT` as `0`.

2. In `evaluate.ts`, replace the fixed-limit test. The comparison basis is the machine's own measured
   noise floor, which `tuneStats` already computes as `s.restNoiseFull` (documented as "the machine's
   actual encoder noise floor"):
   ```ts
   // A dither only counts when the POSITION actually moves meaningfully more than this machine's own
   // measured noise floor. A one-or-two-encoder-count flutter is quantisation, not a limit cycle.
   const dithers = re.restTailValid
       && re.errorRestRipple > Math.max(DITHER_FLOOR_STEPS, DITHER_NOISE_MULTIPLE * s.restNoiseFull);
   ```
   Suggested constants (both exported, both documented with this reasoning):
   - `DITHER_NOISE_MULTIPLE = 6` — `restNoiseFull` is a std-dev, so ~6 sigma peak-to-peak is roughly
     "clearly outside the noise band".
   - `DITHER_FLOOR_STEPS = 0.15` — an absolute floor so a machine reporting an implausibly tiny noise
     floor can't make everything a dither. ~3 encoder counts on the tester's 0.05 step/count machine.

   **These two numbers are the judgement call in this section.** Calibrate them against the attached
   reports before settling: the 100-point run must not gain the finding, and the two 85-point runs
   should lose it *only if* their ripple really is within the noise band. Read `errorRestRipple` out of
   the reports' embedded CSVs and check, rather than assuming — if a run genuinely dithers, it should
   still be reported.

3. Keep the P-term numbers in the finding's `detail` text (they are what the user hears as buzz) but
   drive the *decision* off position. Suggested detail:
   `Position error is only ${b} step from target, but it swings ${re.errorRestRipple.toFixed(3)} step
   (P term ${re.pTermRestRipple.toFixed(1)}) at rest — the motor is working to hold position, audible as
   buzz or hum.`

4. `REST_EFFORT_RIPPLE_LIMIT` becomes unused by the finding. **Check every other reference before
   deleting it** — `signal.ts` uses `pTermRestRipple` for `effortCost` (normalised to `P_TERM_RAIL`,
   a *different* mechanism); leave that alone unless a test proves it has the same flaw. If the constant
   ends up unreferenced, delete it and its doc comment rather than leaving a dead export.

### Tests (`src/__tests__/evaluate.test.ts` and/or `analysis.test.ts`)

- A synthetic rest tail with a 2-encoder-count flutter at high P → **no** dither finding (the regression
  this section exists for).
- A synthetic rest tail with a large, sustained position limit cycle → dither finding still raised.
- `restTailValid: false` → never a finding, unchanged.
- `errorRestRipple` / `errorRestRms` populated correctly, and `0` when the column is absent.
- A capture with no "Current Error" column must not crash and must not produce a false finding.

---

## 3. I-stage: intermittent standstill dither

**Depends on §2** — do it after, so "dither" means a real limit cycle rather than encoder flutter.

### Evidence

Same axis, same profile, three runs:

| medianOf | result | grade |
|---|---|---|
| 1 | P340.95 / **I0** / D0 / V770 / A131250 | 85 |
| 3 | P340.95 / **I1000** / D0 / V742 / A150000 | **100** |
| 3 | P340.95 / **I0** / D0 / V731 / A150000 | 85 |

Tester: *"One I=0 capture can look completely settled, so I=0 gets accepted, but the final verification
can later detect the dither and recommend raising I. A normal median alone may not be enough when the
behaviour only appears on some captures."*

Confirmed in code: the I stage accepts via `verifyAccepted` (`autorun.ts:330`, `:617`), which re-captures
once and only retries when the result is **unstable** — and dither does not meet `signalUnstable`'s bar
(`signal.ts:196`: sat duty / hunt / hard ring / runaway). A median of N cannot reliably catch a
behaviour that appears on a minority of captures.

### Implementation — confirm an accepted low I

In the I stage only, when the accepted value is at or near zero, take extra confirmation captures and
reject the acceptance if **any** of them shows a (§2-definition) dither.

- Add a small helper next to `verifyAccepted` in `tuneShared.ts`, e.g.
  `confirmNoDither(effects, medianOf, tries)`, that captures `tries` times and returns true only if no
  capture shows dither. "Shows dither" must use the **same** rule as §2 — export a predicate from
  `evaluate.ts`/`analysis.ts` and call it from both places rather than duplicating the threshold logic.
- Wire it into the I stage's acceptance path. If confirmation fails, do not accept 0 — step I up to the
  strategy's next candidate and continue the search rather than failing the run.
- Gate it so it costs captures only in the unreliable case: accepted I ≤ some small threshold (I=0 is
  the observed failure; treat "≈0" generously). Log clearly when the extra captures are spent and what
  they found, matching the house style of the model-fit confirmation logging.
- `TuneSignal` already carries `restEffort`, so the dither predicate can run on a captured signal
  without re-reading the CSV.

### The alternative, if this is not enough

Have `runFinalVerification` **reopen the I stage** when its evaluation contains the dither finding, even
when the grade is otherwise acceptable. It already runs one bounded correction pass below "good"
(`autorun.ts:770`), but that plans a single step, not a re-search. This is a bigger change to the
verification flow — do it only if the confirmation approach above proves insufficient in the field.

### Tests (`src/__tests__/autorun.test.ts`)

- I stage where every capture is clean → I=0 accepted, no extra captures spent (assert capture count).
- I stage where 1 of N confirmation captures dithers → I=0 **not** accepted, search continues upward.
- Confirmation captures failing outright (null) → run does not crash, does not silently accept.

---

## 4. Explicit capture filenames — kill the `rr_filelist` walk and the per-capture delete

This is the highest-value reliability item and, per correction 1, a small change.

### Evidence

Truncated captures and retries across the five runs: **4, 7, 13, 18, 39**. The tester's browser console
shows repeated `rr_filelist … 503 Service Unavailable`, and reports that **"Delete captures after read"
makes the 503 problem much worse** — with auto-delete disabled the errors are much rarer.

### The mechanism, confirmed in code

`loadLatestCsv()` (`useClosedLoopTuning.ts:765`):
```ts
const list = await host.getFileList(CAPTURE_DIR);          // rr_filelist — 503s here
const files = list.filter(...).sort(by mtime desc);
const path = `${CAPTURE_DIR}/${files[0].name}`;            // "newest file IS ours" — a heuristic
const text = await host.download(path);
...
await maybeDeleteCapture(host, path, deleteCapturesAfterRead.value);   // a delete per capture
} catch { return null; }                                    // ANY failure -> null
```
`runCapture` returns that `null`, and `captureMedian` treats it as "capture failed" and **retries the
whole physical move + M569.5**. So a transient 503 on the *file list* discards a closed-loop capture that
already completed (the run counter had incremented) and re-runs the move.

### Fix

1. **Name every capture.** Add `filename?: string` to `buildCaptureCommand`'s options in `m569.ts` and
   append `F"${filename}"` — exactly as `buildAccelCaptureCommand` already does. A bare name is what RRF
   combines with `0:/sys/closed-loop/`; do **not** send a full path.
   Use a per-run, per-capture unique name (e.g. `clt-<runId>-<seq>.csv`). Keep it well inside RRF's
   `StringLength50` for the F parameter.
2. **Download it directly.** Replace the list+sort in the auto-tune path with
   `host.download(`${CAPTURE_DIR}/${name}`)`. No `rr_filelist` call at all. Keep the existing
   list-based path for the *manual* record flow only if it still needs it — prefer converting that too,
   since it can name its capture the same way.
3. **Separate a file failure from a capture failure.** If the run counter incremented, the M569.5
   capture succeeded. Retry only the download, with a short backoff, a few times — and only if it still
   fails, report the capture as failed. This alone stops a 503 from costing a physical move.
4. **Batch the deletes.** Collect the names a run produced; delete them once at the end of the run
   (respecting the existing `deleteCapturesAfterRead` setting) instead of a delete request per capture.
   Delete failures must never fail the run.

### Tests

- `buildCaptureCommand` emits `F"name.csv"` when given a filename and is unchanged when not
  (`src/__tests__/m569.test.ts` or wherever `buildCaptureCommand` is covered).
- A download that fails twice then succeeds → capture succeeds, **no** extra move requested (assert the
  capture command was sent once).
- A download that never succeeds → capture reported failed, cleanly.
- Batch delete runs once with every name from the run; a delete failure doesn't fail the run.

---

## 5. Envelope check must prove it reached the speed it claims to have tested

**Found during this audit — a real bug in shipped code, not something the tester reported.**

The envelope check commands a feed but never verifies the axis *achieved* it. The move is auto-sized
(capped at `AUTO_MOVE_CAP_MM` = 200 mm) and the tester's Y axis is only 237 mm of travel. Reaching a
given speed needs `v²/(2a)` of travel to accelerate and as much again to stop. At the corrected F96000
(1600 mm/s motor-space) and a typical CoreXY `M201` of ~10000 mm/s², that is ~128 mm each way — 256 mm,
more than the ~200 mm available. The move would be a triangle peaking well below 1600 mm/s, and the card
would still say **"Holds at the machine's configured max — 0.0% saturation duty."** That is a false
reassurance about the exact thing the check exists to answer.

(All five reports show `satDuty: 0` and `holds: true` — consistent with a check that never actually
loaded the axis, though at the 60x feed they were not meaningful anyway.)

### Fix

Compute the **achieved** peak speed from the capture itself and compare it against the requested feed.
`Target Motor Steps` plus the sample rate gives commanded velocity directly (`buildSeries` / the
existing time axis already provide what's needed; `segmentMove` already classifies the cruise phase).

- If achieved peak is materially below requested (suggest **< 90%**), report the check as
  **inconclusive** rather than `holds: true`.
- `EnvelopeCheck` gains something like `achievedFeedMmPerMin: number` and a tri-state outcome
  (`"holds" | "saturates" | "inconclusive"`) rather than the current `holds: boolean`. Update the cards
  in both UIs and the log line accordingly.
- Inconclusive wording should say *why*, so it is actionable:
  > **Envelope check inconclusive** — the axis only reached F{achieved} of the F{requested} its
  > configuration allows; the move is too short to accelerate that far. This tune has not been checked
  > at the machine's real limits.

Keep it report-only, exactly as now — it must still never change the tuned values.

### Tests (`src/__tests__/` alongside the existing envelope tests)

- Achieved ≈ requested → `holds` / `saturates` as before, per sat duty.
- Achieved well below requested → `inconclusive`, regardless of sat duty (a comfortable 0% at half the
  speed must not read as "holds").
- Existing `envelopeFeedMmPerMin` unit tests stay as they are (v2.6.4 already corrected them).

---

## 6. Deferred by the tester — automatic tuning-speed selection

Tester: *"maybe 2.7/2.8 … I do not think this should be a priority right now though — getting P/I/D and
the evaluation fully reliable is much more important."*

Sketch for later: start the tuning feed at a fraction of the coupled axes' configured M203 (the
`envelopeFeedMmPerMin` machinery already computes that ceiling), run the first P=30 probe, and if its
accel P-term is near the rail fraction with ~0% real saturation, drop the feed ~20–25% and retry; raise
it if there is clear headroom. §1's warning is the manual stand-in until then. **Not in scope.**
