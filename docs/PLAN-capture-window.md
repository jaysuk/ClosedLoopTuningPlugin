# Plan: capture window, truncation, and the invalid-rest-tail cost bias

**Status:** ready to implement. Written 2026-09-06 from a forum report of inconsistent auto-tune results
(three back-to-back runs on the same axis giving P19.5/D0.147, P24.38/D0.18, P19.5/D0.01 — Fair/Poor/Fair).

**Evidence base:** the reporter's three diagnostic reports, analysed with this plugin's own code (not by
eye). 82 real captures, Duet 3 1HCL @ CAN 50, RRF 3.7.0-beta.3+1, DWC 3.7.0-beta.3, CoreXY Y axis,
sequential / model-fit / Tyreus-Luyben, 3 cycles. Every number in §2 came out of running
`parseCapture` → `computeTuneSignal` / `computeRestEffort` / `signalCost` over those captures.

---

## START HERE (implementer handoff)

### The correction that reframes this whole report

**The reporter's headline hypothesis is wrong, and so was the first reply they got.** They observed a real
sample interval of 0.24 ms (~4167 Hz) with the UI set to 2000/2000, and concluded the 1HCL was ignoring
M569.5's `R` parameter and free-running at its maximum rate.

It is not. **The plugin asked for ~4167 Hz**, and the board delivered it.

Auto-tune does not use the UI's rate box when the A/V test move Distance is `0` (= auto). In that mode
`planCaptureProfile` (`limits.ts`) *derives* the rate from the move's own duration:

```
windowS       = moveTimeS / (1 - CAPTURE_REST_FRACTION_DEFAULT)   // restFraction 0.3
effectiveRate = samples / windowS
```

For this axis: move ends at 0.344 s (measured), so `windowS ≈ 0.48 s`, so
`effectiveRate = 2000 / 0.48 ≈ 4167 Hz`. That is exactly the observed rate. Confirmed the other way too:
in *explicit* mode (Distance > 0) the rate would have been `min(2000, 5000) = 2000 Hz` → a 0.5 ms
interval, which is **not** what the data shows. So the reporter had Distance = 0, the derived-rate path
ran, and `R` was honoured.

**Do not "fix" the R parameter. There is nothing wrong with it.** The real defects are below, and they are
all on the plugin's side.

### What is actually wrong

Three separate defects, in descending order of impact on tuning quality:

1. **A cost-function bias that rewards unmeasurable captures** (§3). When a capture's rest tail can't be
   judged, its rest-effort cost term is set to `0` — which is *better* than a perfectly settled capture
   scores. Verified on a repo fixture: the same capture, with only its tail marked unjudgeable, reads as a
   **38% improvement** against a 5% acceptance threshold, and `significantlyBetterForTerm` returns `true`
   for it today. 43% of the reporter's captures hit this path.
2. **A rest tail too short for the integrator to converge** (§4), which is what pushes so many captures
   into that path. 29 of 82 captures had an unsettled integrator at the end of the window.
3. **A derived rate high enough to overrun the 1HCL's capture buffer** (§5) — 10 of 82 captures truncated.

Fix them in that order; each is independently useful. §3 is the one that explains run-to-run
inconsistency, and it is a pure-model change with no hardware dependency.

### Verification for every phase

```
npm test
DWC_DIR="C:/Users/live/Documents/Github/DuetWebControl" npm run typecheck
```
No `.vue` files change in §3-§5, so `verify-build`/`check-ui36`/a 3.6 build are not required for those.
§6 (report fields) touches no `.vue` either. `npm test` alone is NOT sufficient — vitest does not
structurally type-check, which is how a `medianSignal`/`TuneStats` mismatch shipped once before.

**Do not commit to `main` and do not push** without being asked — this repo pushes straight to
`origin/main`, so a push is immediately public.

---

## 1. How the numbers in this plan were produced

Reproduce any of them by loading a report's `state.captures[]`, parsing each `csv` field, and running the
plugin's own functions. The reports embed the full CSV for every capture (`includeAllCsv` was on).

```ts
const d = JSON.parse(readFileSync(reportPath, "utf8"));
for (const c of d.state.captures) {
  const cap = parseCapture(c.csv);
  const sig = computeTuneSignal(cap, 2000);   // the nominal rate the plugin passes
  const re  = computeRestEffort(cap, 2000);
  // …
}
```

