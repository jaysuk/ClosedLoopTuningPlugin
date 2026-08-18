# Plan: kinematics-aware (CoreXY) tuning-move safety

**Status:** implemented.

> **§5 assumption #1 — RESOLVED, and the plan's guess was WRONG.** Verified against RRF source
> (Duet3D/RepRapFirmware 3.6-dev): `CoreKinematics::MotorStepsToCartesian` computes
> `machinePos[axis] = Σ_motor forwardMatrix(motor, axis) * motorPos[motor]`, and the object model
> serialises that same order (`CoreKinematics.cpp` evaluates
> `forwardMatrix(context.GetIndex(1), context.GetLastIndex())`; `GetIndex(1)` is the OUTER index and
> `GetLastIndex()` the inner — see `ObjectExplorationContext::GetIndex`, `indices[numIndicesCounted-n-1]`).
> **The JSON is `forwardMatrix[motor][axis]`, so the tuned motor's effects are ROW `tunedAxisIndex`,
> not the column** as §2 of this plan assumed. Both readings are identical on CoreXY and cartesian
> (symmetric matrices), which is why the first implementation and its whole test suite passed while
> being transposed. They differ on markForged/coreXZ/coreXYU/coreXYUV — on markForged the column read
> reported tuning X as moving X only, missing a real 1:1 coupling to Y and leaving Y unbounds-checked.
> `kinematics.test.ts` now pins the convention with a non-symmetric markForged fixture.
**Severity:** safety-critical. Tuning moves use `G1 H2`, which bypasses RRF kinematics *and* M208 soft
limits — the plugin's own arithmetic is the only thing keeping a tuning move off the frame.
**Reported by:** Duet forum user, CoreXY + 2× 1HCL, RRF 3.7.0-beta.2, plugin 2.2.0. Diagnostics captured.

---

## 1. The bug

`limits.ts` plans every tuning move as if one axis == one motor == one Cartesian direction. On any
Core-style kinematics that is false: a single motor moves **more than one Cartesian axis**, and
possibly in the **opposite sign** to the axis it is named after.

The reporter's machine reports (`move.kinematics`, verbatim from the diagnostics):

```
name: "coreXY"
forwardMatrix: [[0.5,  0.5, 0],
                [0.5, -0.5, 0],
                [0,     0,  1]]
inverseMatrix: [[1,  1, 0],
                [1, -1, 0],
                [0,  0, 1]]
```

`forwardMatrix[i][j]` = mm of movement on **Cartesian axis `i`** per mm of movement on **motor `j`**.
(`inverseMatrix` is the reverse, Cartesian → motor: `motorA = X+Y`, `motorB = X−Y` — the standard
CoreXY belt equations. We only need `forwardMatrix`.)

Tuning the Y driver issues `G1 H2 Y<δ>`, which moves **only motor 1**. Motor-space delta = `(0, δ, 0)`:

```
ΔX = 0.5·0 + 0.5·δ + 0·0 = +0.5·δ
ΔY = 0.5·0 − 0.5·δ + 0·0 = −0.5·δ
ΔZ = 0
```

**Two independent defects follow:**

1. **Inverted sign.** `+δ` on the Y motor moves the toolhead in **−Y**. The planner assumes +Y, so it
   pre-positions to `mid − d/2` (near Y-min) and then drives *further* toward Y-min. Exactly the
   reported symptom ("moves toolhead close to Y-min, then tries to move even further toward Y=0").
2. **Unchecked coupled axis.** The same move displaces X by `+0.5·δ`, and **X's limits are never
   consulted**. This is the more dangerous half: on a different machine the X limit could be hit first,
   possibly on a side with no endstop.

Corroborating evidence in the diagnostics: board 50 (Y driver) reports `closedLoop: {points: 0,
runs: 0}` — never completed a single capture. Board 51 (X driver) reports `{points: 1379, runs: 43}`.

Worked example with the reporter's real numbers (X: min 0, max 230, pos 15; Y: min 0, max 246, pos 123;
margin 2 mm; auto distance 200 mm):

| | current (broken) | after fix |
|---|---|---|
| start | Y = 23 (X untouched, 15) | X = 65, Y = 173 |
| end | Y = **−77** ❌, X = **115** (unchecked) | X = 165, Y = 73 ✅ |

Note the fixed start has **Y above its midpoint** — matching the reporter's own intuition that "the Y
motor tuning would need to start near Y-max instead".

