# Plan: dual DWC 3.6 / 3.7 support for Closed Loop Tuning

**Status:** planned, not started.
**Reference implementation:** `jaysuk/resonance-lab` (local: `c:\Users\live\Documents\Github\resonance-lab`)
already does exactly this. **Read it before writing code** — this plan describes how to apply its
pattern here, not how to invent one.

---

## 0. What this actually is

Not a "backport". DWC 3.6 and 3.7 are different framework stacks:

| | DWC 3.6.2 | DWC 3.7 (current target) |
|---|---|---|
| Framework | Vue **2.7** | Vue **3.5** |
| UI | Vuetify **2.7** | Vuetify **4** |
| State | Vuex 3 (`@/store`, singular) | Pinia (`@/stores/*`) |
| i18n | vue-i18n **8** (`i18n.t`) | vue-i18n 11 (`i18n.global.t`) |
| Build | vue-cli / webpack | Vite |
| chart.js | **2.9** | 4.x |

So the UI is rewritten, not ported. The good news, already verified: **all 18 files in `src/model/`
except `updateCheck.ts` have zero Vue/DWC/Vuetify imports** — 4,175 lines of framework-agnostic
TypeScript, including every tuning algorithm and the whole CoreXY safety fix. That ships to 3.6
unchanged. The work is a second UI shell plus build plumbing.

**Rough size:** ~1,522 lines of `ClosedLoopTuning.vue` to re-express in Vuetify 2, plus ~154 lines of
`CaptureChart.vue`, plus locally-reimplemented `AboutDialog`/`HelpTip`. For calibration, ResonanceLab's
equivalent page is 738 (3.6) vs 685 (3.7) lines — near 1:1, so expect a similar ratio here. This page
is more than twice that size and is a stepper-driven wizard, which is the single worst Vuetify 2↔4
migration case (see §6).

---

## 1. Read these first (reference implementation)

In `c:\Users\live\Documents\Github\resonance-lab`:

| File | Why |
|---|---|
| `src/core/host.ts` | **The central idea.** The DWC-version seam. Note the explicit rule: *no Vue types cross this boundary*. |
| `src/ui37/host.ts` / `src/ui36/host.ts` | Pinia vs Vuex implementations, ~55 lines each. Copy the shape. |
| `src/index.ts`, `src/ui36/index.ts`, `src/ui37/index.ts` | Registration differences, each documented inline. |
| `scripts/stage-dwc36.mjs` | Staged temp tree + dependency vendoring. Non-obvious and essential. |
| `scripts/typecheck.mjs` | Why they wrote their own instead of using the test-kit binary (see §7.1). |
| `build36.bat`, `.github/workflows/release.yml` | Two-artifact build/release. |
| `package.json` → `dwcTypecheckIgnore` | How `ui36` is excluded from the Vue 3 typecheck. |

---

## 2. Target layout

```
src/
  model/          # UNCHANGED, shared — the algorithms + CoreXY fix
  core/
    host.ts       # NEW: HostAdapter interface (no Vue types)
  i18n/en.json    # shared verbatim by both UIs
  updateCheck.ts  # MOVED from model/, refactored onto HostAdapter
  index.ts        # becomes: export * from "./ui37/index";
  ui37/
    index.ts          # from today's src/index.ts
    host.ts           # NEW: Pinia adapter
    ClosedLoopTuning.vue   # from src/components/
    CaptureChart.vue       # from src/components/
  ui36/                    # ALL NEW — Vue 2.7 / Vuetify 2
    index.ts  host.ts  ClosedLoopTuningPage.vue  CaptureChart.vue
    AboutDialog.vue  HelpTip.vue
```

---

## 3. Phase 0 — extract the host seam (3.7 only, no behaviour change)

**Do this first, alone, and prove no regression before touching anything else.** It is the only phase
that can break the working 3.7 plugin, so keep it isolated and separately committable.

The coupling surface is small — measured, not guessed:

| Call | Count |
|---|---|
| `uiStore.makeNotification` | 18 |
| `machineStore.model` | 9 |
| `machineStore.sendCode` | 8 |
| `machineStore.getFileList` | 1 |
| `(machineStore as any).download` | in `loadLatestCsv` |
| plus `upload` (config.g save) and `installPlugin` (`updateCheck.ts`) | |