**The nominal rate argument is very nearly inert** and that is worth knowing before touching anything:
`timeAxisSeconds` (`csv.ts:83`) uses the real `Timestamp` column whenever it is present and non-zero, so
`buildSeries`, `segmentMove`, `tuneStats`, `analyzeMove`, `computeRestEffort` and `oscPeriod` all run on
real measured time. The only use of the passed rate is `segmentMove`'s `dtOf` fallback for a zero time
delta. **So the rate mismatch did not corrupt any timing maths** — rise time, overshoot, ringing and ITAE
are all trustworthy in these reports. The damage is entirely from the window being *short*, not from the
maths being mis-scaled. Do not go looking for scaling bugs; there aren't any.

## 2. Measured facts (all 82 captures, all three runs)

| fact | value |
|---|---|
| Real sample interval | 0.240 ms median, on every capture |
| Real rate | 4167 Hz |
| Largest gap between consecutive samples | 0.33 ms (i.e. **no mid-capture gaps** — see below) |
| Capture window actually spanned | 0.474 s |
| Move ends at | 0.344 s |
| Rest tail available | **0.13 s** |
| Captures truncated by firmware | 10 / 82 (12%) |
| Captures with `restTailValid: false` | **35 / 82 (43%)** |
| …because the tail had < 25 samples | 6 |
| …because the **integrator had not converged** | **29** ← dominant cause |
| Captures rejected by existing validation | **0** |

**Truncated captures are short, not corrupt.** Max inter-sample gap is 0.33 ms on truncated and clean
captures alike, so the firmware cut the data off at the *end*; it did not drop samples from the middle.
That matters: a truncated capture's remaining rows are perfectly good data over a shorter window, and
throwing the whole capture away (an obvious-looking fix) discards real measurements for no reason.

## 3. Defect A — the cost function rewards a capture it cannot judge  ⬅ **implement first**

### 3.1 The mechanism

`signalCost` (`signal.ts:213`):

```ts
const effortCost = restEffort.restTailValid ? restEffort.pTermRestRipple / P_TERM_RAIL : 0;
return stats.moveRms
  + COST_WEIGHT_OVERSHOOT * stats.settleOvershoot
  + COST_WEIGHT_BIAS  * Math.abs(stats.restBias)
  + COST_WEIGHT_LAG   * Math.abs(stats.cruiseLag)
  + COST_WEIGHT_RING  * Math.max(0, stats.restRing - COST_RING_FREE)
  + COST_WEIGHT_REST_EFFORT * effortCost;   // COST_WEIGHT_REST_EFFORT = 1.5
```

Substituting `0` for an unjudgeable tail was a deliberate, well-commented choice ("contribute nothing
rather than penalise an attempt that can't be judged") and it is *locally* reasonable. The problem is what
it does in a **comparison**: `0` is not neutral, it is the best possible value of that term. A capture
whose tail could not be measured therefore scores strictly better than one that was measured and found
perfectly settled.

**This is not theoretical — it flips a real decision today.** Reproduce it in one script against a
fixture already in this repo (`hold-dither-i0.csv`, a genuine dithering capture):

```
real dithering capture:        restTailValid = true   ripple = 33.6   cost = 0.5264
same capture, tail unjudgeable:                                       cost = 0.3248

apparent improvement the optimiser sees: 0.2016  →  38.3%   (COST_RELATIVE_PLATEAU is 5%)

significantlyBetterForTerm("p", dither, unjudged)  ===  true   ← accepts a change that improved nothing
significantlyBetter(dither, unjudged)              ===  true
```

The two signals are the *same capture*. The only difference is that one's rest tail happened to be
unjudgeable. The optimiser reads that as a **38% improvement** — more than seven times the 5% threshold
needed to accept a new PID value — and accepts it.

On the reporter's own captures the same effect is worth up to **+0.96** of hidden cost (run 3, seq 8,
phase `d`, rest ripple 160.0 against a `REST_EFFORT_RIPPLE_LIMIT` of 10), ~9% of their typical total cost
of ~11.0.

Whether a given capture gets a valid tail is essentially luck (§4), so this is a sufficient mechanism for
three identical runs to diverge — exactly what was reported.