**Also worth telling the reporter:** X tuning on this machine is only working *by luck of geometry*, not
because it is unaffected. It drives the same two coupled motors and has the same unchecked-cross-axis
exposure; it just happens not to run out of room first.

---

## 2. Key insight that makes this tractable

Two facts collapse the problem to something simple and provable:

1. **Column `j` of `forwardMatrix` is exactly what we need.** For a tuned axis at index `j`, the vector
   `forwardMatrix[*][j]` gives the per-mm Cartesian effect on every axis. No hardcoded belt maths, no
   guessing at wiring conventions — RRF hands us the real per-machine transform.
2. **Only the two endpoints need checking.** The H2 move is a straight line in motor space, therefore a
   straight line in Cartesian space, and the safe region is an axis-aligned box (convex). If start and
   end are both inside, the entire path is inside. No sampling required.

And because the **pre-positioning move is a normal kinematic `G1`** (soft limits apply, arbitrary
XYZ reachable), we can freely choose *each* affected axis's start position independently.

---

## 3. Design

### 3.1 New module: `src/model/kinematics.ts` (pure, unit-tested)

```ts
/** Cartesian effect on one axis from +1 mm of H2 motion on the tuned axis's own motor. */
export interface CoupledAxisEffect {
  index: number;    // index into move.axes[]
  letter: string;
  perUnit: number;  // mm of movement on THIS axis per 1 mm of H2 motor movement
}

export interface MotionCoupling {
  index: number;                        // tuned axis index
  letter: string;
  effects: Array<CoupledAxisEffect>;    // every axis with |perUnit| > epsilon, INCLUDING the tuned axis
  fromMatrix: boolean;                  // false = independent-axis fallback
  kinematicsName: string;
}

export type MotionCouplingResult = MotionCoupling | { error: string };

export function resolveMotionCoupling(
  kinematics: unknown,   // model.move.kinematics
  axes: Array<unknown>,  // model.move.axes
  tunedAxisIndex: number,
): MotionCouplingResult;
```

Resolution rules, in order:

1. **Well-formed `forwardMatrix` and `tunedAxisIndex` is a valid column** → for each row `i` where
   `i < axes.length`, `perUnit = forwardMatrix[i][tunedAxisIndex]`; keep entries with
   `|perUnit| > COUPLING_EPSILON` (`1e-6`). Set `fromMatrix: true`.
   - Sanity check: if **every** effect is ~0, the matrix is nonsense for this axis → return an error
     rather than planning a move we can't reason about.
2. **Axis index beyond the matrix** (e.g. a U axis on a 3×3 coreXY matrix) → independent-axis fallback:
   a single effect `{index: tunedAxisIndex, perUnit: 1}`. Correct: no matrix row references that column.
3. **No matrix, and the kinematics name is `cartesian` or absent** → independent-axis fallback.
4. **No matrix, and the name is a known non-linear kinematics** (`delta`, `rotaryDelta`, `Scara`,
   `FiveBarScara`, `Polar`, `Hangprinter`) → **error**. These genuinely cannot be expressed as a linear
   motor↔Cartesian map; there is no safe distance to compute. Message must say tuning isn't supported on
   that kinematics rather than implying a config problem.
5. **Anything else (unrecognised name, no matrix)** → **error**, conservatively. Message should ask the
   user to report the kinematics name so it can be added.

Note `cartesian` machines *do* report an identity `forwardMatrix` (RRF's `CoreKinematics` covers
cartesian too), so rule 1 already handles them correctly and rule 3 is only a belt-and-braces fallback.
`markForged`, `coreXZ`, `coreXYU`, `coreXYUV` are all `CoreKinematics` and are handled generically by
rule 1 with no special-casing — do **not** add a per-name allowlist for those.

### 3.2 `src/model/limits.ts` — coupled planners

```ts
/** One axis's limits plus how much the tuned motor moves it. */
export interface CoupledAxisLimits extends AxisLimits {
  perUnit: number;
}

export interface CoupledCenteredMovePlan {
  distance: number;   // MOTOR-space mm, positive magnitude
  sign: 1;
  startPositions: Array<{ letter: string; position: number }>;  // machine coords, one per affected axis
}

export function planCoupledCenteredMove(
  axes: Array<CoupledAxisLimits>, desiredDistance: number, marginMm: number, minDistance: number,
): CoupledCenteredMovePlan | { error: string };

export function planCoupledSymmetricMove(
  axes: Array<CoupledAxisLimits>, desiredDistance: number, marginMm: number, minDistance: number,
): MovePlan | { error: string };
```

