# Plan: M956's P parameter changed meaning in RRF 3.7.0-rc.1 — a breaking change, not an addition

## Status: implemented 2026-09-09, unverified against real hardware

`src/model/firmwareVersion.ts` (new, semver comparator), `src/model/accelerometer.ts`
(`useAccelNumberAddressing` on `buildAccelCaptureCommand`), `src/core/useClosedLoopTuning.ts`
(`useAccelNumberAddressing` computed off `boards[0].firmwareVersion`, wired into both call sites).
18 new tests (`firmwareVersion.test.ts` + 3 in `accelerometer.test.ts`). 531 tests pass,
`vitest run --typecheck` clean, `DWC_DIR` typecheck against a real 3.7 checkout clean. No `.vue` touched.
Not committed. **Still nothing here has been run against real 3.7rc1 firmware** — see "What is NOT
verified" below; that section is the actual status, not a formality.

Investigated 2026-09-09. **No 3.7rc1 hardware was available to verify any of this empirically** — every
claim below is read directly from the official firmware source diff, cited by file/line. Jay's own
decision (asked explicitly): implement from this source reading now rather than wait for hardware,
accepting the risk that something here is subtly wrong until a real rc1 report confirms it. Treat the
`Capture command:` log line (already existing, `docs/PLAN-capture-integrity.md` §5) as the fastest way
to check this from the next field report — it will show exactly what was sent.

## What actually changed (not a new capability — an incompatible one)

Diffed the official `Duet3D/RepRapFirmware` GitHub tags directly:
- `3.7.0-beta.3` (`5aae39a745ef0b5bc3bc23a5103e22c7e55f355d`) — matches this plugin's field data
  (`firmwareVersion: "3.7.0-beta.3+1"` in the 2026-09-07 reports).
- `3.7.0-rc.1` (`6bdc5514ec29d03e25d1baf60f3479e1307582a6`).

`src/Accelerometers/Accelerometers.cpp`, `StartAccelerometer` (the M956 handler):

```
// beta.3
gb.MustSee('P');
const DriverId device = gb.GetDriverId();
…
if (device.IsRemote()) { … CanInterface::StartAccelerometer(device, …); }

// rc.1
const size_t accelerometerNumber = (seenP) ? gb.GetLimitedUIValue('P', MaxAccelerometers) : 0;
(void)accelerometerNumber;   // currently we support only a single accelerometer at a time so P must be zero
…
if (remoteBoardAddress != CanInterface::GetCanAddress()) {
    CanInterface::StartAccelerometer(remoteBoardAddress, 0, axes, numSamples, mode, gb, reply);
}
```

- **Old:** `P` is a `DriverId` (`board.driver`, e.g. `P121.0`) — it both selects the accelerometer AND is
  how the command gets CAN-routed to the right board.
- **New:** `P` is a small integer accelerometer *index* (0-based, currently must be 0 — multi-accelerometer
  support isn't wired up yet). It carries **no board-routing information at all**. Routing is now
  **implicit**: a file-scope `static CanAddress remoteBoardAddress` remembers which board owns the
  configured accelerometer, set the last time `M955`'s new `C<board>.<port>` parameter ran (`M955`'s own
  diff shows the same restructuring — `C` picks the board+pins now, not `P`).

`GetDriverId()` and `GetLimitedUIValue()` are genuinely different parsers
(`GCodeBuffer.cpp`/`StringParser.cpp`, confirmed by reading both) — this is not a tolerant reinterpretation
of the same token, it is a different parameter type.

## This plugin sends the old syntax unconditionally today

`src/model/accelerometer.ts`:
```ts
const parts = [`M956 P${opts.device}`, `S${opts.samples}`, `A${opts.activate}`];
```
called from `src/core/useClosedLoopTuning.ts` (two sites) with `device: `${board.boardAddress}.0``,
building e.g. `M956 P121.0 S2000 A1 …`.

## What that produces on rc.1+ (traced through the real parser)

`StringParser::GetUIValue` reads the token's leading digits and stops at the first non-digit — confirmed
by reading `StringParser.cpp` directly, not assumed. `"121.0"` parses as the integer `121`, silently
dropping `.0` (no parse-level crash). It then fails `GetLimitedUIValue`'s own range check
(`ret >= maxValuePlusOne`) with **`"parameter 'P' too high"`**, a clean G-code error prefixed `M956:` by
RRF's own command-echo convention (`GCodes2.cpp`, already relied on by `isAccelOnlyError` in this
codebase). So the existing soft-failure retry/disable path (`noteAccelSoftFailure` → `disableAccel` after
repeated failures) already degrades this *somewhat* gracefully today — repeated clean errors, not a crash
or corrupted data — but the accelerometer feature is still functionally broken on rc.1+ without this fix:
every capture would hit this error and eventually disable itself for the whole session.