> Honesty note for whoever implements this: invalid-tail captures also had a lower *mean* total cost in
> this data (9.23 vs 11.04, n=30/45). Do **not** cite that as proof of the bias — truncated captures are
> shorter and differ in other ways too, so that comparison is confounded. The mechanism above, and the
> +0.96 measurement, are the real evidence.

### 3.2 The fix

Make an unjudgeable tail **neutral in comparison** rather than optimal. Compare only on terms that all
candidates actually have.

In `signal.ts`, add alongside `signalCost`:

```ts
/**
 * Whole-capture cost EXCLUDING the standstill rest-effort term — the same ordering `signalCost` gives
 * when no candidate has a measurable rest tail.
 *
 * Exists because substituting 0 for an unmeasurable tail (which is what signalCost does) is not neutral
 * in a COMPARISON: 0 is the best attainable value of that term, so a capture whose tail could not be
 * judged outscores one that was measured and found perfectly settled. Measured on real hardware: a
 * capture with 160.0 rest ripple contributed +0.00 where it would have contributed +0.96, against a
 * 5% (COST_RELATIVE_PLATEAU) threshold for accepting a new value — see docs/PLAN-capture-window.md §3.
 */
export function signalCostNoEffort(s: TuneSignal): number {
	if (signalUnstable(s)) { return Infinity; }
	const { stats } = s;
	return stats.moveRms
		+ COST_WEIGHT_OVERSHOOT * stats.settleOvershoot
		+ COST_WEIGHT_BIAS * Math.abs(stats.restBias)
		+ COST_WEIGHT_LAG * Math.abs(stats.cruiseLag)
		+ COST_WEIGHT_RING * Math.max(0, stats.restRing - COST_RING_FREE);
}

/**
 * The cost function to use when ranking `candidates` against each other: the full `signalCost` when every
 * candidate has a measurable rest tail, and the effort-free variant when any of them does not. Ranking a
 * mixed set on the full cost is what lets an unmeasurable capture win on a term it never earned.
 */
export function comparableCost(candidates: Array<TuneSignal>): (s: TuneSignal) => number {
	return candidates.every((c) => c.restEffort.restTailValid) ? signalCost : signalCostNoEffort;
}
```

`signalCost` itself stays exactly as it is — it is still the right single-capture score, and it is what
reporting and absolute thresholds use. Only head-to-head ranking changes.

**The real call sites.** Every tuning decision funnels through two pairwise comparators plus one reduce —
these are the only places to change, and all four probe sites in `autorun.ts`/`optimize.ts` are reached
through the second one:

```ts
// signal.ts — replace the body of the existing significantlyBetter:
export function significantlyBetter(prev: TuneSignal, cur: TuneSignal): boolean {
	return significantlyBetterBy(comparableCost([prev, cur]), prev, cur);
}

// signal.ts — termAwareCost gains an optional base, defaulting to today's behaviour:
export function termAwareCost(term: string, s: TuneSignal, base: (x: TuneSignal) => number = signalCost): number {
	const cost = base(s);
	if (!Number.isFinite(cost)) { return cost; }
	if (term === "v") { return cost + TERM_COST_WEIGHT * (Math.abs(s.pTermCruiseMean) / P_TERM_RAIL); }
	if (term === "a") { return cost + TERM_COST_WEIGHT * (s.pTermAccelPeak / P_TERM_RAIL); }
	return cost;
}

// signal.ts — this is what autorun.ts:584/601 and optimize.ts:152/160 all call:
export function significantlyBetterForTerm(term: string, prev: TuneSignal, cur: TuneSignal): boolean {
	const base = comparableCost([prev, cur]);
	return significantlyBetterBy((s) => termAwareCost(term, s, base), prev, cur);
}
```

```ts
// modelfit.ts:156 — ranks N attempts at once, so it needs the array form:
const cost = comparableCost(attempts.map((a) => a.signal));
const best = attempts.reduce((acc, a) => (cost(a.signal) < cost(acc.signal) ? a : acc), attempts[0]);
```

**No changes are needed in `autorun.ts` or `optimize.ts` themselves** — they only ever call
`significantlyBetterForTerm`, so fixing it fixes all four probe sites. `withinNoise` picks the fix up for
free through `significantlyBetter`.