Steps:
1. Write `src/core/host.ts` — copy ResonanceLab's interface, trim to what this plugin needs:
   `model()`, `isConnected()`, `sendCode()`, `download()`, `upload()`, `getFileList()`,
   `installPlugin()`, `assetPattern`, `notify()`, `t()`.
   Keep ResonanceLab's doc note that `model()` **must** be a live reactive read every call, never a
   cached snapshot — this plugin's `watch(() => selectedBoard.value?.closedLoop?.runs, …)`
   capture-completion detection depends on exactly that.
2. Write `src/ui37/host.ts` (Pinia).
3. Refactor `ClosedLoopTuning.vue` and `updateCheck.ts` to take the adapter instead of importing
   stores. `autorun.ts`'s existing `TuneEffects` already proves the pattern works here — this is the
   same idea one layer out.
4. **Verify:** `npm test` (320 tests), `DWC_DIR=<3.7 checkout> npm run typecheck`, then
   `npm run verify-build`. Commit. Ideally smoke-test on a real machine before continuing.

---

## 4. Phase 1 — restructure directories

Move files per §2. `src/index.ts` becomes a one-line re-export. No logic changes. Re-run the full
3.7 verification; the 3.7 ZIP must be byte-equivalent in behaviour.

---

## 5. Phase 2 — build & release machinery

1. **`scripts/stage-dwc36.mjs`** — adapt ResonanceLab's near-verbatim.
   - `INCLUDE = ["model", "core", "i18n", "ui36", "updateCheck.ts"]`
   - `VENDOR = ["chart.js", "dwc-plugin-runtime"]` — **required**, see §7.3.
   - Generates a `src/index.ts` re-exporting `./ui36/index`.
2. **`scripts/typecheck.mjs`** — port ResonanceLab's, add `"dwcTypecheckIgnore": ["ui36"]` to
   `package.json`. **Do not keep using `dwc-plugin-typecheck` for the 3.6 path** (§7.1).
