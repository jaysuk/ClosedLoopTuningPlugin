# Plan: tuning methods, joint ("package") optimisation, and report slimming

**Status: Implemented (all 5 phases).** See `signal.ts` (cost/noise), `autotune.ts`/`autorun.ts` (order +
refinement), `optimize.ts` (package optimiser), `ClosedLoopTuning.vue` (method UI), `report.ts` (report
slimming). 211 tests passing, typecheck clean. The four "open decisions" below were resolved as written
(Standard default, 40-capture Thorough budget, legacy P→D→I→A→V order removed for axis drivers, medianOf
stays at 1 by default — exposed as an Advanced option instead of hard-coded to 3).

## Context / problem statement (from field testing)

1. **P freezes after cycle 1.** A run settles on e.g. P=110 in the first cycle and every
   subsequent cycle leaves it (and usually every other term) exactly where it was. Multi-cycle
   runs are effectively single-cycle runs plus wasted moves.
2. **Terms are tuned in isolation.** The author of the original plugin advises tuning the loop
   "as a complete package" rather than term-by-term — the greedy per-term ramp can't see
   interactions (D permits higher P; feed-forward removes error that D/I are currently tuned
   against).
3. **Tuning order doesn't match the Duet docs.** The axis (signal) path runs P→D→I→A→V; the
   Duet 1HCL guide suggests **P→A→V→D→I** (feed-forward early so damping/integral tune against
   the residual error only).
4. **The user should be able to choose the tuning method** (fast sequential vs thorough joint
   optimisation, etc.).
5. **The downloadable session JSON is far too big** to share or feed to an analysis tool.

---

## Root-cause review (verified against the code)

### Why P never changes after the first pass

* **Refinement cycles only ramp upward from the accepted value, and plateau after 2 captures.**
  For cycles ≥ 2 the start value is the previously accepted value
  ([autorun.ts:385-387](../src/model/autorun.ts)). `SIGNAL_P_STRATEGY` then needs only two
  attempts to declare a plateau ([autotune.ts:238-244](../src/model/autotune.ts)): attempt 1 is
  the accepted value itself, attempt 2 is ×1.25, and if the rms improvement is <5 % it accepts
  the *best of those two* — which is almost always the original value. So every refinement
  cycle costs ~2–3 moves per term and returns the same numbers.
