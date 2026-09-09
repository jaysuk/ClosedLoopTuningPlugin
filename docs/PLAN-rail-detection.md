# Plan: model-fit rail detection fires on noise at the first probe

Investigated 2026-09-09 from the tester's 09-06/09-07 field reports (12 runs, same machine, driver 50.0,
axis Y, 1HCL on CAN 50, RRF 3.7.0-beta.3+1).

**Severity: high.** On this machine, 4 of 6 comparable runs threw away the entire P ramp on the first
probe and settled on a P roughly **11× lower** than the two runs that ramped properly — and the two
good runs independently reproduced the same answer. This is not a regression from v2.6.0–2.6.2; it is
pre-existing and was simply invisible until the tester produced enough repeat runs on one profile.

---

## START HERE (implementer handoff)

### Status as of 2026-09-09

- **§1, §2, §3 — IMPLEMENTED and verified.** 500 tests pass (494 + 6 new), `vitest run --typecheck`
  clean, `DWC_DIR` typecheck passes. No `.vue` touched. **Not committed** — awaiting review.
- **§1.4 — DEFERRED by Jay's decision.** Land §1.3's confirmation alone so the field tester's next
  report is unambiguous evidence about which change worked. Do not bundle the threshold move.
- **§4 — TO DO, Jay approved it as a separate commit.** This is the remaining work.
- **§6 — decided: report only, never auto-change the tune.** Scoped as its own follow-up plan.

### Deviation from this plan, made during implementation (§2)

