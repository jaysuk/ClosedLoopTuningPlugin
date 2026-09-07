# Plan: capture integrity — three confirmed bugs, plus two feature requests

**Status:** §1, §2, §3, and §5 implemented 2026-09-07. 494 tests pass (up from 490 — 10 new/changed), DWC
3.7 typecheck clean, no `.vue` files touched. §4 remains **deliberately unimplemented** — it is scoped,
but blocked on a product decision (§4.2) that this session did not make on its own, per the plan's own
instruction.

**Source:** a second detailed forum report (2026-09-06) with four diagnostic reports attached, after
v2.6.0/v2.6.1 shipped. Every claim below was checked against that real data and the real code. The
reporter has been right every time so far; they were right again on all three bugs, and on one of them
the problem is worse than they described.

---

## START HERE (implementer handoff)

### §1, §2, §3, §5 — DONE. §4 not implemented (blocked, see §4.2).

| # | Bug | Risk | Files | Status |
|---|---|---|---|---|
| 1 | A capture with **zero at-rest samples** scores as flawless and can decide the final tune | **high** — corrupts real tuning decisions | `signal.ts` | ✅ done |
| 2 | A **failed** final verification silently reports the previous capture's evaluation | medium — reports a score for a PID that was never verified | `useClosedLoopTuning.ts` | ✅ done |
| 3 | `restNoise` is measured over the whole rest window, so settling/ringing inflates the "encoder noise floor" | medium — also scales the cruise-wander gate, hiding real oscillation | `evaluate.ts` | ✅ done |
| 5 | No literal capture command in the log | low, diagnostic only | `useClosedLoopTuning.ts` | ✅ done |
| 4 | CoreXY / multi-motor isolation | — | — | ⛔ not implemented, blocked (§4.2) |

### Do NOT do these

- **Do not reject captures just because they are truncated.** `docs/PLAN-capture-window.md` §7 established
  this with evidence and it still holds: truncated captures are *short, not corrupt*. In this report's own
  data, truncated captures carried 95, 190, 279, 291, 382 and 988 usable at-rest samples. §1 rejects on a
  much narrower, physically meaningful condition — **no at-rest data at all** — not on the truncation flag.
  These are not in conflict; read §1.2 before touching either.
- **Do not "fix" the truncation itself here.** Whether the 1HCL truncates more with M956 running in
  parallel is a separate question (§7) and is not what these three bugs are about — every one of them is a
  plugin-side handling error that would matter even with zero truncation.
- **Do not change any cost weight** (`COST_WEIGHT_*`, `COST_RELATIVE_PLATEAU`). Calibrated in
  `docs/PLAN-standstill-effort.md`.

### Verification for §1–§3

```
npm test
DWC_DIR="C:/Users/live/Documents/Github/DuetWebControl" npm run typecheck
```
No `.vue` files change, so `verify-build`/`check-ui36` are not required. `npm test` alone is NOT
sufficient — vitest does not structurally type-check.

**Do not commit to `main` and do not push** without being asked.

---

## 1. A capture with zero at-rest samples scores as flawless  ⬅ **highest priority**

### 1.1 The evidence

From the reporter's own run (`…2026-09-06t20-39-32-276z.json`), capture seq 4:

```
phase = a   value = 203927.1   rows = 503   truncated = true
restSamples = 0
restBias = 0   restNoise = 0   restRing = 0   settleOvershoot = 0
signalCost   = 3.0094   (finite — fully eligible to win a comparison)
```

The capture ended before the axis ever reached rest, so **every rest-derived metric reads as a perfect
zero** — not "unknown", but the best attainable value of each. And `203927.1` is the **final accepted A
value in that run's `finalPid`**. A capture that measured nothing about settling behaviour decided the
tune.

Across all four attached reports: 2 captures have `moved: true` with `restSamples === 0`, and **both
produced a finite `signalCost`**.