* **The 5 % plateau threshold is below capture-to-capture noise.** `medianOf` defaults to 1
  (and isn't exposed in the UI), so each decision compares two single noisy captures. Two
  captures at the *same* gains routinely differ by more than 5 % rms, so "plateaued" fires
  early and arbitrarily — both in cycle 1 (why the ramp stops where it does) and in refinement.
* **No downward exploration exists anywhere.** If cycle 1 lands high (e.g. from Ku/Tu
  seeding), or later terms change what the optimal P is, nothing can ever lower a value —
  the only downward moves are instability back-offs.
* **The run then stops early**: with cycles ≥ 2 producing identical values, ITAE doesn't
  improve, and the `ITAE_PLATEAU` early-stop ([autorun.ts:580-588](../src/model/autorun.ts))
  ends the run after cycle 2. Consistent with "it never changes".

### Why per-term tuning underdelivers (the "package" argument)

* D is currently tuned immediately after P, judged on overshoot/ring that is partly caused by
  the *absence* of feed-forward; A/V then remove that error, leaving D mis-set for the final
  loop.
* Once accepted, a term is frozen for the rest of the cycle; interactions (P↔D, P↔V) are never
  revisited except by the structurally-broken refinement cycles above.
* Each strategy optimises a *different* single metric (rms, overshoot, bias, P-term peaks).
  There is no single scalar objective, so "did the whole loop get better?" is never asked —
  except by ITAE at cycle granularity, where it's only used to stop, never to choose.

### Why the session JSON is huge

* `recordSessionCapture` stores the **full raw CSV text for every capture**
  ([ClosedLoopTuning.vue:620-624](../src/components/ClosedLoopTuning.vue)). A capture is
  ~2000 samples × 3–4 columns ≈ 50–100 KB of text; a run makes 30–60+ captures → several MB
  before anything else.
* `buildReport` embeds the **entire sanitised object model**
  ([ClosedLoopTuning.vue:628](../src/components/ClosedLoopTuning.vue), runtime
  `diagnostics.ts`) — typically hundreds of KB more.
* **Bug:** the report's `log` is `autoLog`, which is capped to the last 40 lines
  ([ClosedLoopTuning.vue:992](../src/components/ClosedLoopTuning.vue) `log()` slices `-40`).
  Long runs lose the preflight/seeding history — the part most useful for diagnosing a bad
  result.
* Capture entries have no decision context (what the tuner concluded from each capture), so
  despite the size, the report can't reconstruct *why* a value was chosen.

---

## Plan

Five phases, ordered so each is independently shippable. All decision logic stays in pure
modules under `src/model/` with unit tests; the Vue layer only gains options plumbing and UI.

### Phase 1 — Scalar objective + noise-aware comparisons (`src/model/signal.ts`)

The foundation for everything else: one number that says "is this capture better than that
one", and a way to know whether a difference is real or noise.

1. **`signalCost(s: TuneSignal): number`** — `Infinity` when `signalUnstable(s)`; otherwise a
   weighted sum in motor-step units (constants exported for tests/transparency):

   ```
   cost = moveRms
        + 0.5 * settleOvershoot
        + 1.0 * |restBias|
        + 0.5 * |cruiseLag|
        + 0.25 * max(0, restRing - 1)
   ```

   Weights mirror the existing evaluator's priorities (standing error and tracking worst).
   Validate the ordering against the existing fixtures (`move250-stable-best` must score
   better than `move250-stable-early`, `move250-instability-onset` and everything unstable).

2. **`significantlyBetter(prev: TuneSignal, cur: TuneSignal): boolean`** — improvement must
   exceed `max(RELATIVE_PLATEAU, K_NOISE * restNoise / scale)` rather than a bare 5 %, where
   the noise term is derived from the capture's own `restNoise` (already measured). Add a
   companion `withinNoise(a, b)` predicate; when two attempts are within noise, **prefer the
   lower gain** (safer) instead of the accidental "best rms".

3. Thread `signalCost` into `TuneSignal` consumers (`bestBy` callers can switch to cost where
   the intent is "best overall attempt", keeping term-specific metrics where the intent is
   term-specific, e.g. `pTermCruiseMean` for V).

Tests: fixture-based ordering tests; noise-significance edge cases (zero noise, huge noise).

### Phase 2 — Duet-order sequential mode + refinement that can actually move

1. **Reorder `AUTOTUNE_SIGNAL_SEQUENCE` to P → A → V → D → I** (axis path only; the extruder
   step path stays P→D→I — no axis, no feed-forward moves). Consequences to handle:
   * D's accept condition ("critically damped") now judges the residual error after
     feed-forward — no logic change needed, but re-baseline `D_OVERSHOOT`/ring expectations
     against fixtures.
   * Ku/Tu seeding still sets P/I/D at cycle start; the seeded I/D simply get refined later in
     the cycle. Feed-forward stages still start from 0 on cycle 1 (unchanged).
   * Update UI strings: button label "Auto-tune (P → A → V → D → I)", consent dialog text,
     `STAGE_ORDER` chip order, the Step-4 intro paragraph, and the HelpTip texts.
2. **Replace the cycles-≥2 re-ramp with a bidirectional local probe per term** (this is one
   sweep of the Phase-3 optimiser, so implement it as a call into that module): for each term
   in sequence, try `v·(1+δ)` and — only if up didn't significantly help — `v·(1−δ)`, adopting
   whichever `significantlyBetter` says improves `signalCost`; otherwise keep `v`. δ starts at
   25 % and halves each cycle. Bounded: ≤ 3 captures per term per cycle. Instability during a
   probe → immediate revert of that probe (existing veto/back-off machinery).
3. Keep the ITAE early-stop but base it on `signalCost` instead of raw ITAE, and only engage
   it from cycle 3 (cycle 2 is the first real refinement now).

Tests: extend `autorun.test.ts`'s scripted-effects harness — a synthetic plant where P=150 is
better than the accepted P=110 must see cycle 2 move P upward; a plant where the optimum is
below must see it move down; a flat plant must leave values unchanged (and prove attempt
count per cycle is bounded).

### Phase 3 — "Package" joint optimisation (`src/model/optimize.ts`, new)

Coordinate-descent with adaptive step sizes (the classic *Twiddle* pattern-search), minimising
`signalCost` over the whole PID vector at once. Chosen over Nelder–Mead because it maps 1:1
onto the existing "set value → capture → decide" effects loop, is trivially bounded, and every
intermediate state is a valid, individually-vetoed PID.

* **API:** `runPackageOptimize(effects: TuneEffects, pid: PidConfig, opts): Promise<TermRunResult>`
  reusing `TuneEffects` unchanged. Terms included: `["p","d","i","a","v"]` by default,
  configurable (e.g. refine-only P/D/I).
* **Algorithm:**
  * per-term step size, initialised to 25 % of the current value (or the existing
    `ZERO_START[term]` when the value is 0);
  * loop over terms: probe `v+step` (median capture, cost); if `significantlyBetter`, keep it
    and grow that step ×1.5; else probe `v−step` (clamped ≥ 0); else shrink step ×0.5;
  * hard safety: any probe that is `signalUnstable` is reverted immediately and shrinks the
    step (never accepted, never used as "best") — plus the existing runaway/sat vetoes stay in
    `TuneSignal`;
  * termination: all steps below 2 % of value (abs floor per term), **or** capture budget
    exhausted (`captureBudget` option, default ≈ 40 captures), or cancellation;
  * per-term caps: reuse `TERM_MAX` clamps from autorun.ts.
* **Integration in `runAutoTune`:** a new `method` option (see Phase 4) selects the cycle
  body: sequential cycles (Phase 2), or sequential cycle 1 + package polish, or package-only
  from the current values. Snapshot/rollback, `verifyAccepted` on the final vector, and the
  final verification/correction pass all stay exactly as they are.
* New stage id `"optimize"` for `onStage` so the chip timeline shows the polish phase.

Tests: drive it with a synthetic cost surface (scripted effects): converges to a known optimum
within budget; respects the budget; never accepts an unstable probe; step sizes shrink; a
term at its cap stays clamped.

### Phase 4 — Tuning-method selection UI

* **New "Tuning method" select** on the auto-tune card (persisted in `LS_STATE`):
  1. **Standard (recommended)** — Duet-order sequential pass, then bidirectional refinement
     cycles (Phase 2). Roughly today's runtime.
  2. **Thorough — tune as a package** — Standard cycle 1, then Phase-3 joint optimisation
     under the capture budget. More moves, best result; this is the mode the original author
     is asking for.
  3. **Refine current values** — Phase-3 optimisation starting from the PID already on the
     driver: no seeding, no from-scratch ramp. For polishing an existing tune.
* **Advanced options** (expansion panel, all persisted): seed rule (`tyreus-luyben` /
  `zn-classic` / `amigo` + λ) — currently hard-wired defaults; captures per decision
  (`medianOf`, default 1 for ramp probes but **default 3 for refinement/package comparisons**,
  where noise-vs-signal is the whole game); capture budget; cycles (Standard only).
* Show an **estimated move count** next to the method select (each mode's bound is known) so
  the time cost of "Thorough" is visible before starting.
* Plumb through `AutoRunOptions`: `method: "sequential" | "package" | "refine"`,
  `captureBudget?: number`, plus the existing `medianOf`/`seedRule`/`seedLambda`.
* Extruder (step) path: only Standard is available; the select is disabled with a hint.

### Phase 5 — Session report: smaller and more useful

1. **Fix the log cap bug:** keep a separate uncapped `sessionLog: Array<string>` for the
   report; `autoLog` stays capped at 40 for display only.
2. **Tiered capture storage.** Every capture entry always stores: phase/term, value tried, the
   computed `TuneSignal` (or StepMetrics), `signalCost`, and the decision note it produced.
   The **full CSV is kept only for key captures**: the preflight probe, the Ku/Tu "found"
   capture, each term's final verified accept, any unstable/failed capture, and the final
   verification capture. All other captures store a **downsampled error series**
   (~200 points, peak-preserving min/max decimation) instead of raw CSV. Expected result:
   typical report < 1 MB (from several MB today).
3. **Prune the embedded model** to what analysis actually needs: firmware/board info for the
   selected board (incl. `closedLoop`), the selected axis entry (stepsPerMm, microstepping,
   min/max), kinematics name, and the plugin record — instead of the whole object model.
4. **Add decision-grade metadata:** `reportVersion`, the full `AutoRunOptions` used (method,
   order, medianOf, budget, seed rule), a stage timeline with timestamps, and per-capture
   sequence numbers so the report alone can reconstruct every decision.
5. **Download options:** default download is the summary tier; add an "include all raw CSVs"
   checkbox for the full version, and gzip via `CompressionStream` to `.json.gz` when the
   payload exceeds ~2 MB (fall back to plain JSON if unsupported).

Tests: report-builder unit tests (which captures keep CSV; downsampler preserves peaks; log
is uncapped; model pruning keeps/drops the right keys).

---

## Suggested implementation order & scope

| Step | Phase | Size | Depends on |
|------|-------|------|-----------|
| 1 | Phase 1 (cost + noise) | S | — |
| 2 | Phase 2 (order + refinement) | M | 1 |
| 3 | Phase 3 (package optimiser) | M | 1 |
| 4 | Phase 4 (method UI) | S–M | 2, 3 |
| 5 | Phase 5 (report) | M | — (can go first or last) |

`npm test` (vitest) after each step; the scripted-effects harness in
`src/__tests__/autorun.test.ts` is the template for all new orchestration tests. Typecheck
needs `DWC_DIR` set (see project memory).

## Open decisions for Jay

1. **Default method** — plan assumes "Standard" default with "Thorough" opt-in. OK?
2. **Capture budget default for Thorough** (≈ 40 extra moves ≈ a few minutes). Higher/lower?
3. Keep the old P→D→I→A→V order available as a "Legacy" method, or delete it outright for
   axis drivers (plan assumes delete — less to maintain, extruders keep their own path)?
4. `medianOf` default of 3 for refinement comparisons triples those captures' time cost —
   acceptable, or should it stay 1 until proven necessary?
