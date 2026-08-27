# Plan: standstill control-effort criteria, capture hygiene, and a truncated-capture parser bug

**Status:** planned, not started. Written 2026-08-22 from a user feedback report (3 items) plus 4 more
found while verifying it against the code and their captures.

**Audience:** this is written to be implemented directly. Every threshold below was measured against
real captures (§3.3), every file:line anchor was checked, and §11 lists what NOT to do. Where a number
is a judgement call rather than a measurement, it says so.

**Calibration set** — four captures, all four must behave as stated in §3.3:
- user `I≈23.5` settled, user `I=0` dithering (both have full PID-term columns)
- repo fixtures `hold-stable-transient.csv` (stable) and `hold-limit-cycle.csv` (railed)

---

## 0. Scope — 7 items

| # | Item | Source | Ready? |
|---|---|---|---|
| **A** | `Data lost` sentinel voids a whole usable capture | found here | **Yes** — reproduced |
| **B** | Auto-tune capture CSVs never cleaned up | user 1 | **Yes** — 2 decisions in §7 |
| **C** | I accepts while the motor dithers (auto-tune) | user 2 | **Yes** — fully calibrated |
| **D** | Effort metrics for D / output, computed + reported | user 3 | **Yes** — report-only, no gate |
| **E** | `signalCost` has no effort term at all (package/refine) | user 3 | **Yes** |
| **F** | Manual wizard has the **same** I blind spot | found here | **Yes** |
| **G** | Evaluation panel calls the dithering capture **"good"** | found here | **Yes** |

F and G matter because C alone would fix auto-tune while leaving the manual tuner and the user-facing
verdict panel confidently wrong about the same capture.

---

## 1. Implementation order

Do in this order; each phase is independently committable and testable.

1. **Phase 1 — A** (parser). Standalone, unblocks nothing else, actively broken today.
2. **Phase 2 — the metric** (§3.2): compute `RestEffort` in `analysis.ts`, surface on `TuneSignal` and
   `StepMetrics`. No behaviour change yet — pure measurement + tests against §3.3.
3. **Phase 3 — C, F, G** (consumers of the metric): I strategy, wizard, evaluation panel.
4. **Phase 4 — D, E**: report the D/output ripple; add the cost term.
5. **Phase 5 — B** (cleanup). Fully independent; can be done any time.

Phase 2 before 3 is important: get the numbers matching §3.3 first, then wire decisions to them.

---

## 2. Phase 1 — Item A: `Data lost` voids a usable capture

### 2.1 Evidence

One supplied capture ends:

```
837,418.58,17891,894.55,894.62,0.00,23.5,0.0,23.5,0.0,0.0,0.0,987,2011,0,-23,1
Data lost
```

`parseCapture` (`src/model/csv.ts:25-30`) splits every non-blank line on `,` and `parseFloat`s each
cell. That line has 1 field vs 17 headers → `NaN` pushed into **every** column. Then:

`tuneStats` → `restBias: null` → `computeTuneSignal` hits its `Number.isFinite` guard
(`signal.ts:148`) → **returns `null`** → `captureMedian` logs
**`Capture failed or invalid — retrying (1/2)…`** (`tuneShared.ts:87`) → after `CAPTURE_RETRIES = 2`
the stage aborts.

That log line is verbatim what appeared in this user's own screenshot earlier in the thread.
`MIN_CAPTURE_SAMPLES` is 50 (`signal.ts:99`); the capture had **838 usable rows**.

### 2.2 Change — `src/model/csv.ts`

```ts
export interface ParsedCapture {
	headers: Array<string>;
	columns: Record<string, Array<number>>;
	rowCount: number;
	/** Non-data lines the firmware appended (e.g. RRF's "Data lost" buffer-overrun marker). */
	notes: Array<string>;
	/** Firmware reported dropped samples — the capture is SHORT but the rows it did write are valid. */
	truncated: boolean;
}
```