Do **not** change `COST_WEIGHT_REST_EFFORT`, `COST_RELATIVE_PLATEAU`, `TERM_COST_WEIGHT`, or any other
weight. This change is about *which* terms are compared, not how they are weighted, and the weights were
calibrated against real captures in `docs/PLAN-standstill-effort.md`.

### 3.3 Tests (`src/__tests__/signal.test.ts`)

These use exact numbers measured against the real fixture — they are not estimates. If one fails, the
implementation drifted; do not "fix" it by updating the expectation.

```ts
const dither = computeTuneSignal(load("hold-dither-i0.csv"), 2000)!;
// The same capture, differing ONLY in whether its rest tail could be judged. Nothing physically changed.
const unjudged = { ...dither, restEffort: { ...dither.restEffort, restTailValid: false } };

it("does not let an unmeasurable rest tail outscore the very same capture measured", () => {
	// The bug, pinned: on the full cost the unjudgeable copy looks 38% better than the original.
	expect(signalCost(dither)).toBeCloseTo(0.5264, 3);
	expect(signalCost(unjudged)).toBeCloseTo(0.3248, 3);
	// The fix: compared against each other, they are judged only on terms both actually have — equal.
	const cost = comparableCost([dither, unjudged]);
	expect(cost(unjudged)).toBeCloseTo(cost(dither), 10);
});

it("still uses the full cost when every candidate has a measurable tail", () => {
	expect(comparableCost([settledA, settledB])).toBe(signalCost);
});

// The bias reached decisions through this wrapper — all four probe sites in autorun.ts/optimize.ts
// call it, so this is the test that proves the actual tuning path is fixed, not just the cost helper.
// Both of these return TRUE before the fix (verified 2026-09-06) — that is the whole defect.
it("significantlyBetterForTerm does not accept a candidate that only wins on an unjudgeable tail", () => {
	expect(significantlyBetterForTerm("p", dither, unjudged)).toBe(false);
});

it("significantlyBetter does not either", () => {
	expect(significantlyBetter(dither, unjudged)).toBe(false);
});

it("signalCostNoEffort matches signalCost when there is no rest-effort contribution", () => {
	const zeroRipple = /* restTailValid: true, pTermRestRipple: 0 */;
	expect(signalCostNoEffort(zeroRipple)).toBeCloseTo(signalCost(zeroRipple), 10);
});
```

Build the fixtures from the real files already in the repo (`hold-dither-i0.csv` is a genuine dithering
capture, `hold-settled-i23.csv` a genuine settled one — both used this way in `report.test.ts`), rather
than hand-writing `TuneSignal` objects, so the numbers stay real.

## 4. Defect B — the rest tail is too short for the integrator to settle

29 of 82 captures had `restTailValid: false` purely because `computeRestEffort`'s `iConverged` check found
the I term still visibly moving at the end of the window. With only 0.13 s of rest after the move, that is
unsurprising — and it is the upstream cause of most of §3's exposure.

`CAPTURE_REST_FRACTION_DEFAULT = 0.3` (`limits.ts:244`) reserves 30% of the window for rest. As a
*fraction* it scales with the move, so a short move gets a short tail: 0.344 s of move buys 0.13 s of rest,
which is not enough time for an integrator to converge regardless of how many samples land in it.

**Fix:** give the rest tail an absolute floor as well as a fractional one, in `planCaptureProfile`'s auto
branch:

```ts
/** Minimum absolute at-rest time in an auto-planned capture window, on top of CAPTURE_REST_FRACTION_
 *  DEFAULT's proportional share. A fraction alone gives a short move a short tail — measured on real
 *  hardware: a 0.344 s move left 0.13 s of rest, in which the integrator had not converged on 29 of 82
 *  captures, so `restTailValid` came back false and those captures' rest-effort term silently dropped out
 *  of the cost comparison (docs/PLAN-capture-window.md §3, §4). */
export const AUTO_REST_MIN_S = 0.5;   // PROVISIONAL — see §4.1
```

```ts
if (auto) {
	windowS = Math.max(moveTimeS / (1 - restFraction), moveTimeS + AUTO_REST_MIN_S);
	effectiveRate = samples / windowS;
	// …unchanged from here
}
```

Note the knock-on, which is desirable: a longer window with the same `samples` **lowers** the derived
rate (0.844 s → 2370 Hz instead of 4167 Hz), which also reduces the CAN load behind §5's truncation.

