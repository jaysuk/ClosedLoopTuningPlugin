# Plan v4: close the fallback loopholes the 2026-07-04 run walked through

**Status: Implemented in full.** 282 tests passing, typecheck clean.

## Implementation summary

- [x] Defect 1: model-fit ramp budget 10→14 (reaches P_MAX), sat-duty ≥ 2% as a second onset trigger,
      **tail extrapolation** of the rail onset when the ramp ends below threshold with a rising
      accel-pk trend (`extrapolateRailOnset`, logged arithmetic), **best-measured** outcome for a flat
      tail — `identifyModelFitP` now returns `{ result, attempts }` and only nulls on capture
      failure / instability-before-any-reading. (`modelfit.ts` + `modelfit.test.ts`)
- [x] Defect 2: no more triple ramp — on a null model-fit result the orchestrator skips the
      continuous-cycling seeding entirely and primes the legacy P stage with the ramp's readings
      (`runSignalTerm` gained `priorAttempts`; start value continues from the last ramp value).
      (`autorun.ts`)
- [x] Defect 3: `P_NOISE_FLOOR_MIN` deleted; floor is now `1.5 × measured restNoise` with no absolute
      minimum. Regression test pins the exact field case (rms 0.36 / restNoise 0.11 keeps ramping).
      (`autotune.ts`)
- [x] Defect 4: V ramp sign-flip interpolation (`interpolateVZero`, regression test pins the field
      data +13.5@1048 → −9.7@1677 ⇒ V≈1415); refine-V probes the interpolated crossing when baseline
      and up-probe bracket zero; A accepts 0 on a within-noise plateau vs the A=0 baseline
      (`A_NO_EFFECT_FRACTION`). (`autotune.ts`, `autorun.ts`)
- [x] Addendum 1 adopted kernel: `dsp.ts` — dependency-free autocorrelation-based dominant-period
      detection (local-maximum search, not a bare global max, so a smooth signal's trivial short-lag
      self-similarity isn't mistaken for periodicity), wired into `computeTuneSignal` as a second-chance
      detector when the gated-zero-crossing method returns null. Gated at normalised autocorr ≥ 0.4.
      Regression test proves the fallback fires exactly where the primary method fails (a fast-decaying
      small oscillation whose late half-cycles never clear a fixed amplitude gate).
- [x] Addendum 2: centred/longest move planning. `planCenteredMove` (`limits.ts`) plans a move spanning
      `mid − d/2 → mid + d/2` instead of one-way from the (already-centred) axis — doubling usable
      distance on Jay's reported case (350 mm axis, ~173 mm one-way → up to the full ~346 mm clear).
      `planCaptureProfile` gained an "auto" mode (`maxDistanceMm` 0/undefined): longest reasonable move
      up to `AUTO_MOVE_CAP_MM` (200 mm), sample rate DERIVED from the move's duration (floored at
      `AUTO_RATE_FLOOR_HZ` = 250 Hz; the move shrinks, never the rate, if even the floor can't fit the
      sample budget). `ClosedLoopTuning.vue`'s `captureRaw()` pre-positions to the plan's own
      `startPosition` before the H2 move, and threads the actually-used rate into both the M569.5
      capture command and `computeTuneSignal`/`evaluateTune` (previously a hard-coded UI field went to
      both). UI "Distance" field is now "0 = auto (longest)", defaulting to 0, stored under a NEW
      persisted key (`tuneDistanceMm`) so an existing session's saved 50 mm doesn't silently keep
      overriding the new default.
- [x] End-to-end fallback replay: `damped-servo-simulation.test.ts`'s forced continuous-cycling run now
      also asserts the V stage stops at the sign flip (~1500, not V_MAX) and A ends at 0 on the exact
      plant that would previously have overshot both.