In the row loop: if `cells.length !== headers.length`, push the raw line to `notes`, set
`truncated = true` when it matches `/data\s*lost/i`, and `continue` — do not push to any column.
`rowCount` counts only accepted rows.

Keep `notes`/`truncated` **always present** (`[]` / `false`) so no call site needs optional handling.

### 2.3 Change — `src/core/useClosedLoopTuning.ts`, `runCapture`

After `loadLatestCsv()` returns a capture, if `capture.truncated`, log once:

> `Capture truncated by the firmware (N samples kept) — the requested sample rate may be too high for this board.`

Then continue normally. Only fail if the parsed capture is genuinely unusable (which
`computeTuneSignal`'s existing `MIN_CAPTURE_SAMPLES` check already handles).

### 2.4 Tests — `src/__tests__/csv.test.ts`, `signal.test.ts`

- New fixture `fixtures/hold-truncated-datalost.csv` (trim the user's file, keep the trailing marker).
- `parseCapture`: `rowCount` excludes the marker; `truncated === true`; `notes` contains `"Data lost"`;
  **assert no `NaN` in any column** (this is the actual regression guard).
- `computeTuneSignal` on that fixture returns a signal, **not** `null`.
- A normal fixture still gives `truncated === false`, `notes: []`.

---

## 3. Phase 2 — the rest-effort metric

### 3.1 Why the error domain cannot work

Measured over the same window, the dithering capture has a **smaller** position error than the stable
fixture but **9× the control effort**:

| capture | error p2p | P-term p2p |
|---|---|---|
| `hold-stable-transient` (stable) | 0.12 | 3.60 |
| user I=0 (dithering) | 0.10 | 33.60 |

No error-domain threshold can separate those two. This is the user's "position noise vs
control-effort dithering" distinction, quantified.

Note also: `postMoveOsc` (`analysis.ts:306`) **already** counts P-term oscillation at rest — but gated
at `P_TERM_RAIL * 0.5` = **125**, for railed hunting. The user's swing is 16.8–33.6. This phase adds a
fine-grained sibling next to it; **do not change `postMoveOsc`'s gate**, `hold-limit-cycle.csv` depends
on it.

### 3.2 New code — `src/model/analysis.ts`

```ts
/** Fraction of the rest window (measured from the end) judged as "settled". */
export const REST_TAIL_FRACTION = 0.10;
/** Below this many samples the tail is too short to measure ripple meaningfully. */
export const REST_TAIL_MIN_SAMPLES = 25;
/** I is "converged" once it stays within this fraction of its own final value. */
export const I_SETTLED_TOL_FRACTION = 0.01;

export interface RestEffort {
	/** Peak-to-peak PID P term over the settled tail — the primary dither signal. */
	pTermRestRipple: number;
	/** RMS about the mean over the same window (outlier-resistant companion to p2p). */
	pTermRestRms: number;
	/** Peak-to-peak PID D term over the same window. 0 when not recorded. Reported, not gated. */
	dTermRestRipple: number;
	/** Peak-to-peak PID Control Signal (total output). 0 when not recorded. Reported, not gated. */
	outputRestRipple: number;
	/** Samples in the tail window. */
	restTailSamples: number;
	/**
	 * The ripple numbers are trustworthy. False when the tail was too short, OR the integrator had
	 * not converged by the start of the tail — see §3.4. A false here must SKIP any gate, never fail.
	 */
	restTailValid: boolean;
}

export function computeRestEffort(capture: ParsedCapture, sampleRateHz: number): RestEffort;
```

Implementation:
1. `segmentMove` to get `lastMoving`; rest window is `[lastMoving + 1, n)` (whole capture if `!moved`).
2. Tail start = `n - max(REST_TAIL_MIN_SAMPLES, floor(restLen * REST_TAIL_FRACTION))`, clamped to
   `restStart`.
3. `restTailValid = tailSamples >= REST_TAIL_MIN_SAMPLES && iConverged` (see §3.4).
4. p2p / RMS of `PID P Term`, `PID D Term`, `PID Control Signal` over the tail; missing column → 0.

Reuse the existing local helpers rather than adding new ones where they exist.

### 3.3 Calibration — these are assertions, not illustrations

`pTermRestRipple` over the §3.2 window:

| capture | expected | required behaviour |
|---|---|---|
| `hold-stable-transient.csv` | **3.60** | must NOT trip |
| user I≈23.5 settled | **0.00** | must NOT trip |
| user I=0 dithering | **33.60** | **must trip** |
| `hold-limit-cycle.csv` | **512.00** | already caught by `postMoveOsc` |

```ts
/** Peak-to-peak P-term at rest above this = control-effort dither, even if position error is tiny.
 *  Judgement call between the measured 3.60 (stable) and 33.60 (dithering) — ~3x margin either side. */
export const REST_EFFORT_RIPPLE_LIMIT = 10;   // P-term units; 4% of the 250 rail
```

Add both user captures as fixtures: `fixtures/hold-dither-i0.csv`, `fixtures/hold-settled-i23.csv`.
The existing two fixtures have **no `PID I Term` column** — that is fine and must keep working (§3.4
falls back), and is worth an explicit test.

### 3.4 The validity guard — the riskiest part of this plan, read before implementing

The window choice is load-bearing. Measured on the **settled** capture:

| tail window | P p2p | would a limit of 10 false-trip? |
|---|---|---|
| last 50% of rest | 16.80 | **yes** |
| last 25% of rest | 16.80 | **yes** |
| last 10% of rest | 0.00 | no |

Its integrator was still converging through most of the rest window (I climbing 20.2 → 23.5), going
quiet only in the final ~28 ms. The user reports the transient is **~0.5 s**; the rest windows in
these captures are **285 ms and 111 ms**.

**The failure mode to design against:** a capture that ends before the integrator converges looks like
dither, so the tuner keeps raising I. **Overshooting I is worse than the bug being fixed.**

Guard: compute `iConverged` — take `PID I Term`, let `iFinal` be its last finite value and
`tol = max(1e-6, I_SETTLED_TOL_FRACTION * |iFinal|)`; `iConverged` is true when **every** sample from
the tail start onward is within `tol` of `iFinal`. If the column is absent, or I never varies at all
(I gain is 0 — no integrator transient to wait for), treat as converged.

Verified against the calibration set:
- settled capture: I is 23.5 flat across the tail → converged → valid → measures 0.00 → passes
- dithering capture: I constant 0 throughout → converged → valid → measures 33.60 → **trips**
- both old fixtures: no I column → converged → valid → 3.60 / 512.00 → behave as before

When `restTailValid` is false: **skip the new gate entirely, keep today's behaviour, and log why.**
Never turn an invalid measurement into a rejection.

---

## 4. Phase 3 — the three consumers

### 4.1 Item C — `SIGNAL_I_STRATEGY` (`src/model/autotune.ts:293`)

Today:

```ts
if (Math.abs(last.signal.stats.restBias) <= REST_GOOD) { return { kind: "accept", … }; }
```

Both calibration captures satisfy this — including the buzzing one. Change to require both:

```ts
const effortSettled = !s.restTailValid || s.pTermRestRipple <= REST_EFFORT_RIPPLE_LIMIT;
if (Math.abs(s.stats.restBias) <= REST_GOOD && effortSettled) { accept }
```

When bias is fine but effort is not, **keep raising I** (the existing `next = value * 1.5` path) and log
distinctly, e.g.:

> `I=1000: standing error 0.02 step is fine, but the P term is still swinging 33.6 at rest — the motor is dithering. Raising I.`

Constraints:
- `signalUnstable` veto keeps taking precedence (a wound-up integrator must still back off).
- `I_MAX` and `maxAttempts` unchanged — it must not ramp forever.
- The `bestBy(attempts, |restBias|)` max-attempts fallback should prefer a **stable-effort** attempt
  when one exists; only fall back to lowest-bias if none do.

### 4.2 Item F — manual wizard (`src/model/wizard.ts:103`)

Same blind spot, different type. Today it accepts on `|steadyStateError| <= 0.1`, which a zero-centred
limit cycle satisfies. Requires `RestEffort` on **`StepMetrics`** too (extruder/step path) — add it in
`analyzeCapture` (`analysis.ts`) the same way `pTermSatDuty` is already attached at `analysis.ts:227`.

Then gate the `"accept"` verdict identically, with an `"increase"` verdict and a message naming
dithering rather than steady-state error.

### 4.3 Item G — evaluation panel (`src/model/evaluate.ts:198`)

Today, for the dithering capture, the panel emits:

> **good** — "Reaches target — Settles to within 0.11 step of target — no standing offset."

That is user-facing and wrong. `evaluateTune(capture, sampleRateHz)` already has the capture and
already imports from `analysis.ts` (`evaluate.ts:11`), so it can call `computeRestEffort` directly —
**no signature change, no circular import** (`analysis` → `csv` only; `evaluate` → `analysis`).

Add a finding after the existing rest-bias block:

```ts
if (re.restTailValid && re.pTermRestRipple > REST_EFFORT_RIPPLE_LIMIT) {
	add({
		severity: "warn",
		title: "Dithers at standstill",
		detail: `Position error is only ±${…} step, but the P term swings ${re.pTermRestRipple.toFixed(1)} `
			+ `at rest — the motor is working hard to hold position, which is audible as buzz or hum.`,
		fix: "Raise I (integral) so it holds the static load instead of P",
		term: "i",
		direction: "up",
	});
}
```

`severity: "warn"` costs 15 points via the existing `penalise` — enough to pull "excellent" down but
not to fail the tune outright. Do not use `"bad"`: the loop is stable and positionally accurate; it is
mechanically unpleasant, not broken.

**Suppress the existing "Reaches target / good" finding when this one fires** — emitting both is
contradictory.

---

## 5. Phase 4 — Items D and E

### 5.1 Item D — compute and report D / output ripple

`dTermRestRipple` and `outputRestRipple` are computed in Phase 2. This phase is purely about surfacing
them:

1. **Downloadable report** — `ReportCapture.metrics` is typed `unknown` (`report.ts:56`) and holds the
   whole signal object, so fields added to `TuneSignal` flow through with **no `report.ts` change**.
   Verify this rather than assuming; add a test asserting the new keys survive a round-trip.
2. **`notable`** (`useClosedLoopTuning.ts`, `recordSessionCapture`) currently means
   `pTermSatDuty >= REPORT_NOTABLE_SAT_DUTY`. Extend it to also mark a capture notable when
   `restTailValid && pTermRestRipple > REST_EFFORT_RIPPLE_LIMIT`, so a dithering capture keeps its full
   raw CSV in the report — that is the evidence a future D calibration will need.
3. **Run log** — include the ripple in `describeSignal` (`signal.ts:310`) alongside `bias`/`ring`, so
   every attempt line in the log shows it.

**Deliberately no D gate.** Both supplied captures have `PID D Term = 0.0` for every sample, so any D
threshold would be invented. Their goal ("lowest D that fixes overshoot without raising standstill
effort") is a **tie-break among acceptable D values**, which §5.2 expresses better than a hard gate.
§7 asks them for a capture with non-zero D.

### 5.2 Item E — effort term in `signalCost` (`src/model/signal.ts:196`)

`signalCost` is built **entirely** from `TuneStats` — no P/D/output data at all. So package/refine loses
not just I/D effort-awareness but A/V's too (those live only in the per-term strategies). Add:

```ts
/** Rest-effort dither, normalised to the rail so it stays in the same step-equivalent units as the
 *  rest of the cost. Sized to break ties and penalise dither — deliberately NOT to dominate tracking. */
export const COST_WEIGHT_REST_EFFORT = 1.5;

… + COST_WEIGHT_REST_EFFORT * (s.restTailValid ? s.pTermRestRipple / P_TERM_RAIL : 0)
```

Contributes ~0.20 for the dithering capture, ~0.02 for the stable one — same order as the existing
`restBias` term (1.0 × ~0.11). `restTailValid === false` contributes 0, never a penalty for an
unmeasurable capture.

**Regression check:** `signal.test.ts:166` asserts `signalCost(hold-limit-cycle) === Infinity`; that
comes from the `signalUnstable` veto and is unaffected. Every other cost assertion in that file must be
re-checked against the new term.

---

## 6. Phase 5 — Item B: capture CSV cleanup

### 6.1 The constraint is satisfiable exactly

`loadLatestCsv()` already resolves the **literal filename** of every capture the plugin triggered:

```ts
const files = list.filter(…).sort(…);
const text = await host.download(`${CAPTURE_DIR}/${files[0].name}`);   // ← exact name, known here
```

So track the names created during a run in a run-scoped `Set<string>` and delete **only** those. No
filename-pattern matching, no chance of deleting a user's own file — strictly safer than asked for.

Nothing re-reads the file afterwards: the chart uses the parsed capture, the report uses the in-memory
downsampled series plus `rawText` retained per capture in `tuneSession.captures[].csv`. Deleting
straight after a successful parse is safe.

### 6.2 Changes

1. **`src/core/host.ts`** — add to `HostAdapter`:
   ```ts
   /** Delete a file by full path. Used only for capture CSVs this plugin itself created. */
   deleteFile(path: string): Promise<void>;
   ```
   (`deleteFile` rather than `delete`: the latter is legal as a property name but shadows the `delete`
   operator at every call site and trips some lint configs.)
2. **`src/ui37/host.ts`** — `machineStore.delete(filename)` — verified at `stores/machine.ts:778`.
3. **`src/ui36/host.ts`** — `store.dispatch("machine/delete", filename)` — verified at
   `store/machine/index.ts:464` (accepts `string | { filename, recursive? }`).
4. **`useClosedLoopTuning.ts`** — delete on successful parse when enabled. **Each delete in its own
   try/catch; a failed delete must never break a tuning run** — log and continue.
5. **Setting** `deleteCapturesAfterRead`, persisted in the existing `LS_STATE` blob (add to
   `SavedState` + `persistState` + the `watch` list, same as every other setting), surfaced as a
   checkbox in the Advanced capture panel in **both** UIs. Label text hardcoded in the template,
   matching the existing convention (e.g. "Include all raw CSVs").

### 6.3 Decisions needed — §7

Recommended defaults if no answer comes back: **off by default**, **delete per-capture**.
"Keep last N" is deliberately not proposed — it needs a prune pass over a directory that may hold
non-plugin files, reintroducing exactly the ambiguity §6.1 avoids.

---

## 7. Questions for the user (do not block Phases 1–5 on these)

1. **D:** did you actually *observe* D causing standstill effort ripple, or was that reasoning from the
   code? A capture with non-zero D would let the D criterion be calibrated instead of guessed (§5.1).
2. **Cleanup:** default on or off; per-capture or end-of-run (§6.3)?
3. **Truncation:** how often do runs report `Capture failed or invalid — retrying`? One of your two
   files ends in `Data lost`, which §2 shows discards the whole capture — confirming this would tell us
   how much §2 alone improves your runs.
4. **Longer rest window:** anything showing the ~0.5 s integrator transient with a *longer* settled tail
   would directly de-risk §3.4, the part most likely to misbehave on a different machine.

---

## 8. File-by-file

| File | Change | Phase |
|---|---|---|
| `src/model/csv.ts` | Skip malformed rows; `notes` + `truncated` | 1 |
| `src/core/useClosedLoopTuning.ts` | Accept truncated captures + log; track/delete CSV names; extend `notable` | 1, 4, 5 |
| `src/model/analysis.ts` | `computeRestEffort`, `RestEffort`, constants; attach to `StepMetrics` | 2 |
| `src/model/signal.ts` | Surface `RestEffort` on `TuneSignal`; `describeSignal`; `COST_WEIGHT_REST_EFFORT` | 2, 4 |
| `src/model/autotune.ts` | `SIGNAL_I_STRATEGY` second gate + log line + fallback preference | 3 |
| `src/model/wizard.ts` | I step: same gate on `StepMetrics` | 3 |
| `src/model/evaluate.ts` | "Dithers at standstill" finding; suppress the contradictory "good" | 3 |
| `src/core/host.ts` | `deleteFile(path)` | 5 |
| `src/ui37/host.ts`, `src/ui36/host.ts` | Implement `deleteFile` | 5 |
| `src/ui37/ClosedLoopTuning.vue`, `src/ui36/ClosedLoopTuningPage.vue` | Cleanup checkbox (markup only) | 5 |
| `src/__tests__/fixtures/` | `hold-truncated-datalost.csv`, `hold-dither-i0.csv`, `hold-settled-i23.csv` | 1, 2 |

Both `.vue` files change only in markup — all logic is in the shared composable, so the two DWC
generations cannot diverge.

---

## 9. Test plan

**Phase 1** — `csv.test.ts`: truncated fixture parses, `truncated`/`notes` set, **no NaN anywhere**;
normal fixture unchanged. `signal.test.ts`: `computeTuneSignal` returns a signal for it.

**Phase 2** — new `restEffort.test.ts`: `pTermRestRipple` matches all four values in §3.3 exactly;
`restTailValid` true for all four; a synthetic short-rest capture gives `restTailValid === false`; a
synthetic capture whose I is still climbing through the tail gives `restTailValid === false`; a capture
with no `PID I Term` column still validates.

**Phase 3** — `autotune.test.ts`: I strategy **rejects** the dithering signal and **accepts** the
settled one; an invalid-tail signal takes today's path. `wizard.test.ts`: same two cases.
`evaluate.test.ts`: dithering capture produces the "Dithers at standstill" finding, is **not** graded
excellent, and does not also emit "Reaches target"; the stable fixture is unchanged.

**Phase 4** — `signal.test.ts`: re-verify every existing cost assertion; new: dithering costs more than
settled, `restTailValid === false` adds 0. `report.test.ts`: new metric keys survive the round-trip;
a dithering capture is `notable`.

**Phase 5** — host adapters expose `deleteFile`; only tracked filenames are passed to it; a rejected
`deleteFile` does not abort the run (assert the run completes and a warning is logged).

---

## 10. Verification checklist

- [ ] `npm test` — existing 330 pass, plus new
- [ ] `DWC_DIR=<3.7> npm run typecheck` and `npm run verify-build`
- [ ] `DWC36_DIR=<3.6> npm run check-ui36`
- [ ] `build36.bat` produces an installable 3.6 ZIP
- [ ] Hardware: cleanup deletes only plugin captures; auto-tune no longer accepts I=0 on the
      reporter's machine; the evaluation panel flags the dither

---

## 11. Explicit non-goals — do NOT do these

- **Do not change `postMoveOsc`'s `P_TERM_RAIL * 0.5` gate.** It exists for railed hunting and
  `hold-limit-cycle.csv` depends on it. The new metric sits alongside it.
- **Do not add a D acceptance gate.** No data (§5.1). The cost term covers the intent.
- **Do not auto-reduce the sample rate on truncation.** Changing rate mid-run changes the comparison
  basis between attempts in the same ramp. Log it and let the user decide.
- **Do not let `restTailValid === false` cause a rejection or a failure** anywhere — it must only ever
  skip a gate or contribute 0 cost.
- **Do not implement "keep last N" captures** (§6.3).
- **Do not widen `REST_EFFORT_RIPPLE_LIMIT` to catch the stable fixture's 3.60.** That is genuine
  encoder-noise jitter and must stay unflagged.