The plan said to surface the seed-rail case as a `note()` finding in `evaluateTune`. **It was
implemented as a distinct log line only.** Reason: `evaluateTune(capture, sampleRateHz, vibration?)` is
a **per-capture** function with no run-level context, and "identification railed at its seed" is a fact
about the *identification run*, not about any one capture. Threading run state into it would widen a
contract that three releases have been spent narrowing. Every other identification fact ("rail onset
at…", "identification incomplete…") already lives in the run log, and the new line sits with them.
If the note is wanted in the evaluation panel later, it needs a proper run-level findings channel —
that is a separate piece of design, not a line to squeeze in here.

### One case this plan did not anticipate (handled in the implementation)

The confirmation capture can itself come back **unstable**. Left unhandled, an unstable-but-not-
saturating confirmation would have been recorded as a clean attempt and the ramp would have climbed
further into instability — a safety regression introduced by the fix itself. The implementation pops
the attempt and routes to the existing `unstable-backoff` path, so the onset is the previous clean
reading, exactly as an unstable primary capture already behaves. Covered by a test.

### Remaining work: §4 only

### A correction to carry into this work

An earlier read of mine claimed `P_TERM_RAIL = 250` is "factually wrong because the clamp is 256".
That framing is wrong and must not drive the implementation. The constant's own doc comment already
says *"the firmware clamps the term around ±256"* — 250 is a **deliberate detection threshold set just
below the clamp**, so that near-clip samples still count as saturated. It is doing its job.

The measurement that the clamp is exactly 256 still stands and is still useful (§4), but
**do not "fix" `P_TERM_RAIL` to 256.** Raising it would make `satDuty()` *stricter*, which would push
the genuinely-clipping runs (sat 1–4%) below `MODEL_FIT_SAT_ONSET = 0.02` and break the rail
detections that currently work correctly. That is the opposite of the intended outcome.

### Do NOT do these

- **Do not change `P_TERM_RAIL`.** See above. It is load-bearing for `satDuty()`, the `±rail × 0.5`
  oscillation gate, `signalUnstable`, cost normalisation, and both `CaptureChart.vue` axis bounds.
- **Do not remove or invert the `||`.** There is a deliberate existing test —
  `"also triggers on saturation duty alone (a noisy accel PEAK can read low while the loop rails)"`
  (`modelfit.test.ts:122`) — covering the case where sat duty is the *only* evidence. That direction
  is sound and must keep working. Only the accel-peak-alone direction is being tightened.
- **Do not just raise `MODEL_FIT_ACCEL_FRACTION` and call it done.** The measured spread (212–219 at
  one P, on one profile) means *any* fixed threshold in that region flips on noise. Moving the
  threshold relocates the coin-flip; it does not remove it.
- **Do not touch the truncation / CAN-bandwidth behaviour here.** Still deferred
  (`PLAN-capture-integrity.md` §7).
- **Do not change `SEED_START`.**

### Verification

```
npm test
npx vitest run --typecheck          # covers src/__tests__/, which the other two do not
DWC_DIR=<real DWC checkout> npm run typecheck
```
No `.vue` files should change, so `verify-build` / `check-ui36` are not required — **unless** you do
§4, which touches nothing visual either. If you find yourself editing a `.vue`, stop: you have
strayed into `P_TERM_RAIL`.

---

## 1. The rail test accepts a single unconfirmed reading of a metric noisier than its own threshold

### 1.1 The evidence

`identifyModelFitP` (`src/model/modelfit.ts:136`):

```ts
if (signal.pTermAccelPeak >= MODEL_FIT_ACCEL_FRACTION * P_TERM_RAIL || signal.pTermSatDuty >= MODEL_FIT_SAT_ONSET) {
    const pStar = round(backoff * value);
    …
    return { result: { pRailOnset: value, pStar, basis: "rail" }, attempts };
}
```

with `MODEL_FIT_ACCEL_FRACTION = 0.85`, `P_TERM_RAIL = 250` → threshold **212.5**.

Isolating to one identical capture profile (1000 Hz, 2000 samples, 200 mm at F24000, same axis, same
driver) removes every confound. The first probe is always `SEED_START = 30`:

| run (2026-09-…) | P=30 accel-peak | sat duty | decision | final P | grade | refine rms |
|---|---|---|---|---|---|---|
| 06t19-44-24 | 219 | 0% | rail at P=30 | ~24 | fair 79 | ~1.1–5.0 |
| 06t20-39-32 | 216 | 0% | rail at P=30 | 24.38 | fair 79 | ~1.1–5.0 |
| 07t12-54-55 | 213 | 0% | rail at P=30 | 30 | fair 79 | — |
| 07t12-23-42 | **212** | 0% | **ramp continues** | **340.95** | **good 85** | **0.07** |
| 07t12-20-47 | **212** | 0% | **ramp continues** | **340.95** | **good 85** | **0.07** |

(A sixth run, 07t12-32-28, at 700 Hz/F24000 read 213 → false rail → P=27.43.)

Three facts make this conclusive:

1. **The threshold sits inside the metric's noise band.** 212.5 lies between 212 and 213. The metric's
   own spread on one unchanged setup is 212–219.
2. **Sat duty is 0% in every one of those runs** — the actuator is demonstrably *not* clipping in any
   of them. The corroborating signal disagrees with the triggering one, and cannot veto it.
3. **The two runs that continued are separate runs** (verified: different file hashes) that independently
   reached P\* = 340.95 and graded good 85. The good outcome is reproducible; the bad one is a coin flip.

The profile confound is genuinely excluded: the runs that read **256** at P=30 (and correctly railed,
with sat 1–4%) are all **F36000** — a faster move, higher accel demand, real clipping. Measured across
777,536 samples from every capture in every report, `max |PID P Term|` is exactly **256.0**, with 7,599
samples pinned at 256 and **none above**. So 256 = genuine clip, 212–219 = ordinary non-clipping peak.

### 1.2 Why it fails so badly when it fires

A rail call at the first probe has no prior clean reading, so the `unstable-backoff` path cannot help;
`attempts` is empty. `pStar` collapses to `backoff × SEED_START` = `0.65 × 30` = **19.5** — a number
derived entirely from the seed constant, containing no information about the machine at all.

### 1.3 The fix — make the two signals asymmetric, because the evidence they carry is asymmetric

- `satDuty >= MODEL_FIT_SAT_ONSET` is **strong** evidence: samples are actually pinned at the clamp.
  Keep it as an immediate, unconfirmed trigger. (Preserves the `modelfit.test.ts:122` test.)
- `accelPeak >= threshold` **with sat duty below onset** is **weak** evidence: a single noisy peak with
  no clipping anywhere. Require it to be confirmed by a second capture at the same P before accepting.

Sketch (`identifyModelFitP`, replacing the block at `modelfit.ts:136`). Note `railAt` is a small local
helper you need to add — it did not exist before; it just factors out the existing log-and-return so
both call sites stay identical in wording:

```ts
const railThreshold = MODEL_FIT_ACCEL_FRACTION * P_TERM_RAIL;
const railAt = (p: number, s: TuneSignal): ModelFitPOutcome => {
    const pStar = round(backoff * p);
    effects.log(`Model fit: rail onset at P=${p} (accel P-term ${s.pTermAccelPeak.toFixed(0)}/${P_TERM_RAIL}, sat ${(s.pTermSatDuty * 100).toFixed(0)}%) — backing off ${(backoff * 100).toFixed(0)}% to P*=${pStar}.`);
    return { result: { pRailOnset: p, pStar, basis: "rail" }, attempts };
};

const satRail = signal.pTermSatDuty >= MODEL_FIT_SAT_ONSET;
const peakRail = signal.pTermAccelPeak >= railThreshold;

if (satRail) {
    return railAt(value, signal);              // strong evidence: samples really are pinned at the clamp
}
if (peakRail) {
    // Weak evidence: a single-capture accel PEAK whose run-to-run spread is wider than the
    // threshold's own margin (field: 212-219 at one P on one profile, threshold 212.5), with
    // nothing actually clipping. Confirm before throwing the rest of the ramp away.
    effects.log(`Model fit: P=${value} accel P-term ${signal.pTermAccelPeak.toFixed(0)} reached the rail fraction but nothing is saturating (sat ${(signal.pTermSatDuty * 100).toFixed(0)}%) — re-measuring to confirm.`);
    const confirm = await captureMedian(effects, medianOf);
    if (!confirm) { effects.log("Model fit: confirmation capture failed."); return { result: null, attempts }; }
    if (confirm.pTermAccelPeak >= railThreshold || confirm.pTermSatDuty >= MODEL_FIT_SAT_ONSET) {
        attempts[attempts.length - 1] = { value, signal: confirm };
        return railAt(value, confirm);
    }
    effects.log(`Model fit: not confirmed (${confirm.pTermAccelPeak.toFixed(0)}) — treating P=${value} as clean and continuing the ramp.`);
    attempts[attempts.length - 1] = { value, signal: confirm };
}
// (unchanged) if (value >= P_MAX) { break; }  →  value = Math.min(nextRampValue(value), P_MAX);
```

Notes for the implementer:

- `attempts.push({ value, signal })` currently happens **before** the rail check — keep that ordering,
  and on either confirmation outcome overwrite the last entry with `confirm`, as sketched. Record
  `confirm` (not the lower or the median of the pair): it is the reading the ramp actually acted on, so
  the `extrapolateRailOnset` tail stays consistent with the decision that was made. Do not try to be
  clever here — "keep the lower reading" sounds conservative but actually *flattens* the tail, which
  extrapolates the onset **higher** and yields a less conservative P.
- **There is no capture budget to respect inside this function.** `identifyModelFitP(effects, medianOf,
  backoff)` receives none; the loop is bounded solely by `MODEL_FIT_MAX_ATTEMPTS = 14` ramp steps, and
  a confirmation capture does not consume a ramp step. So the cost is exactly one extra capture, only
  when the two signals disagree. Do not invent a budget check.
- Keep the rail log line's existing wording/format (that is why `railAt` factors it out rather than
  rewording it); the field diagnostics are read by eye against that format.