### 4.1 `AUTO_REST_MIN_S` needs one hardware check before it is final

0.5 s is a starting value, not a measured one: it is ~4x the 0.13 s that demonstrably failed, and it keeps
the derived rate for the reporter's move (2370 Hz) below the ~4167 Hz that was truncating. It is **not**
calibrated against how long a Duet integrator actually takes to converge, because no capture in hand has a
long enough tail to measure that.

Confirm it with one capture that has a deliberately long tail, then set the constant from the measurement:

```
; Distance 0 (auto) in the UI, then one manual capture with a long window:
M400 M569.5 P50.0 S2000 A1 R1000 D46 G91 G1 H2 Y20 F6000 G90
```
2000 samples at 1000 Hz = a 2 s window for a ~0.35 s move, i.e. ~1.65 s of rest tail. Run
`computeRestEffort` over it and find the shortest tail length for which `iConverged` is true; set
`AUTO_REST_MIN_S` to roughly double that. Until that is done, ship 0.5 s and say in the changelog that it
is provisional.

## 5. Defect C — the derived rate can overrun the 1HCL's capture buffer

10 of 82 captures were truncated (`Data lost`, stripped by `csv.ts`), at 4167 Hz with **17 columns**
recorded (`ALL_CAPTURE_KEYS` — auto-tune records every available variable so the chart has full overlay
data). That is ~71 k values/second streamed off the driver board over CAN; truncation was intermittent,
so the setup is sitting right at the edge of what it can sustain.

`AUTO_RATE_CEILING_HZ = 5000` (`limits.ts:42`) is the guard for exactly this and it is simply too high for
this board once every column is recorded. `rateCeilingForBoard` currently only special-cases the RP2350
(`MNBN17R1_5` → 500 Hz).

**Fix — make the ceiling account for how many columns are being streamed**, since bandwidth is
`rate × columns`, not rate alone:

```ts
/** Values/second a board can stream off its own driver without overrunning the capture buffer. The
 *  ceiling that matters is bandwidth, not rate: a capture recording all 17 variables at 4167 Hz is
 *  ~71k values/s, which intermittently truncated on a real 1HCL (10 of 82 captures — see
 *  docs/PLAN-capture-window.md §5), while the same rate with 3 columns is fine. */
export const AUTO_VALUE_RATE_CEILING = 40000;

/** Rate ceiling for a capture recording `columns` variables — the lower of the board's own rate ceiling
 *  and what its bandwidth allows for that many columns. */
export function rateCeilingForCapture(shortName: string | null | undefined, columns: number): number {
	const byBoard = rateCeilingForBoard(shortName);
	const byBandwidth = columns > 0 ? AUTO_VALUE_RATE_CEILING / columns : byBoard;
	return Math.max(AUTO_RATE_FLOOR_HZ, Math.min(byBoard, byBandwidth));
}
```

`40000 / 17 ≈ 2353 Hz` for a full auto-tune capture — close to what §4's longer window derives anyway, and
comfortably under the observed truncation threshold. A 3-column manual capture still gets the full
board ceiling.

Wire it in `useClosedLoopTuning.ts`'s `captureRaw`, which already knows the column count:

```ts
const profile = planCaptureProfile(freshCoupled, avFeed.value, samples.value, sampleRate.value, marginMm.value, {
	maxDistanceMm: avDistance.value,
	rateCeilingHz: rateCeilingForCapture(selectedBoard.value?.shortName ?? null, ALL_CAPTURE_KEYS.length),
});
```

### 5.1 `AUTO_VALUE_RATE_CEILING` is also provisional

40000 is derived from one data point: 17 columns × 4167 Hz ≈ 71k truncated intermittently, so the safe
ceiling is meaningfully below that. It has not been bisected. If a hardware session is available, capture
at 17 columns and rates of 2000 / 3000 / 3500 / 4000 Hz and find where `Data lost` first appears; set the
constant to ~60% of that. Note it as provisional in the changelog either way.

## 6. Defect D — the report cannot answer "what was actually sent?"

The reporter had to reverse-engineer the sample rate from raw CSV timestamps because nothing in the
diagnostic report records the command. That is a real gap, and their suggestion is a good one.

In `useClosedLoopTuning.ts`, log the capture command into the session log the first time each distinct one
is issued, and add the resolved profile to `optionsUsed`:

```ts
// In captureRaw, immediately after planCaptureProfile succeeds:
log(`Capture profile: ${profile.samples} samples @ ${profile.sampleRateHz.toFixed(0)} Hz `
	+ `(${(profile.samples / profile.sampleRateHz).toFixed(3)} s window, ${profile.moveTimeS.toFixed(3)} s move, `
	+ `${profile.restTimeS.toFixed(3)} s rest), ${profile.distance.toFixed(1)} mm at F${avFeed.value}`
	+ `${profile.limitedBy ? `, limited by ${profile.limitedBy}` : ""}.`);
```

This one line would have shown `4167 Hz` immediately and made the whole investigation unnecessary. Log it
once per phase rather than per capture (dozens of identical lines is why the log is capped) — gate it on
the profile actually differing from the last one logged.

Also add the achieved-vs-requested check, which is cheap now that the real rate is easy to measure:

```ts
/** Rate the firmware actually sampled at, from the capture's own Timestamp column (ms). Null when the
 *  column is missing or unusable. The requested rate is a REQUEST — this is what happened. */
export function achievedRateHz(capture: ParsedCapture): number | null {
	const ts = column(capture, "Timestamp");
	if (!ts || ts.length < 10) { return null; }
	const gaps: Array<number> = [];
	for (let i = 1; i < ts.length; i++) {
		const dt = ts[i] - ts[i - 1];
		if (Number.isFinite(dt) && dt > 0) { gaps.push(dt); }
	}
	if (gaps.length < 5) { return null; }
	gaps.sort((a, b) => a - b);
	const median = gaps[Math.floor(gaps.length / 2)];
	return median > 0 ? 1000 / median : null;
}
```

Warn only on a real divergence (>20%), once per run, so a board that quantises the rate slightly doesn't
spam the log.

## 7. Non-goals — do NOT do these

- **Do not touch M569.5's `R` parameter or `buildCaptureCommand`.** `R` is honoured; see START HERE.
- **Do not reject truncated captures.** They are short, not corrupt (§2) — max inter-sample gap is the
  same as on clean captures. `MIN_CAPTURE_SAMPLES` (50) already rejects the genuinely unusable ones, and
  `captureMedian` already retries a null signal twice (`CAPTURE_RETRIES`). Adding a truncation rejection
  on top mostly discards good data, and if truncation were ever systematic it would turn every capture
  into a failed run instead of a slightly shorter one.
- **Do not change `restTailValid`'s definition**, `REST_TAIL_MIN_SAMPLES`, `REST_TAIL_FRACTION`, or
  `I_SETTLED_TOL_FRACTION`. The flag is correct — it is reporting a real problem. §4 fixes the cause.
- **Do not remove the `restTailValid` guards** in `autotune.ts:364`, `evaluate.ts:215`, `wizard.ts:123`,
  `report.ts:81`. They are all correct; only `signalCost`'s use in head-to-head ranking is the problem.
- **Do not change any cost weight** (`COST_WEIGHT_*`, `COST_RELATIVE_PLATEAU`, `REST_EFFORT_RIPPLE_LIMIT`).
  They were calibrated against real captures in `docs/PLAN-standstill-effort.md`.
- **Do not assume the nominal rate argument scales any analysis.** It does not (§1) — the timing maths
  reads the real `Timestamp` column.
- **Do not ship `AUTO_REST_MIN_S` or `AUTO_VALUE_RATE_CEILING` as if they were measured.** Both are
  reasoned starting values (§4.1, §5.1). Say so in the changelog.

## 8. Suggested order

| # | Change | Risk | Hardware needed |
|---|---|---|---|
| 1 | §3 cost comparison (`signalCostNoEffort` + `comparableCost`) | low, pure model, fully testable | no |
| 2 | §6 profile logging + `achievedRateHz` | very low, observability only | no |
| 3 | §4 `AUTO_REST_MIN_S` | medium — changes every auto-planned capture | to finalise the constant |
| 4 | §5 `rateCeilingForCapture` | medium — changes every auto-planned capture | to finalise the constant |

1 and 2 are safe to ship together and are worth shipping regardless of the hardware follow-up: 1 is the
one that addresses the reported symptom, and 2 is what makes the next report of this kind diagnosable in
one line instead of a day of CSV archaeology.