This is the same defect class as the accelerometer coverage bug (`docs/PLAN-accelerometer.md` §13) and the
original cost-comparison bug (`docs/PLAN-capture-window.md` §3): *missing data silently reported as a
good measurement*. v2.6.0's `comparableCost` fix does not cover it — that gates only the rest-**effort**
term on `restTailValid`. Nothing gates `restBias` / `restRing` / `settleOvershoot` on there being any rest
data at all.

Why the zeros happen (`evaluate.ts`'s `tuneStats`): with no `"rest"`-classified samples, `restErr` is
empty, and `mean([]) === 0`, `std([]) === 0`, `ringCount([]) === 0`.

### 1.2 The fix

A capture with no at-rest samples cannot measure 4 of `signalCost`'s 6 terms. It is not a poor
measurement, it is a failed one — reject it and let the existing retry machinery re-issue the move.
`captureMedian` already retries a null signal (`CAPTURE_RETRIES = 2`), so rejecting here needs no new
retry logic.

In `src/model/signal.ts`, inside `computeTuneSignal`, immediately after `const stats = tuneStats(...)`:

```ts
	// A capture that never reached rest measures NOTHING about settling: restBias/restNoise/restRing/
	// settleOvershoot all fall out of empty arrays as 0 — the best attainable value of each — so such a
	// capture outscores every real one on four of signalCost's six terms. Measured on a real report: an
	// A-term capture with restSamples 0 scored a finite 3.0094 and its value became the run's final A.
	// Rejecting returns null, which captureMedian already retries (CAPTURE_RETRIES) — see
	// docs/PLAN-capture-integrity.md §1.
	//
	// NOT the same as rejecting truncated captures, which docs/PLAN-capture-window.md §7 explicitly
	// forbids and which this must not become: truncated captures with real rest data are perfectly
	// usable (this same report has them with 95-988 rest samples) and are deliberately still accepted.
	// The condition is "no at-rest data at all", never "the firmware flagged Data lost".
	if (stats.moved && stats.restSamples === 0) { return null; }
```

`stats.moved` matters: a deliberate no-move capture legitimately classes every sample as rest, so
`restSamples` is large there — this condition cannot fire on one.

### 1.3 Tests (`src/__tests__/signal.test.ts`)

```ts
it("rejects a capture that never reached rest — it can measure nothing about settling", () => {
	// A move that fills the whole capture: target still climbing at the last sample, so segmentMove
	// classes nothing as "rest".
	const header = "Sample,Timestamp,Measured Motor Steps,Target Motor Steps,PID P Term\n";
	const rows = Array.from({ length: 200 }, (_, i) => `${i},${i},${i * 2},${i * 2 + 0.1},5`).join("\n");
	const capture = parseCapture(header + rows + "\n");
	const stats = tuneStats(capture, 1000);
	expect(stats.moved).toBe(true);
	expect(stats.restSamples).toBe(0);       // the precondition this guards
	expect(computeTuneSignal(capture, 1000)).toBeNull();
});

it("still accepts a SHORT capture that does have at-rest data (truncation is not the criterion)", () => {
	// docs/PLAN-capture-window.md §7: truncated-but-usable captures must keep working.
	const short = /* a capture with ~60 rest samples */;
	expect(computeTuneSignal(short, 1000)).not.toBeNull();
});
```

Build the second fixture from a real truncated capture if one is added to `fixtures/`, or synthesise a
short trapezoid whose target flattens before the end. **Do not** weaken the first test to make the second
pass — they test different conditions on purpose.

---

## 2. A failed final verification reports the previous capture's evaluation

### 2.1 The evidence

Same report. The log, verbatim and consecutive:

```
Refine I=875 → rms 1.38, bias 0.09, overshoot 2.22, lag -0.01, accel pk 140, cruise-P 0.3, 1 hunt, 1 ring
Firmware rejected the capture: Warning: Driver 50.0 warning: position tolerance exceeded
Error: Driver 50.0 error: failed to maintain position
   … repeated ~15 times …
```

The evaluation stored in that report reads `restBias 0.0895, settleOvershoot 2.22, moveRms 1.38` — an
exact match for the **I=875 refine capture**, not for any final-verification capture. The final
verification never produced one: the firmware rejected it outright. The report nonetheless presents
`grade: "fair", score: 79` beside a `finalPid` that was never successfully verified.

### 2.2 The fix

`src/core/useClosedLoopTuning.ts` (~line 1421):

```ts
tuneSession.value.evaluation = result?.evaluation ?? evaluation.value;   // ← the bug
```

When `runFinalVerification` can't grade (its `evaluateCapture()` returned null), `AutoRunResult.evaluation`
is `undefined`, and this falls back to the reactive `evaluation` computed — which still holds whatever
capture was last *successfully* loaded, i.e. the previous refine step. Note the log line immediately above
it already gets this right (`result.evaluation ? … : ""`), so only the stored value is wrong.

Replace with:

```ts
			// No fallback: when final verification couldn't produce a grade (e.g. the firmware rejected the
			// capture outright), showing the PREVIOUS capture's evaluation presents a score for a PID that
			// was never verified — measured on a real report, an I=875 refine capture's numbers were shown
			// against a completely different finalPid. "No final score" is the honest answer.
			// docs/PLAN-capture-integrity.md §2.
			tuneSession.value.evaluation = result?.evaluation ?? null;
```

Then make the absence visible rather than silently blank. In the same success/finish branch, alongside the
existing `gradeNote`:

```ts
			const gradeNote = result.evaluation
				? ` Final grade: ${result.evaluation.grade} (${result.evaluation.score}/100).`
				: " Final verification did not produce a valid capture — no final grade for these values.";
```

**No type change needed** — verified 2026-09-07: `TuneSession` is declared in `useClosedLoopTuning.ts`
(~line 337) and its field is already `evaluation?: TuneEvaluation | null`, so assigning `null` type-checks
as-is. Do not make it non-optional.

### 2.3 UI

Both `.vue` pages render the evaluation card behind `v-if="evaluation"`, so a null simply hides it — no
template change is strictly required, and **that keeps this a no-`.vue`-change fix**. If you choose to add
an explicit "final verification failed" state to the card, `verify-build` and `check-ui36` become
mandatory (see the verification block at the top).

### 2.4 Test

```ts
// tuneSession wiring lives in the composable, which this repo does not unit-test (see
// docs/PLAN-accelerometer.md §13 finding 7). Test the honest-reporting property where it IS reachable:
it("runFinalVerification reports no evaluation when the capture fails", async () => {
	const { effects } = fakeEffects({ evaluateCapture: vi.fn(async () => null) });
	const result = await runAutoTune(effects, pid, opts);
	expect(result.evaluation).toBeUndefined();   // never a stale one
});
```
`autorun.test.ts` already has `fakeEffects` with an `evaluateCapture` mock returning null — extend that
existing pattern rather than building new scaffolding.

---

## 3. "Encoder noise floor" is measured over the whole rest window

### 3.1 The evidence

Across the four reports, `restNoise` values reported to the user as *"±N step of high-frequency fuzz at
rest — normal for the encoder resolution"*:

| report | restNoise reported as "normal for the encoder resolution" |
|---|---|
| …19-44-24 | 0.18 step |
| …19-35-11 | 0.11 step |
| …20-39-32 | 0.39 step |
| …19-30-20 | **2.48 step** |
| worst single capture found across all four | **4.08 step** |

The reporter's encoder is 1000 PPR quadrature — one count is ~0.05 full step. Four full steps is not
quantisation noise; it is the settling transient and ringing being averaged into the "noise floor".

`tuneStats` computes `restNoise = std(restErr)` over **every** at-rest sample, starting the instant the
move ends — so overshoot, ringing and integrator convergence are all inside it.

This is not only cosmetic. `restNoise` scales the cruise-wander gate:

```ts
const spreadInfoFloor = CRUISE_SPREAD_K * s.restNoise;      // 3x
const spreadWarnFloor = CRUISE_SPREAD_WARN_K * s.restNoise; // 6x
```

With an inflated floor, a genuinely large cruise oscillation is reported as *"within the encoder's own
noise"* — visible in the …19-30-20 report, which reports `±0.60 step spread while cruising — within the
encoder's own noise` on the back of a 2.48-step "noise floor".

### 3.2 The fix

Measure the noise floor from the **settled tail** of the rest window, not the whole of it.
`analysis.ts` already has exactly this concept for `computeRestEffort` — reuse its constants rather than
inventing new ones:

```ts
export const REST_TAIL_FRACTION = 0.10;
export const REST_TAIL_MIN_SAMPLES = 25;
```

In `evaluate.ts`'s `tuneStats`, replace the single `restNoise` computation with a tail-based one, keeping
the full-window value for the metrics that legitimately want it:

```ts
	// The noise FLOOR must come from the settled tail, not the whole rest window: measured on real
	// reports, the whole-window figure reached 4.08 steps on a 1000 PPR encoder (~0.05 step/count) and was
	// still described to the user as "normal for the encoder resolution". It also scales the cruise-wander
	// gate (CRUISE_SPREAD_K), so an inflated floor hides real oscillation. Same tail concept
	// computeRestEffort already uses. See docs/PLAN-capture-integrity.md §3.
	const tailLen = Math.min(restErr.length, Math.max(REST_TAIL_MIN_SAMPLES, Math.floor(restErr.length * REST_TAIL_FRACTION)));
	const restTail = restErr.slice(restErr.length - tailLen);
	// Falls back to the whole window when the tail is too short to be meaningful — never zero, which
	// would make every noise-scaled gate fire (see §3.3).
	const restNoise = restTail.length >= REST_TAIL_MIN_SAMPLES ? std(restTail) : std(restErr);
```

`ringCount`'s own threshold uses `restNoise` (`Math.max(0.3, 3 * restNoise)`). It must keep using a
figure derived from the **whole** rest window, or lowering the floor will make `restRing`/`cruiseRing`
count ordinary settling as ringing. Compute both and keep them separate:

```ts
	const restNoiseFull = std(restErr);          // gate for ringCount, unchanged behaviour
	const ringThreshold = Math.max(0.3, 3 * restNoiseFull);
```

### 3.3 The trap to avoid

Do **not** let `restNoise` become 0 or near-0 for a genuinely quiet machine — `CRUISE_SPREAD_K *
restNoise` would then flag every capture. The existing code already guards `ringCount` with an absolute
`Math.max(0.3, …)` floor; the cruise-spread gate has **no** such floor by deliberate design
(`CRUISE_SPREAD_K`'s doc comment: "deliberately noise-SCALED with no fixed absolute floor"). Lowering
`restNoise` therefore tightens that gate. That is the *intent* of this fix, but it will change existing
findings on quiet machines — expect `evaluate.test.ts` churn and check each change is genuinely more
correct rather than updating expectations reflexively.

### 3.4 Tests

```ts
it("measures the noise floor from the settled tail, not the settling transient", () => {
	// A capture that rings hard for the first half of its rest window and is quiet afterwards: the
	// whole-window std is dominated by the ringing, the tail's is not.
	const s = tuneStats(ringingThenQuiet, 1000);
	expect(s.restNoise).toBeLessThan(0.2);       // the quiet tail
	// and NOT the whole-window figure, which is far larger:
	expect(std(allRestErrors)).toBeGreaterThan(1.0);
});

it("still counts ringing — the ring gate is not softened by the lower floor", () => {
	expect(tuneStats(ringingThenQuiet, 1000).restRing).toBeGreaterThan(0);
});

it("falls back to the whole window when the rest tail is too short to judge", () => {
	expect(tuneStats(shortRest, 1000).restNoise).toBeGreaterThan(0);
});
```

`evaluate.test.ts`'s `moveCapture()` helper already supports `restRingAmplitude` and `noise` — build the
"ringing then quiet" fixture from it rather than hand-rolling CSV.

---

## 4. CoreXY / multi-motor isolation  ⛔ BLOCKED on a product decision — feasibility done

The request: while tuning one motor of a mechanically coupled pair, put the *other* motor into open-loop
StealthChop at 100% standstill current, then restore both drivers exactly as they were. On CoreXY both
motors are belted together, so leaving the other closed-loop controller reacting to the tuning move
influences the measurement.

**The idea is sound and the pattern already exists in this codebase** — `autorun.ts` snapshots and
restores the M569.1 `E` thresholds around every run (`runAutoTune`: read back → apply → `try` → restore on
both the failure and success paths). Model any implementation on that, including restoring inside the
failure path, not only on success.

### 4.1 Feasibility, investigated 2026-09-07 — two hard constraints

**(a) The plugin cannot read back a remote driver's mode.** RRF exposes driver mode at
`boards[0].drivers[].config.mode` only — `Move.cpp`'s object-model table, gated on `HAS_SMART_DRIVERS`,
via `SmartDrivers::GetDriverMode`, and the table's own comment says `boards[0]`. Remote CAN boards expose
`drivers[]` with **only** `closedLoop` and `status` (`ExpansionManager.cpp`'s table;
`@duet3d/objectmodel`'s `Driver` class confirms: `closedLoop`, `status`, nothing else). RRF *does* track
remote modes internally (`ExpansionManager::StoreDriverMode` / `GetDriverMode`) but does not publish them.

So on the reporter's own hardware — a 1HCL at CAN address 50 — **there is no way to snapshot what the
other motor's mode was.** Any "restore exactly as they were" claim would be a guess.

**(b) `M917` is addressed by axis letter, not driver id.** `GCodes2.cpp` case 917 iterates
`axisLetters[axis]` and `gb.Seen(...)` — so it is `M917 X100`, *not* `M917 P50.0 S100`. `M569` is
`P<driver>`; `M917` is `<axisLetter><percent>`. Any implementation must use both addressing schemes
correctly.

### 4.2 What that means for the design

"Snapshot and restore automatically" is not implementable as stated on CAN-connected drivers. The honest
options, in the order I would prefer them:

1. **User-declared restore state (recommended).** A UI block: "Isolate the coupled motor while tuning",
   auto-detecting the other driver from the kinematics coupling the plugin *already* computes
   (`resolveMotionCoupling` gives the coupled axis indices; `move.axes[i].drivers[]` gives their driver
   ids), with an explicit "restore it to:" selector defaulting to closed loop. The plugin then owns only
   what the user declared, and the UI must say plainly that it restores to the *declared* mode, not to a
   detected one. Honest, and no firmware change needed.
2. **Local drivers only.** Read `boards[0].drivers[n].config.mode`, offer the feature only when the other
   motor is on the mainboard, and hide it otherwise. Correct but useless for exactly the 1HCL CoreXY
   setups that asked for it.
3. **Ask Duet to publish remote driver mode** in the object model, and implement (1) meanwhile.

There is also a real safety question to settle before any of this: leaving a coupled motor in open-loop
StealthChop while the *tuned* motor executes G1 H2 moves means the machine is running with one axis
unmonitored. The existing travel-limit safety (`coupledAxesForDriver`, which already refuses to move when
a coupled axis is unhomed) must be re-examined against that, not assumed to still hold.

**Do not implement this without a decision on (1) vs (2) and a review of the safety point.** It is a
genuinely good idea; it is not a small one.

---

## 5. Log the literal capture command

Cheap, useful, and it directly shortens the next investigation like this one. v2.6.0 logs the *resolved*
profile (`Capture profile: 2000 samples @ 1000 Hz (2.000 s window, …)`) but not the literal command, so
the `D` bitmask, the exact `R`, and the M956 that shares the line still have to be inferred.

In `useClosedLoopTuning.ts`'s `captureRaw`, next to the existing `loggedProfileKey` gate:

```ts
	// Log the literal command once per distinct shape — the profile line above says what was RESOLVED,
	// this says what was actually sent. Requested by the field report that needed CSV-timestamp
	// archaeology to establish the rate. The per-capture filename is normalised out of the dedupe key so
	// this logs once per run, not once per capture. docs/PLAN-capture-integrity.md §5.
	const commandText = buildCaptureCommand({ ...captureOpts, alongside });
	const commandKey = commandText.replace(/F"[^"]*"/g, 'F"…"');
	if (commandKey !== loggedCommandKey) {
		loggedCommandKey = commandKey;
		log(`Capture command: ${commandKey}`);
	}
```

Declare `let loggedCommandKey: string | null = null;` beside `loggedProfileKey` (~line 550), and reset it
where `loggedProfileKey` is reset (~line 1375, `runAutoTune`'s start block, alongside `loggedCouplingFor`
and `warnedAchievedRate`) — miss that and the second run of a session logs nothing.

Note `buildCaptureCommand` is already called inside `runCapture`; build the options object once in
`captureRaw` and pass the same object to both rather than duplicating the argument list, or the logged
command can drift from the sent one — which would be worse than not logging it.

---

## 6. Implementation notes (2026-09-07)

§1, §2, §3, §5 built as specified. Two things worth recording for whoever reads this next.

**§1 broke two pre-existing tests, and both breakages were correct, not collateral to paper over.**
- A synthetic test checking `MIN_CAPTURE_SAMPLES`'s floor used a fixture whose target never stopped
  moving — it had `restSamples === 0` by construction, purely incidentally, and had nothing to do with
  what the test was actually checking. Fixed the fixture (flattened the last 10 of 60 rows into a real
  rest phase) so the test goes back to testing the sample-count floor, not colliding with the new rule.
- `hold-truncated-datalost.csv`, a REAL fixture, turned out to be a genuine real-world instance of §1's
  exact bug: target still climbing when "Data lost" cuts it off, `restSamples: 0`. The old test asserted
  `computeTuneSignal` should accept it — that assertion was exactly the thing §1 exists to make false. Kept
  the test's real original intent (a "Data lost" trailer must not NaN-poison the rows that did arrive) as
  its own test using `tuneStats` directly, and added a second test asserting the CORRECT current behaviour
  — rejected, and rejected for the right reason (`restSamples === 0`, not a parse failure).

**§3's predicted test churn happened, and both failures were verified as genuine fix consequences before
touching anything** — per §3.3's explicit instruction not to update expectations reflexively.
- `evaluate.test.ts`'s cruise-ring-context test asserted the score stays IDENTICAL whether a capture rings
  at cruise as well as rest. Traced the failure by hand: the fixture's `cruiseRingAmplitude` injects a
  real amplitude-1.0 burst during cruise, which now correctly clears the (no-longer-inflated) cruise-
  wander gate and raises its own "Cruise error wanders" finding — unrelated to the "Rings after stopping"
  text/severity/term/direction checks in the same test, all of which still hold. Confirmed this isn't a
  synthetic zero-noise artifact by re-running with a realistic 0.05 background-noise floor added — the
  burst still clears it. Split the test: the original assertions (now all passing) stayed, the invalid
  "same score" assertion was replaced with one asserting the new finding correctly appears.
- `accelIntegration.test.ts`'s §12.4 baseline-comparison test (real hardware, two independent captures of
  the same move) asserted `restNoise` matches to 2 decimal places between them. The tail is 161 samples in
  each — not too small to judge — so this is genuine run-to-run measurement variance between two DIFFERENT
  real captures, now visible because the tail-based figure isn't being smoothed by averaging over a much
  wider (1600+ sample) window dominated by the shared settling-transient shape. Both values (0.017 g,
  0.027 g) remain small in absolute terms, and `combined` is the LOWER of the two — no degradation in the
  sense the test is actually about. Loosened to an absolute ceiling with a comment explaining why.

**§4 was not implemented.** The feasibility investigation (§4.1) stands; the product decision it's blocked
on was not made by this session, per the plan's own instruction not to implement without one.

**A real bug found only by auditing this change before pushing, not by the plan itself: `oscThreshold` in
`signal.ts` (gates the Ku/Tu ultimate-gain zero-crossing oscillation search) used `stats.restNoise`
unchanged.** That is structurally the same job as `evaluate.ts`'s `restRing`/`cruiseRing` gate — both are
zero-crossing oscillation detectors — and this plan deliberately kept THAT gate on the full-window noise
(`ringThreshold`/`restNoiseFull`) specifically so a lower tail-based floor couldn't make ordinary settling
register as ringing. `oscThreshold` was left exposed to exactly that risk, and it feeds a REAL tuning
input (Ku/Tu seeding), not just a report line. Fixed by adding `TuneStats.restNoiseFull` (the old
whole-window figure, kept separately) and switching `oscThreshold` to use it. Checked the other three
`restNoise` consumers (`autotune.ts`'s `P_NOISE_FLOOR_K`, `modelfit.ts`'s `restNoiseToPTermFloor`,
`signal.ts`'s `costNoiseFloor`) — all are magnitude-vs-true-noise comparisons, not oscillation gates, so
the more accurate tail-based value is correct and intended for them; left unchanged.

Adding a required field to `TuneStats` surfaced the exact failure mode this repo has hit before
(`medianSignal was missing cruiseRing, caught by a real DWC 3.7 typecheck`, 2026-08-xx): `medianSignal`
in `signal.ts` builds a `TuneStats` object field-by-field and was missing the new one — caught this time
by the DWC typecheck as intended. But six TEST files (`autorun.test.ts`, `autotune.test.ts`,
`damped-servo-simulation.test.ts`, `modelfit.test.ts`, `optimize.test.ts`, `tuneShared.test.ts`) each have
their own hand-built `stats()` helper with the same gap, and **neither `npm test` nor the DWC-based
`npm run typecheck` catches it** — the DWC typecheck only copies and checks `src/`, not `src/__tests__/`,
and vitest's default runner transforms TypeScript without checking it. Found these six by manual grep, not
tooling, and fixed each. `npx vitest run --typecheck` (an experimental but working vitest 4 feature) DOES
check test files and confirms clean now — worth adding to this repo's standard verification loop
alongside `npm test`/`DWC_DIR typecheck`, since it closes a real, demonstrated gap between them.

`npm test`: 494 passed (up from 490). `npx vitest run --typecheck`: no errors. `DWC_DIR` typecheck: clean.
No `.vue` files touched.

---

## 7. Not addressed here: does M956 make the 1HCL truncate more?

The reporter observed 12 truncated captures in a vibration-enabled run versus 4 in a comparable run
without it, and their accelerometer failed at the same moments (`no rate in the accelerometer file's
trailer`), with v2.6.1's soft-failure latch correctly disabling recording after 3 consecutive failures.

That is a plausible and important observation, but it is **a question about firmware/CAN bandwidth, not a
plugin logic bug**, and n=2 runs is not enough to attribute it. It also does not block any of §1–§3, each
of which is a plugin-side handling error that matters at any truncation rate. Investigate separately, with
matched runs at the same rate/columns with and without `recordVibration`, before changing anything.

`docs/PLAN-capture-window.md` §5's `AUTO_VALUE_RATE_CEILING` is the existing lever if it turns out the
combined M569.5 + M956 load needs a lower ceiling than M569.5 alone.