### 1.4 Optional hardening (same section, low risk)

Express the accel fraction against the **true** clamp rather than the detection threshold, so the
constant means what its name says — "fraction of the actuator's real ceiling":

```
MODEL_FIT_ACCEL_FRACTION * P_TERM_CLAMP  = 0.85 × 256 = 217.6
```

This alone would have prevented 2 of the 4 false calls (213, 216) but not the third (219) — which is
exactly why §1.3's confirmation, not threshold-shifting, is the primary fix. Do this only *with* §1.3,
never instead of it.

---

## 2. A rail declared at the seed value is not a measurement — say so

When `basis === "rail"` and `pRailOnset === SEED_START`, the identification has produced
`0.65 × SEED_START` and learned nothing about the plant. Even after §1.3 this can legitimately happen
(a genuinely weak actuator that really does clip at P=30 — the F36000 runs are real examples).

- Log it distinctly: the ramp never got off its seed, so P\* is seed-derived, and the move profile may
  be too aggressive for this axis (suggest a slower `F` for the tuning move).
- Surface it as a non-scoring `note()` finding in `evaluateTune` — the channel added in
  `PLAN-capture-integrity.md` §3 exists precisely for "the user should know this" without inventing a
  score penalty.

---

## 3. Log the accel-peak and sat duty on every ramp step

`describeSignal` already prints `accel pk` and `sat N%`, which is how this whole investigation was
possible — but sat duty is printed **only when non-zero**, so "212, sat 0%" and "212, sat absent"
are indistinguishable in a report. Print sat duty unconditionally on model-fit ramp lines. One line
of formatting; it is what made this bug diagnosable and what will confirm the fix in the field.

---

## 4. OPTIONAL — separate commit, do last: the describing-function relay amplitude

`autorun.ts:282` computes Ku from the relay describing function:

```ts
const ku = (4 * P_TERM_RAIL) / (Math.PI * signal.oscAmplitude);
```

Here `P_TERM_RAIL` is standing in for `d`, the relay's **half-amplitude** — which is physically the
clamp (256), not the detection threshold (250). Ku is therefore underestimated by ~2.4%.

This is a genuine but small correctness issue in a *different* meaning of the same constant. If you do
it: add `export const P_TERM_CLAMP = 256;` in `analysis.ts` (documented as measured — 777,536 field
samples, max exactly 256.0, none above), use it **only** at `autorun.ts:282` and, if §1.4 is taken, in
the model-fit accel fraction. Leave `satDuty`, the oscillation gate, `signalUnstable`, cost
normalisation and the chart bounds on `P_TERM_RAIL`.

