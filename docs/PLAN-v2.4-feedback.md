# Plan: v2.4.0 field feedback — D-term over-damping, combined current, wizard moves, rounding

**Status:** planned, not started. Written 2026-08-29 from one user's v2.4.0 testbench report (4 points)
plus their unprompted compliment about "Refine" (no code change — noted in §8).

**Audience:** written to be implemented directly. Every claim below was checked against the current
code (file:line anchors throughout), not assumed from the report. §9 lists what NOT to do.

---

## 0. Scope — 4 items

| # | Item | Confirmed how | Risk |
|---|---|---|---|
| **H** | D-term auto-tune has no diminishing-returns escape — rides a persistent, non-resonant ripple (e.g. ballscrew lead error) all the way to `D_MAX` | Read `SIGNAL_D_STRATEGY` — no plateau check, unlike every sibling strategy | Medium (H.1 low, H.2 medium, H.3 low/report-only) |
| **I** | No combined-current signal — only raw `Coil A/B Current` | Read `CAPTURE_VARIABLES`, `CaptureChart.vue` | Low |
| **J** | Wizard's move isn't user-configurable | Read `captureStep()` / `runWizardCapture()` | Low |
| **K** | PID values show up to 6 decimal places (not 3 as reported — worse) | Read `nextBackoff()` | Low |

None of these interact with each other — any subset can ship independently, in any order.

---

## 1. Implementation order

Ship K first (trivial, real bug), then H.1 (the actual reported pain point), then I and J (independent
UI additions) in either order. H.2/H.3 are optional extensions of H — see §2.4.

1. **K** — rounding (§5)
2. **H.1** — D-term plateau escape (§2.1)
3. **H.2** — optional D ceiling setting (§2.2) — more plumbing than the rest of this plan combined; see
   the note at the end of §2.2 before committing to it
4. **H.3** — report-only cruise-ripple context (§2.3)
5. **I** — combined current (§3)
6. **J** — wizard configurable move (§4)

---

## 2. Item H — D-term over-damping on persistent (non-resonant) ripple

### 2.0 Root cause

