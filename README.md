# Closed Loop Tuning Plugin (DWC 3.7 rework)

Tune and visualise a Duet closed-loop driver — the [Expansion 1HCL](https://docs.duet3d.com/Duet3D_hardware/Duet_3_family/Duet_3_Expansion_1HCL) or [Motor23CL](https://docs.duet3d.com/en/Duet3D_hardware/Duet_3_family/Duet_3_Motor_23CL) — from Duet Web Control.

> This repository is a **fork** of [Duet3D/ClosedLoopTuningPlugin](https://github.com/Duet3D/ClosedLoopTuningPlugin),
> ported to **DuetWebControl 3.7** (Vue 3 / Vuetify 4 / Pinia) and reworked to make tuning easier.
> Original plugin by Louis Irwin & Juan Rosario. GPL-3.0-or-later, as upstream.

## What this rework adds

- **DWC 3.7 port** — the original was a Vue 2 / DWC 3.5-era plugin that won't load on 3.7. Every component
  was rewritten to the Composition API + Vuetify 4, on the standard external-plugin Vite build via
  [`dwc-plugin-test-kit`](https://github.com/jaysuk/dwc-plugin-test-kit), with self-update + diagnostics
  through [`dwc-plugin-runtime`](https://github.com/jaysuk/dwc-plugin-runtime) (joins Flexible Layouts'
  unified update popup).
- **Mode + calibration control** — switch a driver between open / assisted-open / closed loop
  (`M569 D2/D5/D4`, shown literally before sending and overridable), and run the `M569.6` calibration
  manoeuvres (polarity/zero, magnetic cal, check, clear), filtered to your encoder type.
- **Guided tuning wizard** — steps through the documented procedure (P → D → I, plus advanced A/V),
  running a step capture and recommending whether to increase / decrease / accept each term.
- **Automatic step-response analysis** — every capture is reduced to rise time, overshoot, settling
  time, steady-state error and peak/RMS error, so you don't have to eyeball the graph.
- **Improved chart** — multi-axis plot, overlay a previous run to compare tunings, and CSV export.

The mode `D`-values default to the RRF 3.6/3.7 mapping (open=`D2`, closed=`D4`, assisted-open=`D5`) and
are shown before sending; an *Advanced* panel lets you override them per machine.

## Develop

```bash
npm install
npm test
DWC_DIR=/path/to/DuetWebControl npm run typecheck
DWC_DIR=/path/to/DuetWebControl npm run verify-build
```

The protocol builders, CSV parsing, step-response analysis and wizard logic are pure modules under
`src/model/` and are unit-tested. Releases: `npm run release -- <version> --push`.

## License

GPL-3.0-or-later.