3. **`build36.bat`** — copy, change `PLUGIN_ID` to `ClosedLoopTuning` and the stage dir.
4. **`.github/workflows/release.yml`** — add the 3.6 job mirroring ResonanceLab's: checkout
   `v3.6-dev`, `npm install` DWC 3.6 (but **not** the plugin's deps — vendoring handles that), stage,
   build, rename to `…-dwc36.zip`, and widen the release `files:` glob so both ZIPs publish.
5. **`assetPattern`** in both hosts — verbatim from ResonanceLab, including the negative lookahead
   that stops the 3.7 pattern matching the `-dwc36` or `-srcmap` siblings. Without this the
   self-updater offers 3.6 users the Vue 3 package.

---

## 6. Phase 3 — the DWC 3.6 UI

The bulk. `ClosedLoopTuning.vue` is a `v-stepper` wizard, which is the hardest Vuetify 2↔4 case.

**Vuetify 4 → 2 translation table** (every one of these is a silent-breakage risk):

| Vuetify 4 (current) | Vuetify 2 (3.6) |
|---|---|
| `<v-stepper :items="…">` + `#item.1` slots | `v-stepper` + `v-stepper-header` + `v-stepper-items` + `v-stepper-content` — **structural rewrite** |
| `item-title` / `item-value` on `v-select` | `item-text` / `item-value` |
| `density="compact"` | `dense` |
| `variant="outlined"` / `"tonal"` / `"flat"` | `outlined` / (no tonal — approximate) / `flat` |
| `#append-inner` on `v-text-field` | `#append` |
| `v-btn-toggle` `mandatory` + `divided` | `mandatory` exists; no `divided` |
| `v-expansion-panel-title` / `-text` | `v-expansion-panel-header` / `-content` |
| `prepend-icon` on `v-btn` | slot-based `<v-icon left>` |
| `v-alert` `#append` slot | no such slot — restructure |

Also required in `ui36/`:
- **`AboutDialog.vue` + `HelpTip.vue`** reimplemented locally — `dwc-plugin-runtime`'s are Vue 3
  render functions using `resolveComponent` (§7.4).
- **`CaptureChart.vue`** against the *vendored* chart.js 4, not DWC 3.6's own 2.9.
- **`index.ts`** — see §7.5 for the registration differences.

**Suggested order:** `host.ts` → `index.ts` (get an empty page routing) → chart → the stepper steps
one at a time, verifying the build after each. Do **not** write all 1,500 lines then build.

---

## 7. Landmines (found the hard way — do not rediscover these)

### 7.1 `dwc-plugin-typecheck` silently FALSE-PASSES against DWC 3.6
Verified. It copies `src/` into the DWC tree, runs `npx vue-tsc`, and filters output for lines
mentioning the plugin path. **DWC 3.6 has no `vue-tsc` installed** — the command fails, produces no
matching lines, and the script prints `Type-check passed.` A green typecheck against a 3.6 checkout
means *nothing*. This is why ResonanceLab ships its own `scripts/typecheck.mjs`. Trust only
`verify-build` (which runs DWC's own strict `typeCheckPlugin`) and CI.

### 7.2 `ui36/` gets no type checking at all
It is excluded from the Vue 3 typecheck by `dwcTypecheckIgnore`, and 3.6 can't type-check it. The
webpack build and manual testing are the only safety nets. Budget for that.

### 7.3 chart.js version clash — vendoring is mandatory
Plugin needs chart.js 4; DWC 3.6 ships 2.9 (`chart.js/auto` doesn't even exist there). Installing v4
into the 3.6 checkout would break DWC's own charts. `stage-dwc36.mjs` instead copies chart.js **and
its full dependency closure** (e.g. `@kurkle/color`) into `src/node_modules/` inside the staged tree —
webpack resolves by walking up from the importing file, so the plugin's copy wins. Same for
`dwc-plugin-runtime`, which 3.6 has never heard of.

### 7.4 `dwc-plugin-runtime` barrel is Vue 3 only
Import **subpaths** in `ui36` (`dwc-plugin-runtime/diagnostics` for `installErrorCapture`), never the
barrel — it pulls in Vue 3 components. Anything component-shaped (AboutDialog, HelpTip) is
reimplemented locally.

### 7.5 DWC 3.6 registration differences
- `registerRoute` comes from `@/routes`, **not** `@/plugins`.
- **No `registerPluginMessages`.** Use `i18n.mergeLocaleMessage("en", { plugins: { closedLoopTuning: en } })`
  so the same `src/i18n/en.json` and the same `plugins.closedLoopTuning.*` keys serve both builds.
- **No `dwcPluginUnloaded`** event — nothing to unregister from; the error capture lives for the session.
- **No `unregisterRoute`** equivalent to today's cleanup path.
- **Sidebar caption trap:** do *not* set `translated: true` alongside an i18n key. In 3.6, App.vue
  renders `page.translated ? page.caption : $t(page.caption)`, so the flag puts the literal string
  `plugins.closedLoopTuning.menuCaption` in the sidebar.

### 7.6 vue-i18n 8 vs 11
`i18n.t(...)` in 3.6; `i18n.global.t(...)` in 3.7. Confine this to the two `host.ts` files — the
existing `TS2339: Property 'global' does not exist on type 'VueI18n'` error seen when building this
plugin against 3.6 is exactly this.

### 7.7 `installPlugin` signature differs
3.6's Vuex action wants the **parsed** archive too: `{ zipFilename, zipBlob, zipFile, start }`, where
`zipFile` comes from JSZip (a DWC 3.6 dependency — import it lazily so it only costs on a real
self-update). 3.7 parses internally.

---

## 8. Verification checklist

- [ ] `npm test` — all 320 tests still pass (model layer untouched throughout)
- [ ] `DWC_DIR=<3.7> npm run typecheck` **and** `npm run verify-build` — clean
- [ ] `build36.bat` produces `ClosedLoopTuning-<ver>-dwc36.zip`
- [ ] Both ZIPs install: 3.7 package on a 3.7 DWC, 3.6 package on a 3.6 DWC
- [ ] 3.6 package **refuses** to install on 3.7 and vice-versa (`dwcVersion: auto-major` handles this)
- [ ] Self-update on each generation offers *its own* asset (`assetPattern`)
- [ ] On a real machine, on 3.6: driver list populates, encoder calibration runs, a full auto-tune
      completes, chart renders, report downloads
- [ ] **CoreXY specifically:** the coupling log line appears and `G1 H2 Y10` moves ΔY **−5** /
      ΔX **+5** (see `PLAN-corexy-coupling.md` §; this is the whole reason the 3.6 build is wanted)

---

## 9. Scope reality check

Phase 3 is the cost centre and it is ongoing, not one-off: every future UI change lands twice, against
diverging framework stacks, with **one of the two having no type safety**. ResonanceLab shows it is
sustainable — but it was built that way from early on, whereas this is a retrofit onto a page twice
the size.

If effort needs cutting, the honest options are (a) ship a 3.6 build with a **reduced** UI — driver
select, mode, calibrate, auto-tune, save — omitting manual tuning, the advanced capture panel, and the
overlay chart controls, since the algorithms are what 3.6 users actually lack; or (b) don't ship 3.6
and point users at 3.7. Decide before Phase 3, not during it.