[`SIGNAL_D_STRATEGY`](../src/model/autotune.ts#L263-L291) only ever stops raising D two ways:
- `settleOvershoot <= OVERSHOOT_GOOD && restRing < RING_WARN` → accept (genuinely critically damped)
- `restRing` got **worse** than the previous attempt by more than `D_RING_WORSE` (2 cycles) → back off

There is no "not improving, but not getting worse either" exit — unlike every sibling strategy
(`P_RMS_PLATEAU` in `SIGNAL_P_STRATEGY`, `AV_PLATEAU` in `SIGNAL_A_STRATEGY`/`SIGNAL_V_STRATEGY`). A
ballscrew's lead-error ripple is an external forcing function, not loop resonance — no D value removes
it. If it holds `restRing` at some elevated-but-stable value (say, always 5-6 cycles, never `< RING_WARN`
and never `> prev + 2`) as D climbs, the strategy just keeps raising D every attempt until `D_MAX` (0.6)
— 16 wasted captures per D stage, every run, on a driver where the ballscrew ripple constant.

### 2.1 Fix — diminishing-returns plateau (do this regardless of H.2/H.3)

Add to `src/model/autotune.ts`, alongside the other plateau constants (`P_RISE_PLATEAU`,
`P_RMS_PLATEAU`, `AV_PLATEAU`):

```ts
export const D_OVERSHOOT_PLATEAU = 0.05;  // <5% overshoot improvement → more D isn't helping, stop
```

In `SIGNAL_D_STRATEGY.decide`, insert **after** the existing "D amplifying noise" backoff check
(`autotune.ts:278-283`) and **before** computing `next`:

```ts
// Diminishing returns: overshoot barely moved vs. the last attempt, and ring didn't clear either —
// more D is not fixing this (a persistent non-resonant ripple, e.g. ballscrew lead error, is the
// likely culprit: no D value removes a forcing function that isn't the loop's own underdamping).
// Settle on whichever attempt had the lowest overshoot instead of riding this to D_MAX.
if (attempts.length >= 2) {
	const prev = attempts[attempts.length - 2];
	const po = prev.signal.stats.settleOvershoot;
	if (po > 0 && (po - s.settleOvershoot) / po < D_OVERSHOOT_PLATEAU) {
		const best = bestBy(attempts, (sig) => sig.stats.settleOvershoot);
		return { kind: "accept", value: best.value, note: `Overshoot plateaued at ~${s.settleOvershoot.toFixed(2)} step (${po.toFixed(2)} → ${s.settleOvershoot.toFixed(2)}) — more D isn't helping. Settled on D=${best.value}.` };
	}
}
```

This mirrors `SIGNAL_P_STRATEGY`'s existing rise-time-plateau pattern exactly (`autotune.ts:246-253`) —
same shape, same tolerance constant style, same `bestBy` fallback already used two lines below it for
the max-attempts case. No new helper needed.

**Ordering matters**: this must run after the "getting worse" backoff (a genuinely worsening ring should
still trigger the sharper backoff-to-previous-value response, not the plateau's "keep the best of all
attempts so far") and before the unconditional ramp (`next = round(...)`) so it actually short-circuits
the climb.

Apply the identical check to the legacy step-response `D_STRATEGY` (`autotune.ts:112-133`, extruder
path) for consistency — same shape, using `overshootPct` in place of `settleOvershoot`:

```ts
if (attempts.length >= 2) {
	const prev = attempts[attempts.length - 2];
	const po = prev.metrics.overshootPct;
	if (po > 0 && (po - last.metrics.overshootPct) / po < D_OVERSHOOT_PLATEAU) {
		const best = bestStable(attempts) ?? last;
		return { kind: "accept", value: best.value, note: `Overshoot plateaued at ~${last.metrics.overshootPct.toFixed(0)}% — more D isn't helping. Settled on D=${best.value}.` };
	}
}
```

Wire the manual wizard's D step (`src/model/wizard.ts:75-94`) too — it has **no** upper bound at all
today, not even `D_MAX` (unlike every auto-tune D path). Add the same plateau logic is not possible
there (the wizard only ever sees one capture at a time, no attempt history) — instead just cap the
suggested value against `D_MAX` (imported from `autotune.ts`, already exported):

```ts
suggested: Math.min(D_MAX, round(current + (current < 0.5 ? 0.01 : 0.025), 3)),
```
on both the "increase" branches (lines 87). This is a pre-existing gap, not something the user reported
directly, but it's one line once you're already touching this code — skip it if you want to keep this
phase narrower.

### 2.2 Optional — configurable D ceiling

Directly what the user asked for first ("a configurable limit for the D-term"). **More plumbing than
everything else in this plan combined** — `runAxisCycle` already has 11 positional parameters
(`autorun.ts:382-385`); this adds a 12th, threaded from `AutoRunOptions` down through one more call
frame than any other setting in this file. Judgement call: ship H.1 alone first, add this only if the
user still wants a hard manual ceiling after trying H.1.

If implementing:
1. `AutoRunOptions` (`tuneShared.ts` — no, `autorun.ts:91-115`): add `dCeiling?: number;`.
2. `runSignalTerm` (`autorun.ts:276-309`): add a 7th parameter `ceiling = Infinity`, and change the
   `value = d.value;` line at the bottom of the loop to `value = Math.min(d.value, ceiling);`. Default
   `Infinity` makes this a no-op for every other term and every existing call site/test.
3. `runAxisCycle` (`autorun.ts:382-385`): add a trailing `dCeiling?: number` parameter; at the call site
   (`autorun.ts:476`), pass `strategy.term === "d" ? (dCeiling ?? Infinity) : Infinity` as the new
   argument to `runSignalTerm`.
4. `runAutoTune` (`autorun.ts:773`, call at `autorun.ts:819`): thread `opts.dCeiling` through to
   `runAxisCycle`.
5. Wizard side: clamp in the composable, not in `wizard.ts` (keeps `recommend()` pure) — in
   `applySuggestion()` (`useClosedLoopTuning.ts`), when `term === "d"`, clamp against the same setting
   before assigning `pid.d`.
6. New persisted setting `dCeiling: number | null` (`null` = no ceiling, i.e. `D_MAX` applies as today)
   — same `SavedState`/`persistState`/`watch` treatment as `deleteCapturesAfterRead`
   (`useClosedLoopTuning.ts:105-174`). UI: a numeric field near the D term in the PID panel, in both
   `.vue` files, hidden behind an "Advanced" disclosure like the other rarely-touched settings.

**Do not** implement this as a strategy factory (`makeSignalDStrategy(ceiling)`) — it would need to
replace the exported `SIGNAL_D_STRATEGY` const in `AUTOTUNE_SIGNAL_SEQUENCE` per-run, which ripples into
every test that imports the array by reference (`autorun.test.ts:289` asserts term order against it
directly).

### 2.3 Report-only — cruise-phase ripple context

The user's second suggestion (detect frequencies present during constant-speed motion vs. standstill,
suppress only what's common to both) is the technically "right" fix but needs real ballscrew-affected
captures to calibrate — same situation the standstill-effort plan hit with D-term ripple (no data, so
report-only; see `docs/PLAN-standstill-effort.md` §5.1). Ship the cheap, safe half now: **surface** that
cruise-phase ripple exists, without ever acting on it automatically.

1. Add `cruiseRing: number` to `TuneStats` (`evaluate.ts:30-56`) and compute it in `tuneStats`
   (`evaluate.ts:154-167`) the same way as `restRing`, reusing the already-computed `restNoise` as the
   gate's noise floor:
   ```ts
   cruiseRing: ringCount(cruiseErr, Math.max(0.3, 3 * restNoise)),
   ```
2. In `evaluateTune`'s existing "Rings after stopping" finding (`evaluate.ts:250`), when
   `s.restRing >= RING_WARN && s.cruiseRing >= RING_WARN`, append to the `detail` text (do **not** add a
   new finding or change severity/score — this is context, not a new verdict):
   > "...and a similar {N} cycles show up while cruising too — that pattern usually means a mechanical
   > source (e.g. a leadscrew/ballscrew), not underdamping. More D is unlikely to help; check the
   > mechanics before raising it further."
3. In `SIGNAL_D_STRATEGY`'s new plateau accept-note (§2.1) and its existing max-attempts fallback note,
   append the same context when `cruiseRing` was present and non-decreasing across the D ramp's own
   attempts (i.e. `attempts[0].signal.stats.cruiseRing > 0` and the last attempt's `cruiseRing` isn't
   meaningfully lower).

This never changes a decision, a score, or a gate — it only makes an existing "you're under-damped"
message more specific when there's evidence it isn't really a D problem. Exactly the same non-goal
discipline as the standstill-effort plan's D item: report, don't guess a threshold.

---

## 3. Item I — combined (torque-proxy) current

### 3.1 Where it goes

`Coil A Current` / `Coil B Current` (`m569.ts:134-135`) are raw M569.5 firmware variables — real bitmask
IDs (2048/4096), independently recordable. There is no vector-magnitude field anywhere. The natural
combined quantity for a 2-phase stepper is `hypot(A, B)` — proportional to total phase current, which is
what actually drives torque headroom.

This **cannot** be a `CaptureVariable` with a real `id` — RRF has no such M569.5 bit. It must be computed
client-side after both raw columns are present, then treated as a normal "view" variable everywhere else
(chart, export) — exactly the same shape `csv.ts` already uses for `notes`/`truncated` (derived,
computed once at parse time, then just data).

### 3.2 Change — `src/model/csv.ts`, `parseCapture`

After building `columns` (end of the function, before `return`):

```ts
const a = columns["Coil A Current"];
const b = columns["Coil B Current"];
if (a && b) {
	const combined = a.map((av, i) => Math.hypot(av, b[i] ?? 0));
	headers.push("Motor Current (combined)");
	columns["Motor Current (combined)"] = combined;
}
```

Pure, deterministic, same length as the other columns, no dependency on anything outside this file.
`rowCount` is unaffected (it's a row count, not a header count).

### 3.3 Change — `src/model/m569.ts`, `CAPTURE_VARIABLES`

Add a `derived` flag to the interface and one new entry:

```ts
export interface CaptureVariable {
	id: number;
	key: string;
	header: string;
	axis: "count" | "steps" | "error" | "degrees" | "unitless";
	scaleToDegrees?: boolean;
	/** Computed client-side from other recorded columns (see csv.ts) — never sent in the M569.5
	 *  bitmask, and never offered in the "record" variable list, only in "view" once it exists. */
	derived?: boolean;
}
```
```ts
{ id: 0, key: "motorCurrentCombined", header: "Motor Current (combined)", axis: "unitless", derived: true },
```
`id: 0` is safe: `captureBitmask` OR-reduces ids and `0` contributes nothing, so even if this key ever
leaked into a `variables` array sent to firmware it would be a no-op, not a wrong bit.

### 3.4 Change — `src/core/useClosedLoopTuning.ts`

Two of the three `CAPTURE_VARIABLES` consumers must exclude `derived` entries (they enumerate
*recordable* firmware variables); the third (`availableViewVars`) already self-filters correctly by
checking for the column's actual presence, so it needs no change:

```ts
const captureVariables = CAPTURE_VARIABLES.filter((v) => !v.derived);   // line 92 — the "record" checklist
...
const ALL_CAPTURE_KEYS = CAPTURE_VARIABLES.filter((v) => !v.derived).map((v) => v.key);  // line 654 — auto-generated captures' record set
```
Leave `availableViewVars` (`useClosedLoopTuning.ts:594`) exactly as-is — it filters on
`capture.value.columns[v.header]`, which is only truthy for the derived column once §3.2 has actually
computed it (i.e. once both raw currents were recorded), so it naturally appears in "view" only when
there's real data to show.

No `.vue` changes needed — both templates already iterate `captureVariables`/`availableViewVars`
generically (`ui37/ClosedLoopTuning.vue:314,435`); the new entry just shows up.

No `CaptureChart.vue` change needed — it resolves everything through `CAPTURE_VARIABLES` + `column()` +
`axis` already (`CaptureChart.vue:52-69`); `axis: "unitless"` puts it on the same right-hand axis as the
raw coil currents, which is correct (same physical units).

---

## 4. Item J — wizard: configurable move instead of a fixed auto-sized G1

### 4.1 What's actually true today

The wizard does **not** use RRF's V64 step manoeuvre (the user's guess) — `captureStep()`
(`useClosedLoopTuning.ts:722-757`) already builds and sends a real move: `G91 G1 H2 {axis}{dist}
F{feed} G90`, sized by `stepJumpDistanceMm`/`stepJumpFeedMmPerMin`. The actual gap: that distance/feed
is auto-computed with **no UI control**, while the "Advanced: manual capture" panel already has exactly
the configurable-move mechanism the user wants (`moveMode`/`customMove`, default `G91 G1 H2 X50 F6000
G90`) — it's just not wired into the wizard. `runWizardCapture()` (`useClosedLoopTuning.ts:612-616`)
calls `captureStep()` directly and never looks at `moveMode`/`customMove`.

### 4.2 Change — `src/core/useClosedLoopTuning.ts`, `runWizardCapture`

```ts
async function runWizardCapture(): Promise<void> {
	recording.value = true;
	try {
		if (moveMode.value === "custom") {
			if (!customMove.value) {
				host.notify("warning", "Closed Loop Tuning", "Enter a move before recording.");
				return;
			}
			const coupled = coupledAxesForDriver();
			if ("error" in coupled) { log(`Step capture: ${coupled.error}`); host.notify("error", "Closed Loop Tuning", coupled.error); return; }
			if (!(await ensureAxisReady(coupled))) { return; }
			const c = await runCapture({
				driver: selectedDriver.value ?? "", samples: samples.value, activate: 1,
				rate: sampleRate.value, variables: varIds(ALL_CAPTURE_KEYS), manoeuvre: 0, move: customMove.value,
			});
			if (c) { metrics.value = analyzeCapture(c, sampleRate.value); }
		} else {
			// Default: today's behaviour, unchanged.
			await captureStep();
		}
	} finally { recording.value = false; }
}
```

This is the **same** ensureAxisReady/coupledAxesForDriver guard `record()` and `captureStep()` already
each use (`useClosedLoopTuning.ts:537-540`, `:727-729`) — do not skip it for the wizard path; a custom
move is arbitrary G-code, unchecked against travel limits, exactly as already documented on `record()`
(`useClosedLoopTuning.ts:534-536`).

Default behaviour (`moveMode.value === "step"`, which is the persisted default — `useClosedLoopTuning.ts:136`)
is **completely unchanged** — this only activates when the user has already switched to "custom" mode
in the Advanced panel, which today does nothing for the wizard. Consider factoring the now-duplicated
"ensureAxisReady + runCapture(custom move)" shape shared with `record()` into one helper — not required,
but the two are now near-identical except for which keys they record.

### 4.3 UI — expose the toggle where the wizard actually is

Today `moveMode`/`customMove` only appear in the "Advanced: manual capture" accordion, which is a
different part of the page from the guided wizard steps. Add a small note/link on the wizard's P/D/I
step cards (both `.vue` files) pointing at the existing Advanced panel toggle rather than duplicating the
whole moveMode UI a second time — e.g. a `HelpTip` near the "Capture" button on the wizard step:
> "Uses a small auto-sized test move by default. To use your own G1 move instead, set it in Advanced →
> Manual capture, then switch Move to Custom before capturing."

Keep exactly one source of truth for `moveMode`/`customMove` (the existing refs) — don't add a
wizard-local copy.

---

## 5. Item K — inconsistent rounding on verification backoff (real bug, not cosmetic)

### 5.1 Root cause

[`nextBackoff`](../src/model/tuneShared.ts#L102-L105) rounds to a **hardcoded 6 decimal places**, while
every other place a PID term is set rounds to 2 (p/i/a/v) or 4 (d) — see the duplicated
`ROUND_DP`/`REFINE_ROUND_DP` maps in `optimize.ts:70` and `autorun.ts:510` (both
`{ p: 2, i: 2, d: 4, a: 2, v: 2 }`). Repeated halving on a verification retry lands on exact binary
fractions (`.5`, `.25`, `.125`, `.0625`, `.03125`...) — for an A-term value in the hundreds of thousands,
that's real, correctly-computed digits, not float noise, just at 6dp instead of 2dp. Nothing on the
display side (`pidSummary` chip, the plain `<input type="number">`) reformats it. This is worse than "3
digits" — it can be up to 6, and it comes from the ONE place in the codebase using a different precision
than everywhere else, not from a display bug.

### 5.2 Fix — one shared `ROUND_DP`, `nextBackoff` takes a term

1. `src/model/tuneShared.ts`: add, next to `TERM_MAX` (`tuneShared.ts:61`):
   ```ts
   export const ROUND_DP: Record<PidTerm, number> = { p: 2, i: 2, d: 4, a: 2, v: 2 };
   ```
2. Change `nextBackoff`'s signature and body (`tuneShared.ts:102-105`):
   ```ts
   export function nextBackoff(value: number, retry: number, term: PidTerm): number {
   	return round(value * Math.pow(0.5, retry + 1), ROUND_DP[term]);
   }
   ```
3. Update its two call sites:
   - `tuneShared.ts:133` (inside `verifyAccepted`, which already has `term` in scope): `value =
     nextBackoff(acceptedValue, retry, term);`
   - `autorun.ts:446`: `pid.p = nextBackoff(candidate.p, tries, "p"); pid.i = nextBackoff(candidate.i,
     tries, "i"); pid.d = nextBackoff(candidate.d, tries, "d");`
4. Delete the duplicate `ROUND_DP` in `optimize.ts:70` and `REFINE_ROUND_DP` in `autorun.ts:510`; import
   `ROUND_DP` from `tuneShared.ts` at both sites instead. Same values, single source of truth — this is
   the fix for the root inconsistency that let `nextBackoff` silently drift to a different precision in
   the first place.

No UI change needed — every display site already binds directly to the already-rounded `pid[term]`
value; the bug was purely in what got written there.

---

## 6. File-by-file

| File | Change | Item |
|---|---|---|
| `src/model/tuneShared.ts` | `ROUND_DP` (moved here), `nextBackoff(…, term)` | K |
| `src/model/optimize.ts` | Import `ROUND_DP` instead of local copy | K |
| `src/model/autorun.ts` | `nextBackoff` call sites; D plateau constant reused; (H.2 only) `dCeiling` threading | K, H.1, H.2 |
| `src/model/autotune.ts` | `D_OVERSHOOT_PLATEAU`; plateau check in `SIGNAL_D_STRATEGY` and `D_STRATEGY`; cruise-ripple context in notes | H.1, H.3 |
| `src/model/wizard.ts` | Cap D step's suggested value at `D_MAX` | H.1 (optional tail) |
| `src/model/evaluate.ts` | `cruiseRing` on `TuneStats`; context text on the ringing finding | H.3 |
| `src/model/csv.ts` | Compute `Motor Current (combined)` in `parseCapture` | I |
| `src/model/m569.ts` | `CaptureVariable.derived`; new combined-current entry | I |
| `src/core/useClosedLoopTuning.ts` | Filter `derived` out of record lists; `runWizardCapture` custom-move branch; (H.2 only) `dCeiling` setting + clamp in `applySuggestion` | I, J, H.2 |
| `src/ui37/ClosedLoopTuning.vue`, `src/ui36/ClosedLoopTuningPage.vue` | HelpTip pointing wizard → Advanced move toggle; (H.2 only) D-ceiling field | J, H.2 |

---

## 7. Test plan

**K** — `tuneShared.test.ts` (or wherever `nextBackoff` is currently tested): backoff on each term rounds
to that term's own `ROUND_DP`, not 6; an A-term backoff after 3 retries has ≤2 decimal places.
`optimize.test.ts`/`autorun.test.ts`: existing `ROUND_DP`-dependent assertions still pass after the
import swap (no behaviour change there, just deduplication).

**H.1** — `autotune.test.ts`: a `SIGNAL_D_STRATEGY` sequence whose overshoot barely improves between two
attempts (both above `OVERSHOOT_GOOD`, ring never worsening) accepts on the plateau, at the
lowest-overshoot attempt seen, well before `maxAttempts`. A sequence with real, improving overshoot each
step keeps ramping (regression: this must not fire early on a normal, working D ramp — check against the
existing passing fixtures/attempts already in this file). Same two cases for `D_STRATEGY`.
`wizard.test.ts`: D step's suggested value never exceeds `D_MAX`.

**H.2** (if implemented) — `autorun.test.ts`: `runSignalTerm` with a `ceiling` clamps a `"set"` value
that would otherwise exceed it; omitting `ceiling` (or `Infinity`) reproduces every existing assertion
unchanged.

**H.3** — `evaluate.test.ts`: a capture with high `restRing` AND high `cruiseRing` gets the extended
detail text; high `restRing` alone (existing fixtures) is unchanged (same severity, same score, original
wording).

**I** — `csv.test.ts`: a fixture with both `Coil A Current`/`Coil B Current` columns gets a computed
`Motor Current (combined)` column, `hypot(a,b)` per row; a fixture with only one (or neither) column is
unaffected (no new header, existing behaviour). `m569.test.ts` (if one exists) or a new assertion:
`CAPTURE_VARIABLES.filter(v => !v.derived)` excludes the new entry;
`useClosedLoopTuning`'s `captureVariables`/`ALL_CAPTURE_KEYS` exclude it too.

**J** — a test (or extend an existing `useClosedLoopTuning` test) asserting `runWizardCapture()` in
custom mode calls `runCapture` with `move: customMove.value` and `manoeuvre: 0`, gated behind
`ensureAxisReady`; in default "step" mode, behaviour is byte-for-byte what it is today (existing tests
covering `captureStep()` must all still pass unmodified).

---

## 8. Verification checklist

- [ ] `npm test` — all existing tests pass, plus new ones per §7
- [ ] `DWC_DIR=<3.7> npm run typecheck` and `npm run verify-build`
- [ ] `DWC36_DIR=<3.6> npm run check-ui36`
- [ ] A real DWC 3.6 `build-plugin-pkg` build (not just `check-ui36`) if any `.vue` file changed
- [ ] Hardware, if the reporting user is willing to re-test: D no longer rides to `D_MAX` on their
      ballscrew axis; combined current reads sensibly against known motor current settings; a custom G1
      move can drive the wizard's P/D/I steps; a value that went through a verification backoff shows a
      sane number of decimals

No code-review finding in this repo's history has ever needed "Refine" changed — the user's compliment
about it needs no action, just acknowledgement in the reply to them.

---

## 9. Explicit non-goals — do NOT do these

- **Do not implement an actual cruise-vs-rest frequency-matching auto-suppression filter for D.** No
  ballscrew-affected capture data exists to calibrate it against (same reasoning as the standstill-effort
  plan's deferred D-ripple gate). H.3 ships the report-only half only.
- **Do not make `cruiseRing`'s extended text change severity, score, or the finding's `term`/`direction`
  fields.** It's context appended to an existing finding, not a new verdict.
- **Do not remove or restructure `runAxisCycle`'s positional-parameter style** while adding `dCeiling`
  (H.2). It's already long; a switch to an options object is a real improvement but out of scope here —
  don't couple it to this fix.
- **Do not let a derived capture variable (item I) ever appear in a `variables` bitmask sent to
  firmware**, even accidentally via a "select all" button — filter `derived` out at every recordable-list
  call site (§3.4 lists all of them; check for others before shipping).
- **Do not duplicate `moveMode`/`customMove` into wizard-local state** (item J) — one source of truth,
  shared with the Advanced panel.
- **Do not touch `AUTOTUNE_SIGNAL_SEQUENCE`'s array identity** (H.2) — tests assert term order against
  it by reference (`autorun.test.ts:289`).
