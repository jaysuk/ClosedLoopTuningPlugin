# Plan v3: model-fit tuning — stop searching for what can be measured

**Status: Implemented.** See `modelfit.ts` (P rail-onset ramp + backoff, A/V two-capture linear solve),
`signal.ts` (capture validation), `tuneShared.ts` (capture retry + shared `verifyAccepted`/`nextBackoff`),
`autorun.ts` (measurement-failure containment, relay rest-domain runaway fix, config logging),
`ClosedLoopTuning.vue` (three-way identification selector as `v-btn-toggle`, model-fit backoff field).
252 tests passing (incl. a synthetic damped-servo simulator reproducing the exact field plant),
typecheck clean. The open questions were resolved pragmatically: DWC/Vuetify version unconfirmed, so
both method selectors were migrated to `v-btn-toggle` defensively regardless; P backoff defaults to
0.65 and is exposed as `modelFitBackoff`; the M204 accel-raise for the A probe was NOT implemented
(A honestly reports "no measurable effect" instead) — flagged to Jay as a deliberate scope cut.

## What the 2026-07-03 run logs actually show

The seeding ramp data from Jay's log, tabulated (P vs the measured stats), with the products that
expose the plant model:

| P | rms | bias | lag | **P×lag** | **P×rms** |
|------|------|-------|-------|--------|--------|
| 30 | 1.67 | -0.48 | -1.79 | -53.7 | 50.1 |
| 50 | 0.99 | -0.33 | -1.06 | -53.0 | 49.5 |
| 90 | 0.54 | -0.24 | -0.58 | -52.2 | 48.6 |
| 137.5| 0.36 | -0.19 | -0.39 | -53.6 | 49.5 |
| 214.8| 0.23 | -0.13 | -0.25 | -53.7 | 49.4 |
| 268.6| 0.19 | -0.11 | -0.20 | -53.7 | 51.0 |
| 335.7| 0.30 | -0.08 | -0.15 | — | *accel pk 256 (rail), sat 1%* |

**P×lag and P×rms are constant to within ~2% over a 9× range of P.** That is the signature of a
well-damped proportional servo: the loop needs a fixed effort (~53 P-term units) to sustain cruise,
and the error is simply that effort divided by P. Three consequences, which explain every complaint:

1. **Ziegler–Nichols (continuous cycling) can structurally never succeed here.** A plant like this
   has no sustained-oscillation point below actuator saturation — the phase never gets close to
   -180° until sampling delay/saturation dominate. "Falls back to the conservative ramp every time"
   is the method being physically inapplicable, not a detection bug. The same applies to the relay
   variant as currently implemented (relay-by-saturation during a move trips the runaway check;
   relay at rest won't limit-cycle a damped plant). **No amount of fixing the detector changes this;
   the identification method itself must change.**
2. **The P stage stopped at 110 on a made-up constant.** "Tracking error 0.45 step rms — at the
   noise floor" comes from `P_NOISE_FLOOR_MIN = 0.15` (×3 = 0.45), an arbitrary constant — while the
   same run's own seeding data had already measured rms 0.19 at P=268. The correct ceiling for P on
   this machine is visible in the data: the **effort rail** (accel pk hit 256 with sat at P≈335).
   A justified P is "back off ~30% from rail onset" ≈ **220–250**, roughly 2× what was accepted.
3. **V is not a search problem — it's two captures and a linear solve.** Fitting the log's own V
   ramp (lag vs V at P=110): `lag = -0.480 + 0.000346·V` → **zero-lag V ≈ 1388**. The geometric
   ramp was blindly crawling toward that value at ×1.6 per step, which is why a previous run
   overshot to V=5153 ("stupidly big") — and this run burned 6 captures before dying. The V that
   looks "stupidly big" is actually ~1400 on this machine; the fix is to *compute* it, verify it
   once, and log the algebra so it's explained, not to ramp toward it blindly.

Additional defects visible in the same log:

4. **The run was killed at the last stage by one corrupt capture.** `V=655.36 → rms 0.00, bias NaN,
   accel pk 0` is a near-empty/garbage capture (CSV race or truncated file). It was treated as a
   valid measurement, tripped "No steady-speed move detected", failed the term, and the **entire
   40-capture run was thrown away and restored**. Capture sanity validation + retry is mandatory,
   and a late-stage glitch must not zero out verified progress.
5. **Ten seeding captures were discarded, then the P stage re-measured five of the same values**
   (P=30…110, byte-for-byte the same numbers). All identification data must feed forward.
6. **The V accept threshold is machine-independent nonsense.** `|pTermCruiseMean| ≤ 3` at P=110
   demands cruise lag ≤ 0.027 steps — below the encoder noise, unreachable, so the ramp can never
   accept. Thresholds must be in measured-noise units, not constants.
7. **Decisions are invisible.** The V strategy decides on `pTermCruiseMean`, which `describeSignal`
   never prints — nobody can see why V kept ramping. Every stage's deciding quantity must be logged.
8. **The identification dropdown "makes no difference"** because both methods currently converge to
   the same fallback ramp on this plant (see 1) — and the run never logs which method it's using, so
   this is indistinguishable from the setting not being applied. Also unresolved: the tuning-method
   v-select was reported dead; plugin devDeps are Vuetify 4.1 while DWC bundles an older Vuetify —
   the method selectors should move to `v-btn-toggle` (2–3 options each, more robust across Vuetify
   versions, better UX) and the run must log its full configuration at start.

## The plan

### Phase 1 — Measurement integrity (everything else depends on this)

- **Capture validation**: `computeTuneSignal` (or the capture wrapper) rejects captures with fewer
  than ~100 rows or NaN in core stats → treated as *capture failure*, not as data.
- **Capture retry**: `captureMedian` retries a failed/invalid capture up to 2 times (short delay,
  re-issuing the move) before reporting failure upward. This alone would have saved the logged run.
- **Rest-noise baseline**: one no-move capture at run start measures the encoder noise floor σ (and
  a rest P-term noise band). σ replaces every hard-coded noise constant (`P_NOISE_FLOOR_MIN`,
  `V_CRUISE_OK`, plateau floors). Stored in the session report.
- **Transparent logging**: `describeSignal` gains `cruise-P` (pTermCruiseMean); run start logs one
  config line ("Method: standard · Identification: model-fit · seed rule: TL · medianOf 1 · budget
  40"); every accept logs *which criterion* stopped it and the numbers.

### Phase 2 — "Model fit" identification (new default), replacing the doomed oscillation hunt

One combined identification pass, ~8–12 captures, all data retained:

1. **P ramp to the effort rail** (not to oscillation, not to a fake noise floor): reuse the existing
   geometric ramp but continue until accel-phase P-term approaches the rail (`accelPeak ≥ ~0.85 ×
   256`), sat duty > threshold, ring appears, or P_MAX. Along the way, verify the 1/P model fit
   (P×rms ≈ const) — high fit quality confirms "well-damped servo" and makes the next steps valid.
2. **P\* = backoff × rail-onset P** (backoff ~0.65, exposed as the existing aggressiveness knob).
   The ramp attempts double as the P stage — **zero re-measurement**. Verify P\* once.
3. **V by linear solve**: baseline capture (V=0, at P\*) + one probe (V = min(500, half the naive
   estimate from `pTermCruiseMean` and commanded cruise velocity)) → fit `pTermCruiseMean` vs V →
   solve for zero → clamp to 2× the solve, verify once. Log the algebra ("cruise P-term -53 at
   V=0, slope -0.038/unit → V=1390"). Accept criterion: |cruise lag| ≤ max(σ, 3·σ_lag) — in
   measured units.
4. **A by linear solve**: same structure using the signed accel-window P-term mean. If the slope is
   statistically insignificant (this machine's test move barely exercises accel — log showed A=0 vs
   A=50000 changing accel pk 67→71), **leave A=0 and say so** rather than accepting a random value.
   Optionally raise the test move's accel via M204 for this probe (bounded, restored after).
5. **D and I after feedforward** (unchanged order P→A→V→D→I): D via the existing ring/overshoot
   logic — now meaningful because P\* is high enough to show under-damping if present; I via
   restBias with its existing threshold (bias at P\*≈235 is already ~0.11, so I will often
   legitimately stay small — log why).
6. Final verification + grade + the existing bidirectional polish cycles (already term-aware).

### Phase 3 — Keep ZN/relay selectable, but honest

- Identification selector becomes three options: **Model fit (recommended, default)** ·
  Continuous cycling (Ziegler–Nichols) · Relay feedback (Åström–Hägglund).
- Relay is re-scoped to a **rest-hold probe** (no commanded move — capture with A0 at high P) so
  the runaway veto stops killing it, and both classical methods, on failure, log an explicit
  physics explanation ("no sustained oscillation below the actuator rail — this axis is too well
  damped for Ziegler–Nichols; using the model fit instead") and hand their captures to the model
  fit rather than to the blind ramp.
- Both selectors (`tuning method`, `identification`) become `v-btn-toggle` groups; align the dev
  Vuetify version with what DWC 3.7 actually bundles (to be confirmed — see open questions).

### Phase 4 — Failure containment

- A term failure after ≥1 term has been *verified* keeps all verified values, marks the failed term
  "kept previous value", and continues to final verification — the full-restore path is reserved
  for instability, preflight failure, or user cancel. (The logged run would have finished with
  P=110/A=50000/V≈best-found instead of restoring everything.)
- The V/A stages' "no steady-speed move" is retried (Phase 1) and, if persistent, degrades to
  "keep best value so far" instead of aborting the run.

### Phase 5 — Tests

- **Synthetic damped-servo simulator** harness reproducing this exact plant (u_cruise=53,
  error=53/P, rail at 256, noise σ=0.1): assert the pipeline lands P in the 200–300 band, solves
  V≈1390±20%, leaves A=0, survives one injected corrupt capture, and never re-measures a P value
  the identification already measured.
- Unit tests: capture validation/retry, linear-solve math (incl. insignificant-slope A case),
  rail-onset detection, rest-noise baseline plumbing, keep-progress-on-late-failure.

## Expected outcome on Jay's machine

P ≈ 220–250 (justified by rail onset, logged), V ≈ 1400 (computed, verified, explained), A = 0
(explicitly "no measurable effect at this accel"), D/I small and explained, ~20–25 captures total
(fewer than today's failed run used), and no possibility of a single glitched CSV discarding the
whole result.

## Open questions for Jay

1. **Which DWC version is the machine running** (3.7.x?) — needed to pin the right Vuetify and
   settle the dead-dropdown question for good. `M122` or the DWC About dialog says.
2. The P backoff from rail onset (default 0.65): want a "quieter" option (0.5) exposed as the
   aggressiveness knob, or keep λ for seeding only?
3. OK to briefly raise accel (M204) for the A-solve probe move, restored afterwards? Without it, A
   stays 0 on gentle test moves like the current one.