`autorun.test.ts:501` asserts `(4 * 250) / (Math.PI * 2)` and will need updating — read it first and
confirm you are changing the expectation for the right reason, not bending the test to fit.

**Decided 2026-09-09: do it, as its own commit.** (My recommendation had been to skip; Jay's call is to
fix the physics error while it is understood, isolated so it can be reverted independently if seeds
shift unexpectedly.) Keep it strictly separate from the §1 commit — the whole point is that the field
tester's next report can attribute any change to one or the other.

---

## 5. Tests (`src/__tests__/modelfit.test.ts`)

Add to `describe("identifyModelFitP")`:

1. **The field regression.** Accel-peak 216 with sat duty 0 on the first probe, then lower readings
   afterwards → must **not** return `basis: "rail"` at P=30; must continue ramping.
2. **Confirmed rail still works.** Accel-peak above threshold with sat 0 on two consecutive captures
   at the same P → returns `basis: "rail"` at that P.
3. **Sat duty still triggers unconfirmed.** The existing `modelfit.test.ts:122` test must pass
   unchanged — do not edit it.
4. **Genuine clipping at the seed.** Accel-peak 256 with sat 4% at P=30 → rails immediately at P=30,
   no confirmation capture spent (assert the capture count).
5. **Confirmation capture failing** → returns `{ result: null }` cleanly, with `attempts` preserved.
6. **§2's note**, if implemented: rail at `SEED_START` produces the distinct log line.

Assert capture counts in 1, 2 and 4 — the point is that the extra capture is spent only when the
signals disagree.

---

## 6. Envelope validity — "should we tune at max speed, like input shaping?"

**A tune is only valid for the envelope it was identified at.** The same P=30 that peaks at 212 under
F24000 genuinely clips at 256 under F36000. An axis that identifies P\*=340.95 from a gentle tuning
move will saturate hard when the machine prints at higher acceleration.

### 6.1 Why the input-shaping analogy only half-transfers

Input shaping runs at high accel to get **excitation energy** — SNR on a resonance that is, to first
order, linear and amplitude-independent. You are measuring a property that does not itself move when
you change the envelope.

The rail is the opposite: it is a **nonlinearity**, and the thing being measured genuinely moves with
the envelope. So the argument for tuning at the operating envelope is actually *stronger* than the
input-shaping one — it is about validity, not signal strength. The instinct is right.

### 6.2 But the naive version is already in the field data, and it fails

The tester's **F36000 runs are** the "tune at max speed" experiment. Result: accel-peak **256 with sat
1–4% at the very first probe (P=30)** → immediate rail at the seed → P\* = 19.5 → no information about
the plant at all. That is precisely the degenerate case §2 exists to flag.

The reason is structural: model-fit works by ramping P through an **unsaturated** region and watching
the accel P-term climb toward the clamp. If the envelope is aggressive enough that the seed already
clips, there is no unsaturated region to ramp through and the method has nothing to measure.

There is a second reason to be careful. Much of the loss of authority at high velocity is **back-EMF** —
available torque falls with speed. The correct remedy for that is velocity feedforward (**V**), which
model-fit already solves for *after* P. Reducing P because the axis saturates at speed would be pulling
the wrong lever.

### 6.3 Recommended shape: identify where the ramp can breathe, validate at the envelope

1. **Identify at a moderate profile** (status quo) so the P ramp has unsaturated headroom and produces
   a real, informative rail.
2. **Add a final validation capture at the axis's configured limits** (`M201`/`M203` from the object
   model). Check `pTermSatDuty` there. If it clears `MODEL_FIT_SAT_ONSET`, the tune does not hold across
   the envelope — report it, and de-rate P until it does.
3. **Record the identification envelope** (F, accel) alongside the result, so a stored tune carries the
   conditions it is valid for.

This fits the machinery that already exists: there is already a final verification capture at the end of
a run, so (2) is an extra profile on an existing step rather than new plumbing. It also keeps the
saturation question where it belongs — as a *check*, not as the thing the search is groping for.

### 6.4 Still Jay's call

Whether de-rating in (2) should be automatic or advisory, and whether "max" should mean the axis's
configured `M201`/`M203` or a user-entered print envelope (a slicer rarely uses the configured
maximum), are product decisions. Not assumed here. **§6 is not part of the §1 implementation** — it is
scoped as its own follow-up plan once §1 lands.

---

## 7. What this does not address

- Capture truncation / CAN bandwidth on the 1HCL — still `PLAN-capture-integrity.md` §7. The 2400 Hz
  F36000 run in this data set failed model-fit entirely (three captures truncated to 136/238/339
  samples) and fell through to the legacy P stage; that is the truncation problem, not this one.
- CoreXY motor isolation — still `PLAN-corexy-coupling.md`, blocked on the object model not exposing a
  remote driver's mode.