**Centred maths** (all distances motor-space):

```
for each axis a:
    available_a = (a.max - marginMm) - (a.min + marginMm)
    if available_a <= 0  -> error naming a (margin too large for this axis's travel)
    cap_a = available_a / |a.perUnit|
distance = min(desiredDistance, min_a cap_a)
if distance < minDistance -> error, naming the LIMITING axis and its available travel
for each axis a:
    startPosition_a = midpoint(a) - a.perUnit * distance / 2
```
End position is `midpoint(a) + a.perUnit * distance / 2`, symmetric about each axis's midpoint by
construction — which is why `sign` is always `+1` and direction genuinely does not matter for safety.

**Symmetric (one-way from current position) maths:**

```
headroomPlus_a  = a.perUnit > 0 ? ((a.max - marginMm) - a.position) / a.perUnit
                                : (a.position - (a.min + marginMm)) / (-a.perUnit)
headroomMinus_a = a.perUnit > 0 ? (a.position - (a.min + marginMm)) / a.perUnit
                                : ((a.max - marginMm) - a.position) / (-a.perUnit)
plus  = max(0, min_a headroomPlus_a)
minus = max(0, min_a headroomMinus_a)
useMax = plus >= minus;  best = max(plus, minus)
if best < minDistance -> error naming the limiting axis
distance = min(desiredDistance, best);  sign = useMax ? 1 : -1
```

**Keep `planCenteredMove` / `planSymmetricMove` as thin single-axis wrappers** that delegate with
`perUnit: 1` and adapt the return shape. This is deliberate: **all 25 existing `limits.test.ts` tests
must keep passing untouched**, which is the strongest available evidence that Cartesian behaviour has
not regressed.

> **Correction applied during implementation:** this "all 25 untouched" goal conflicts with §3.3's own
> `planCaptureProfile` signature change — 9 of those 25 call it with a bare axis object or `null`, which
> the array signature can't accept. Resolution: the two wrappers above are genuine no-change wrappers
> (their 16 tests are byte-identical), and `planCaptureProfile`'s 9 tests took a mechanical call-shape
> update only (`axis` → `[{...axis, perUnit: 1}]`, `null` → `[]`) with every expected value unchanged.

### 3.3 `planCaptureProfile`

Signature changes from `limits: AxisLimits | null` → `axes: Array<CoupledAxisLimits>` (empty array =
no-axis/extruder case, replacing the old `null`). `CaptureProfile.startPosition: number` becomes
`startPositions: Array<{ letter: string; position: number }>`.

The auto-mode "shrink the move to hold the rate floor" branch must **recompute `startPositions` from the
shrunken distance** — mirroring the existing `startPosition = midpoint(limits) - distance/2` recompute.

All distance constants (`AUTO_MOVE_CAP_MM`, `AUTO_MIN_DISTANCE_MM`, `CAPTURE_MIN_DISTANCE_FRACTION`) stay
**motor-space** — unchanged meaning, since the motor's own travel is what the encoder measures and what
the PID controls. On CoreXY a 200 mm motor move yields 100 mm of Cartesian travel per axis; that is
correct and intended.

### 3.4 `src/components/ClosedLoopTuning.vue`

1. Add `axisIndexForDriver(): number | null` beside the existing `axisForDriver()` — the matrix column
   index is the axis's index in `move.axes[]`.
2. Add `coupledAxesForDriver(): Array<CoupledAxisLimits> | { error: string }`:
   - resolve the coupling via `resolveMotionCoupling`;
   - for each effect, `getAxisLimits(...)` on that axis — **a coupled axis with no usable limits is a
     hard error, never a silent skip**;
   - **every** coupled axis must be `homed`, not just the tuned one. An unhomed coupled axis means its
     position is unknown, so the move cannot be proven safe.
3. `ensureAxisReady(...)` — take the coupled set; homed-check all of them; when centring, centre **all**
   coupled axes (one multi-axis `G1`), not just the tuned one.
4. `captureStep()` → `planCoupledSymmetricMove`.
5. `captureRaw()` → `planCaptureProfile` with the coupled set; the pre-position command becomes a single
   multi-axis move, e.g. `G90 G1 X65.000 Y173.000 F<CENTERING_FEED_MM_MIN>`.