- [ ] Optional (Jay hasn't opted in): evaluator strictness — `CRUISE_GOOD` → `max(2×restNoise, 0.25)`.

## Addendum 1 — architecture/dependency review (Web Worker, Comlink, Math.js, fft.js, PID packages)

Jay asked whether the analysis should move into a Web Worker (via Comlink) with Math.js / fft.js /
`simple-pid-controller`, referencing SimpleFOC, Mechaduino/MKS-SERVO42, ODrive and CLN. Verdict,
measured rather than assumed:

**Declined: Web Worker + Comlink + Math.js + PID packages.** Benchmarked on the real 2000-sample
fixtures: CSV parse ≈ 4.3 ms, the full analysis pass *plus* a 600-point autocorrelation ≈ 3.7 ms —
**~8 ms of main-thread work per capture**, between physical operations (move + firmware capture +
file download) that each take seconds. That's a ~0.2% duty cycle; a worker cannot improve perceived
responsiveness and would add real cost in a DWC plugin (separate worker chunk in the plugin bundle,
Comlink plumbing, a second copy of the analysis types). Math.js (~700 KB) would be imported to solve
one two-point line. `simple-pid-controller` executes a PID loop — but our PID loop executes in
RepRapFirmware on the 1HCL, never in the browser; a JS PID runtime has no role in a gain *chooser*.
If a future feature genuinely needs heavy browser math (e.g. full Bode estimation), the
duet-tool-align/openCV precedent shows workers are feasible in this plugin system — revisit then.

**Adopted: the useful kernel.**
- **Autocorrelation-based oscillation detection** (dependency-free `dsp.ts`, ~30 lines — no fft.js
  needed at these data sizes): used as a second-chance dominant-period detector when the existing
  amplitude-gated zero-crossing method finds nothing. This is what makes the relay / continuous-
  cycling paths *able* to see the small, decaying oscillations they currently miss, and it mirrors
  what SimpleFOCStudio does in Python for its step-response analysis. Conservatively gated
  (normalised autocorrelation peak ≥ 0.4, amplitude above the noise floor) so encoder fuzz can't
  masquerade as a resonance.
- **ODrive-style feedforward model as the documented basis** for the A/V solve: ODrive's
  `vel_gain`/accel feedforward implement exactly `u_ff = Kv·v + Ka·a` added to the position-loop
  output — the same linearity our two-capture solve exploits. Referenced in modelfit.ts docs; no
  code to port (their implementation is firmware-side, like RRF's).

## Addendum 2 — move planning (Jay's field observations)

1. **Centre the move on the middle of travel, not start it there.** Today the axis is centred at
   mid-travel and the move runs one-way from there, so the usable distance is *half* the axis minus
   margins. Fix: plan the move to span `mid − d/2 → mid + d/2`; the pre-positioning step moves to the
   start point (a normal, soft-limit-respecting G1), then the H2 tuning move runs the full `d`.
   Usable distance doubles to `(max − min) − 2·margin`.
2. **Default to the longest reasonable move.** Longer moves give longer cruise sections → better
   cruise-P estimates → better V solves (Jay confirms longer moves tune more easily). New default:
   distance = the full centred span above, capped at 200 mm (`AUTO_MOVE_CAP_MM`) to keep capture
   windows sane; the capture window is then derived from the move (window = moveTime / (1 −
   restFraction)) and the **sample rate is computed as samples/window** (clamped to ≥ 250 Hz;
   distance shrinks if even the floor rate can't cover it). The UI "Distance" field becomes
   "0 = auto (longest)" and defaults to auto via a new persisted key, so previously-saved 50 mm
   values don't silently override the new behaviour. The effective rate must be threaded into the
   capture command *and* the analysis (today a hard-coded `sampleRate.value` goes to both — mostly
   harmless because captures carry a Timestamp column, but wrong to leave).

## Verdict on the run Jay posted

The v3 machinery *around* the decision worked (bidirectional refinement really did walk V down each
cycle, capture retries fired zero times because nothing glitched, the config line and cruise-P logging
made the whole run auditable — which is how the defects below are provable). But the decision itself
went wrong in four places, and the end result is not right:

- **V = 4509.73 is ~3.2× too high.** The run's own V ramp measured the cruise P-term crossing zero
  between V=1048.58 (+13.5) and V=1677.73 (−9.7): **the correct V is ≈ 1415** (a linear fit over the
  whole 0…1677 range lands on the same number, 1415, with cruise-P = 53.0 − 0.03747·V). The final
  value leaves cruise-P ≈ −43, i.e. the axis *leads* the target at cruise by ~0.25 step.
- **Yes, the error graph should be much flatter.** With V ≈ 1415 the cruise section should be a flat
  noise band of about ±0.12 step (the measured encoder floor) with small accel/decel blips. The slow
  ±0.3–0.4 S-shaped wander in the posted graph is the uncompensated V residual plus the integral term
  slowly fighting it — not noise, and not as good as this machine can do. (The evaluator's 100/100 is
  too generous about that wander; optional fix at the end.)
- **P = 171.88 is defensible but under-evidenced** — accepted by the legacy fallback's fake noise
  floor, not by the rail measurement the run was busy collecting. The rail data says P* ≈ 240.
- **A = 50000 was accepted with zero supporting evidence** (accel pk 69 with it, ~69 without it).

## The four defects, each provable from the log

### 1. The model-fit P ramp gave up one step before the rail

The ramp ran 10 attempts, ending at P=335.7 with accel pk 180 — rising steeply (89 → 105 → 180 over
the last three points, slope ≈ 1.12 per P-unit) but still below the 0.85×256 = 217.6 trigger. The next
geometric steps are 419.6 and 524.5; extrapolating the measured trend, the rail onset is at **P ≈ 369**
(→ P* ≈ 240). The budget of `MODEL_FIT_MAX_ATTEMPTS = 10` is simply one-to-two steps too short to reach
it — the *same* "budget expires right where it gets interesting" mistake the v3 plan called out in the
seeding search, faithfully reproduced in its replacement. Two aggravations:

- Rail detection keys off a single capture's **peak** accel P-term, which is very noisy run-to-run
  (yesterday P=335.7 read 256 with 1% sat; today the same P read 180 and 201 in back-to-back ramps).
  A hard threshold on a noisy peak makes "did we find the rail?" a coin flip near the boundary.
- On budget exhaustion it falls back wholesale, even when the collected data would let it *extrapolate*
  the onset — as it provably would have here.

**Fix:** (a) raise the budget so the ramp can reach P_MAX (13 steps from 30); (b) trigger on
`satDuty ≥ 0.02` OR accel-pk ≥ 0.85·rail; (c) when the budget or P_MAX is reached without a trigger
but the accel-pk tail is cleanly rising (positive slope over the last 3 points, decent fit), compute
the onset by extrapolating that tail (clamped to P_MAX) and proceed with P* from it, logging the
extrapolation arithmetic; only fall back when the trend is flat or the data is dirty.

### 2. On fallback, all identification data is discarded — three near-identical ramps ran

Model fit ramped P=30…335.7 (10 captures) → fell back → **continuous-cycling seeding re-ramped the
exact same 10 values** (which cannot possibly find an oscillation the model-fit ramp didn't — same
plant, same range) → fell back → **the P stage re-ramped 30…137.5 again** (6 more). 26 captures spent
measuring one curve three times, byte-for-byte repeatable in the log. The v3 plan's "all identification
captures feed forward" was only implemented *within* model fit, not across the fallback boundary.

**Fix:** `identifyModelFitP` returns its attempt list even on failure. The fallback (a) skips the
continuous-cycling seeding entirely when the model-fit ramp already covered the range without seeing
an oscillation, and (b) pre-loads the P stage's `attempts` array with the model-fit readings so its
`decide()` continues from P=335.7 instead of restarting at 30.

### 3. The legacy P acceptance still contains the discredited noise-floor constant

The fallback accepted P=137.5 via "Tracking error 0.36 step rms — at the noise floor", which is
`3 × max(restNoise≈0.11, P_NOISE_FLOOR_MIN=0.15) = 0.45`. That 0.15 constant is exactly what the v3
plan diagnosed as indefensible; it survived because only the model-fit path was built and this run
never stayed on it. With the real measured floor (rest noise ≈ 0.12, and moveRms can't go below
~1× that even with perfect tracking) the criterion should be `K × restNoise` with **K ≈ 1.5** and
**no absolute minimum** — accepting around P≈270 on this data instead of 137.5.

**Fix:** delete `P_NOISE_FLOOR_MIN`; set `P_NOISE_FLOOR_K = 1.5`; floor = K × measured restNoise only.

### 4. The V ramp is sign-blind — it sailed straight through zero (the "stupidly big V", third time)

The clearest possible stop signal appeared mid-ramp: cruise-P went **+13.5 → −9.7 → −46.4 → −109 →
−203** while the strategy compared only `|cruise-P|` against thresholds and kept multiplying by 1.6
until it hit V_MAX and accepted 6871.98. A sign flip between consecutive attempts means the optimum
was just bracketed; the answer is the interpolated zero crossing (here: 1415). The three refinement
cycles then spent ~8 captures walking 6872 → 5154 → 4510 at shrinking step sizes — improving, but
never able to recover a 4.9× overshoot.

**Fix (fallback V strategy):** on a sign flip of `pTermCruiseMean` between consecutive attempts,
accept the linearly interpolated zero crossing (then the normal verify). Same guard in the refinement
probe: if the baseline and probe cruise-P have opposite signs, propose the interpolated crossing
instead of the fixed-δ step.

**Fix (fallback A strategy):** when the plateau fires and the accel-pk change since A=0 is within the
measured noise (69 vs ~69 here), accept **0** with a "no measurable effect" log line — never a random
non-zero value the data doesn't support.

## Test additions

- **Replay of this exact run** as a scripted plant (cruise-P = 53 − 0.03747·V; accel-pk table from the
  measured points with the rail at ~369; rms = 50/P):
  - model fit with the extended budget reaches the rail region and lands P* ≈ 240 ± 15% — no fallback;
  - with the rail artificially pushed past P_MAX and a rising tail, the extrapolation path fires and
    logs its arithmetic;
  - forced onto the fallback path, the V ramp stops at the sign flip and lands ≈ 1415 ± 10%, A stays 0,
    and **no P value is captured twice across model-fit → P-stage** (the duplicate-measurement bug);
- Unit tests for sign-flip interpolation (incl. flip on the very second attempt, and a flip with a
  near-zero second reading) and for the tail-extrapolated rail onset.

## Optional (flag before doing): evaluator strictness

The final capture scored "Excellent 100/100" while carrying a visible ±0.3 cruise wander. `CRUISE_GOOD`
(0.35 step, absolute) could become `max(2×restNoise, 0.25)` so the grade reflects the machine's own
noise floor. Cosmetic — the wander itself disappears once V is right — so only worth doing if Jay wants
the grade to stay honest on future captures.

## Expected outcome on this machine

P ≈ 240 (rail-extrapolated, logged arithmetic), V ≈ 1415 ± verify (solved or sign-flip-interpolated,
logged), A = 0 (explicit "no measurable effect"), I small; cruise error a flat ±0.12 band; total
captures ~25 instead of this run's ~55, with zero repeated ramps.
