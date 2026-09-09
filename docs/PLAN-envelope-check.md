# Plan: envelope validity — does the tune hold at the axis's configured max?

Follow-up to `docs/PLAN-rail-detection.md` §6, split into its own plan as agreed there. Investigated
2026-09-09.

## START HERE — decisions made 2026-09-09, design below, implementation starting now

| Question | Decision |
|---|---|
| A. When it runs | **Every successful run**, not just below-good. Accept the extra capture on every run. |
| B. What envelope | **Configured M203/M201** — not a user-entered print envelope. No new UI input needed to derive it. |
| C. Where it surfaces | **Dedicated UI element**, not a log line alone. `.vue` work in scope; `verify-build`/`check-ui36` required before this is done. |
| D. Pass/fail line | **Reuse `MODEL_FIT_SAT_ONSET` (2%)** — same threshold model-fit's own ramp already uses to call something "saturating". |

Implementation order below (§3): model layer first (host-agnostic, fully unit-testable) → host-adapter
capture logic → UI card (ui36 + ui37, per this project's dual-support requirement). Each stage is a
natural checkpoint; the model layer is the one most worth landing and verifying on its own before the
`.vue` work begins.

### Progress (2026-09-09)

- **Stage 1 (model layer) — DONE.** `EnvelopeCheck` type, `TuneEffects.checkEnvelope`, `evaluateEnvelope`
  (the pure satDuty→holds judgment, next to `MODEL_FIT_SAT_ONSET` in modelfit.ts), `envelopeFeedMmPerMin`
  (the pure coupled-axis feed derivation, in limits.ts), the call site in `runAutoTune` (every successful
  run, report-only, wrapped so a throw or a null both just mean "nothing to report"), `AutoRunResult.
  envelopeCheck`. 13 new tests (autorun.test.ts, modelfit.test.ts, limits.test.ts).
- **Stage 2 (host adapter) — DONE.** `captureRaw` takes an optional `feedOverrideMmPerMin` (threaded
  through the profile plan, the logged profile line — whose dedupe key now includes feed, since it didn't
  before and a coincidental shape match would have suppressed the very line meant to show the different
  feed — the G1 move, and the return move); auto-sizes distance rather than reusing `avDistance` when
  overridden. `checkEnvelope()` resolves the coupling, builds `EnvelopeSpeedInput[]` from `axes[].speed`,
  calls `envelopeFeedMmPerMin`, runs the capture, reads `pTermSatDuty` via `analyzeMove` directly (NOT
  `computeTuneSignal` — that applies capture-integrity gating this check has no use for, e.g. the §1
  zero-rest-sample rejection; an envelope check at extreme feed may never even reach rest, and that's
  fine, satDuty doesn't need it). Wired into `buildTuneEffects()` and `TuneSession.envelopeCheck`
  (mirrors `ku`/`tu` exactly, including the report download, which spreads the whole session object).
  All three verification checks pass: `npm test` (513), `vitest run --typecheck`, `DWC_DIR` typecheck
  against a real 3.7 checkout.
- **Stage 3 (UI) — DONE.** A card in the results column of both `ui37/ClosedLoopTuning.vue` and
  `ui36/ClosedLoopTuningPage.vue`, right after the evaluation card, each written in that file's own
  idiom (ui37: Vuetify 3 `variant`/`size`/`density`; ui36: Vuetify 2 `outlined`/`dense`/`x-small`, no
  mixing). Pass/fail icon+colour, the feed it was checked at, saturation duty, and a HelpTip explaining
  what the check means and why a lower configured M203/M201 than the real print envelope would make it
  check a stricter limit than ever actually reached (decision B's caveat, made visible).
  - **DWC 3.6's `Axis.speed`/`.acceleration` fields — now directly confirmed**, not just inferred: found
    a real 3.6 checkout (`DuetWebControl-3.6-dev`, distinct from an unrelated same-named directory that
    turned out to be a different plugin's output folder) and read `@duet3d/objectmodel/dist/move/Axis.d.ts`
    directly — both fields present, same shape as 3.7.
  - Verification: `npm test` (513), `vitest run --typecheck` (clean), `DWC_DIR` typecheck against 3.7
    (clean, both before and after the `.vue` edits), `verify-build` against 3.7 (built + packaged clean),
    `check-ui36` against the real 3.6 checkout (5/5 SFCs compile under Vue 2.7, including both edited
    files).
  - **Not done, and cannot be done from here**: a live visual/hardware check. This project has no dev
    server and no component-mount test pattern (`@vue/test-utils` is a devDependency but unused) — a DWC
    plugin's real "browser" is DWC itself, loaded against a real board. What stands in for it here is the
    full chain above (typecheck, build, both frameworks' compilers) plus a manual line-by-line read of
    both card blocks against their surrounding file's own established patterns. That is real verification,
    not a placeholder, but it is not the same as watching the card render against a real tune result.

All four sections (model layer, host adapter, UI, both frameworks) are implemented and machine-verified.
Nothing has been committed. Everything from here is Jay's call: review the diff, and either request
changes or ask for it to be committed.

## Decided already (docs/PLAN-rail-detection.md §6.3/§6.4)

- **Identify at a moderate profile, then validate separately at the envelope.** Model-fit's P-ramp needs
  unsaturated headroom to measure anything; the field data shows tuning at max speed directly breaks
  identification outright (accel-peak already at 256, sat 1–4%, on the very first probe — no ramp, no
  measurement, P* collapses to the seed).
- **Report only. Never auto-change the tune.** If the envelope check shows saturation, log it and record
  it with the result; do not de-rate P automatically. Three releases have gone into removing cases where
  the plugin silently did something the user couldn't see (the stale-evaluation bug, the inflated noise
  floor) — auto-de-rating would add a new one, and lowering P may be the wrong lever anyway when the
  real limit at speed is back-EMF, which V (already solved after P) is what actually compensates for it.

## Investigated — the pieces exist, but not wired together

**The object model has what's needed.** `Axis` (`@duet3d/objectmodel`, confirmed against the DWC 3.7
checkout used for this project's typecheck) exposes `speed` (mm/s, M203) and `acceleration` (mm/s²,
M201) directly, alongside `min`/`max`/`homed` — the same object this plugin already reads for
`AxisLimits` (`src/model/limits.ts`). Needs re-confirming against a DWC 3.6 checkout (the object model
schema is RRF's, so almost certainly present there too, but "almost certainly" isn't "confirmed" —
someone should check before relying on it, the same discipline `PLAN-dwc36-backport.md` used throughout).

**The capture-planning machinery already generalises to "any feed".** `planCaptureProfile(axes,
feedMmPerMin, samples, sampleRateHz, marginMm, opts)` (`src/model/limits.ts:308`) takes the feedrate as
a parameter and auto-derives distance, start position, and (via `rateCeilingHz`) sample rate from it —
this is exactly the "auto" sizing already used for ordinary tuning moves, just never called with a feed
other than the UI's `avFeed.value`. An envelope capture is architecturally "call the same function with
a different feed", not new capture-planning logic.

**The CoreXY coupling math already exists.** `axis.speed`/`axis.acceleration` are Cartesian — the same
frame `AxisLimits.min/max` are in. A G1 H2 move on the tuned motor produces `F/60 × couplingFactor`
mm/s of *Cartesian* speed on axis, per `src/model/kinematics.ts`'s `forwardMatrix` reading (already
proven correct against real CoreXY field data — the sign-inversion bug it fixed). So converting "reach
this axis's configured Cartesian max" into "what motor-space F to send" is the same kind of conversion
`planCoupledSymmetricMove` already does for distance, not new territory. Still needs writing, but it
is not a research question.

## What is NOT yet decided — and changes the design, not just the code

### A. Does this run every time, or is it opt-in?

It costs one extra capture plus a reposition round-trip at the end of every successful run — on the
2026-09-07 field data, a full 3-cycle run already took 15–35 captures; this is a modest addition, not
a doubling. But "modest" on a fast board may not be modest on the 1HCL's truncation-prone setup this
whole thread has been about. Running it *only* when the tune graded below "good" (mirroring how
`runFinalVerification`'s correction pass already only fires below "good") would target it at exactly
the tunes worth double-checking, at zero cost to the tunes that already look fine — but a tune that
grades "good" on a gentle move can still be the one that saturates hardest at speed, so that's a real
trade-off, not a free optimisation.

### B. Configured M203/M201, or an entered print envelope?

The plan's own §6.4 flagged this and it is still open. A slicer's actual travel/print acceleration is
often well below the machine's configured ceiling — `M203`/`M201` are frequently set as a hard limit,
not a real operating point. Validating against the configured max answers "is this tune ever unsafe on
this machine", which is simpler and needs no new input. Validating against what the user actually
prints answers a more useful question but needs either a UI field or a link to values this plugin
doesn't currently have any reason to know.

### C. Where does the result surface?

"Report only" was decided; *how* was not. A log line (matching how §2 of the rail-detection plan
landed — as a log line, not a scored or even an unscored `evaluateTune` finding, because that function
is per-capture and has no run-level context) is the cheap, consistent-with-precedent option. A
dedicated UI element (badge on the results panel, a line in the evaluation card) is more visible but is
real `.vue` work, which brings `verify-build`/`check-ui36` into scope and is a bigger ask than this
plan has investigated the UI side of at all.

### D. What should the pass/fail line actually be?

`MODEL_FIT_SAT_ONSET = 0.02` (2% sat duty) is model-fit's own "the ramp should stop here" threshold —
appropriate for identification, where any saturation means the ramp has found the wrong answer. A
validation check asking "does this hold at print speed" is a different question and may reasonably
tolerate a *little* saturation at the extreme corner of the envelope without calling the tune unsafe.
Reusing `MODEL_FIT_SAT_ONSET` verbatim is the simplest option but hasn't been justified for this
different use.

## Concrete design

### The feed conversion needs every coupled axis, not just the tuned one

`coupledAxesForDriver()` (`useClosedLoopTuning.ts:568`) already returns `Array<CoupledAxisLimits>` —
every Cartesian axis the tuned motor's G1 H2 move displaces, each with `perUnit` (mm of that axis's own
Cartesian travel per 1 mm of motor travel), read from the object model's `forwardMatrix` row via
`kinematics.ts`. On CoreXY the tuned axis's own `perUnit` is **not** 1.0 — the field log already shows
"tuning Y moves X by +0.500 mm and Y by -0.500 mm per mm of motor travel" — so both coupled axes carry
comparable weight, and either one's configured max could be the real limiting factor, not just the
nominal tuned axis's own M203.

So the motor-space feed for the envelope capture is not "the tuned axis's own M203" — it is the
motor-space speed at which the **first** coupled axis to reach *its own* configured max does so:

```
motorFeedMmPerMin = 60 × min over coupled axes i of ( axis[i].speed / |perUnit[i]| )
```

exactly the same "every coupled axis's own limit, take the conservative one" pattern the existing
distance-planning code already uses (`planCoupledCenteredMove`) — this is not new reasoning, just the
same reasoning applied to speed instead of distance.

### Acceleration needs no separate handling

G1 H2 bypasses kinematics but **not** the axis's own configured motion parameters — RRF's individual-
motor mode still plans the move using that axis's own `M201`/`M203`/`M566`. So a capture already
accelerates at the axis's configured M201 by default; there is no separate "request this acceleration"
step to build. The only thing the envelope capture changes versus an ordinary tuning capture is the
feed — high enough that the limiting coupled axis's cruise speed reaches its own configured maximum.
(Whether the move is long enough to actually reach that cruise plateau, rather than being a pure
accel/decel triangle, is exactly what `planCaptureProfile`'s existing distance-sizing already handles —
no new logic needed there either.)

### Data flow

```
TuneEffects.checkEnvelope(): Promise<EnvelopeCheck | null>      // new, in tuneShared.ts
  → implemented in useClosedLoopTuning.ts: derive motorFeedMmPerMin as above, call the SAME
    captureRaw()-equivalent pipeline with that feed instead of avFeed.value, read back pTermSatDuty
  → EnvelopeCheck { feedMmPerMin: number; satDuty: number; holds: boolean }   // holds = satDuty < MODEL_FIT_SAT_ONSET

runAutoTune (autorun.ts) calls it once after runFinalVerification succeeds, on every run (decision A) —
logs the result either way, does not touch pid.

AutoRunResult.envelopeCheck?: EnvelopeCheck        // alongside ku/tu, same pattern
  → useClosedLoopTuning.ts: tuneSession.value.envelopeCheck = result?.envelopeCheck   (mirrors ku/tu at
    line 1452-1453)
  → TuneSession.envelopeCheck?: EnvelopeCheck        // new field, report.ts's downloadable report
    schema picks it up automatically since it already round-trips every TuneSession field
```

### UI

A card in the results column, `ui37/ClosedLoopTuning.vue` around line 436 (right after the existing
evaluation card, same column) and the parallel spot in `ui36/ClosedLoopTuningPage.vue`. Content: pass/
fail state, the feed it was checked at, and the plain-English "M203/M201 configured max" framing so a
user who's never seen this before understands what's being checked and why it might not match what
their slicer profile actually uses (decision B's caveat, made visible rather than hidden).

## Order of implementation

1. **Model layer** (`analysis.ts`/`autorun.ts`/`tuneShared.ts`, host-agnostic): `EnvelopeCheck` type,
   `TuneEffects.checkEnvelope`, the call site in `runAutoTune`, `AutoRunResult.envelopeCheck`. Fully
   unit-testable with fake effects, same style as every other `autorun.ts` test. **Do this first and
   verify it alone** — it is the actual logic; everything after this is plumbing it through to a host
   and a screen.
2. **Host adapter** (`useClosedLoopTuning.ts`): the coupled-axis feed derivation, `checkEnvelope`
   implementation, `TuneSession.envelopeCheck`, wiring at the `finally` block (~line 1452).
3. **UI** (`ui37/ClosedLoopTuning.vue`, `ui36/ClosedLoopTuningPage.vue`): the card. Requires
   `verify-build`/`check-ui36` and a dev-server look before calling it done — and note honestly that a
   *live hardware* look isn't possible without a run against real hardware, so "done" here means
   verified to render correctly against synthetic/replayed data, not confirmed against a live tune.

## What I did not investigate

- The exact `TuneEffects`/`AutoRunResult` plumbing (a new effects method vs. reusing `captureRaw` with
  a feed override; where the fact lives on `AutoRunResult` alongside `ku`/`tu`). Straightforward once
  A–D are answered, not worth designing against a decision that might change the shape.
- DWC 3.6's `Axis` object model fields — flagged above, not confirmed.
- Whether the same envelope check makes sense for `identifyMethod: "relay"` or `"continuous-cycling"`,
  which don't go through model-fit's ramp at all and may already be identifying closer to instability
  by construction (`identifyRelay` deliberately drives P into a bounded limit cycle). This plan has only
  looked at the model-fit path the field data actually exercised.