6. Surface errors with the limiting axis named, and mention coupling, so the next report is
   self-diagnosing.

### 3.5 Logging (high value, low cost)

Log the resolved coupling once per run, before the first move:

```
Kinematics: coreXY — tuning Y moves X by +0.500 mm and Y by -0.500 mm per mm of motor travel.
Tuning move: 200.0 mm motor travel, limited by X (226.0 mm clear). Start: X=65.000 Y=173.000.
```

This turns any future forum report into an immediately diagnosable one.

---

## 4. Tests (required)

**`src/__tests__/kinematics.test.ts`** (new)
- cartesian / identity matrix → single effect, `perUnit: 1`.
- **The reporter's exact coreXY matrix**, tuned axis index 1 (Y) → effects `X: +0.5`, `Y: −0.5`;
  assert the tuned axis's own `perUnit` is **negative** (this is the whole bug in one assertion).
- Same matrix, tuned axis index 0 (X) → `X: +0.5`, `Y: +0.5`.
- Same matrix, tuned axis index 2 (Z) → Z only, `perUnit: 1` (Z is independent on CoreXY).
- Axis index beyond the matrix → independent fallback.
- Each non-linear kinematics name → error.
- Malformed matrix (ragged, non-numeric, empty) → error or fallback, never a bogus coupling.

**`src/__tests__/limits.test.ts`** (extend)
- All 25 existing tests pass **unchanged**.
- Coupled centred plan with the reporter's exact numbers (X 0–230 pos 15; Y 0–246 pos 123; margin 2;
  auto 200) → asserts `distance == 200`, `startPositions` = X 65 / Y 173, **start Y above Y's midpoint**,
  and both computed end positions inside `[min+margin, max−margin]`. This is the regression test that
  proves the reported bug is fixed.
- Coupled centred plan where the **coupled** axis is the limiting one (narrow X, wide Y) → distance
  clamped by X, error message names X.
- Coupled symmetric plan picks the direction with more room accounting for sign inversion.
- `perUnit` negative handled correctly in both planners (sign flips the headroom terms).

---

## 5. Assumptions to verify against RRF source before shipping

These are load-bearing. Verify them the same way the M569.5 bitmask was verified (read the actual
firmware source on `Duet3D/RepRapFirmware` / `Duet3D/Duet3Expansion`, not the docs):

1. **`G1 H2 <letter><d>` moves the motor in that axis's drive slot, and the matrix column index equals
   the axis index in `move.axes[]`.** Holds for standard CoreXY (axes[0]=X→motor0, axes[1]=Y→motor1) but
   must be confirmed, since the entire fix is indexed on it.
2. **`F` in an H2 move is motor-space feedrate.** The current code already assumes this; the capture
   window timing (`moveTimeS = distance / feed`) depends on it.
3. **Multi-driver axes** (`axis.drivers.length > 1`, e.g. dual-Z): which motor does H2 drive? Currently
   out of scope — but if the answer is "all of them" or "ambiguous", add an explicit guard rather than
   leaving it undefined.

---

## 6. Out of scope (note, don't fix here)

- **`machinePosition` vs `userPosition`.** Limits use `machinePosition`; `G90 G1` commands use *user*
  coordinates (workplace + tool offsets). The reporter's own data shows a 0.012 mm discrepancy — well
  inside a 2 mm margin, and this approximation already exists in shipped code. Using `G53` to command
  machine coordinates directly would remove the error class entirely; worth doing, but as its own change
  so this diff stays reviewable.
- `motorCurrentFraction` (`m569.ts`, bit 32768) has no corresponding `CL_RECORD_*` constant in current
  firmware — unrelated dead entry found earlier, clean up separately.

---

## 7. Process notes

- **Do not trust a local Windows `verify-build`.** Established earlier in this project: it reported
  "Type check passed" while CI (Linux) correctly failed on the same tree. Push and check the actual CI
  run, or compile an isolated repro with DWC's pinned `tsc`.
- Run `npm test` **and** `DWC_DIR=<3.7-dev checkout> npm run typecheck`; `verify-build`'s internal
  typecheck also scans `src/__tests__/**`, which the plugin's own `npm run typecheck` does not.
- Ship as **2.2.1** via `node scripts/release.mjs 2.2.1` (bumps both manifests, commits, tags).
- Reply to the forum reporter when released, including the "X was only safe by luck" note from §1.