## The fix

### 1. A real firmware-version comparator (`src/model/firmwareVersion.ts`, new)

RRF versions are semver-shaped (`3.7.0-beta.3+1`, `3.7.0-rc.1`, `3.6.0`) and need real precedence
handling — `"3.7.0-rc.1" > "3.7.0-beta.3"` is not a fact plain string comparison gets right in general
(it happens to work for these two specific words, which is not something to rely on). Implement full
semver precedence (numeric release triplet, then prerelease identifiers compared per the semver spec:
numeric identifiers compare numerically, alphanumeric ones lexically, numeric < alphanumeric at the same
position, fewer identifiers = lower precedence, no prerelease > any prerelease). Build metadata (`+1`) is
parsed but never affects comparison, per spec — RRF's own build-number suffix.

`firmwareAtLeast(version, atLeast)`: **an unparseable or missing version must return `false`**, never
`true` — an unknown version must not silently unlock behaviour that was never verified against it. This
matters here specifically: if `boards[0].firmwareVersion` is ever missing/malformed, the plugin must fall
back to the OLD (known-working on everything up to rc.1) syntax, not guess.

### 2. Which board's version matters — confirmed, not assumed

The relevant firmware is whichever board actually **parses** the M956 text — that's always
`boards[0]`, the board DWC is connected to (M956 gets forwarded internally by RRF's own new
`remoteBoardAddress` mechanism from there, per the diff above). **Not** `selectedBoard` (the tuned
driver's board) and **not** `accelerometerBoard` (the accelerometer's own board) — this codebase's own
existing comment already notes those are frequently different boards from each other. Confirmed
`boards[0]` is the main/connected board by checking DWC's own source, not just RRF convention:
`DuetWebControl/src/pages/Explorer/[[tab]]/[[volume]]/[[...path]].vue:677` —
`const mainboard = machineStore.model.boards[0]`.

### 3. `buildAccelCaptureCommand` gets a mode flag

```ts
export interface AccelCaptureOptions {
    /** M956 P for RRF < 3.7.0-rc.1 (a DriverId, e.g. "121.0") — ignored, P0 sent instead, when
     *  useAccelNumberAddressing is true. See docs/PLAN-rc1-accelerometer-addressing.md. */
    device: string;
    /** True for RRF >= 3.7.0-rc.1: P became a small accelerometer index (must be 0 today) with no
     *  board-routing meaning at all — routing is now implicit from the board's own M955 config. */
    useAccelNumberAddressing?: boolean;
    samples: number;
    activate: 0 | 1;
    axes?: Array<"X" | "Y" | "Z">;
    filename?: string;
}
```
`buildAccelCaptureCommand` sends `P0` when the flag is set, `P${opts.device}` otherwise.

### 4. Wire it in `useClosedLoopTuning.ts`

A computed alongside `selectedBoard`:
```ts
const useAccelNumberAddressing = computed(() =>
    firmwareAtLeast((host.model() as any).boards?.[0]?.firmwareVersion, "3.7.0-rc.1"));
```
passed into both `buildAccelCaptureCommand` call sites (the probe capture and the real capture).

## Verification available without hardware

- Unit tests on `firmwareVersion.ts` — fully pure, no host, covers the semver edge cases directly
  (alpha < beta < rc < final release; build metadata ignored; malformed input never satisfies the check).
- Unit tests on `buildAccelCaptureCommand`'s two modes.
- `npm test`, `vitest run --typecheck`, `DWC_DIR` typecheck (no `.vue` touched — this is model/core only).

## What is NOT verified, and how to close the gap

The parser-tracing above (P truncates at `.` → range-check failure → clean `M956:` error) was read from
source, not observed. When a report from real 3.7rc1+ hardware exists, check the `Capture command:` log
line — it now logs the literal M956 text either way, so confirming "did it send `P0`" and "did it
succeed" needs nothing more than reading that one line and the run's own success/failure.

## Separate, not part of this plugin: config.g's own M955 line

`M955`'s diff shows the identical restructuring: `P` there also changed from a `DriverId` to a small
`accelerometerNumber`, and board+pin selection moved to a new `C<board>.<port>` parameter (e.g.
`C121.i2c.lis`) instead of `P`. This plugin never sends M955 itself — it only reads an
already-configured accelerometer from the object model — so this is entirely a config.g concern, not
something this fix touches. **Flagged for Jay directly, not just left in this doc**: anyone upgrading to
3.7rc1+ with an old-style `M955 P<driverId> C<pins> …` line in config.g will need to update it to the
new `M955 C<board>.<port> …` form, or the accelerometer won't configure at all on boot. Worth a line in
whatever changelog/forum post accompanies a release that claims rc1 support.
