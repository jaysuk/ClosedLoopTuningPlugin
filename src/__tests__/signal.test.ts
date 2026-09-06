/**
 * computeTuneSignal / signalUnstable ground-truthed against real closed-loop captures, including the
 * ones that destabilised a loaded axis in the field (see src/__tests__/fixtures — captured with the
 * PID P Term column, so satDuty/postMoveOsc are measured, not estimated).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseCapture } from "../model/csv";
import {
	comparableCost, computeTuneSignal, medianSignal, oscillationAmplitude, oscillationPeriod, signalCost,
	signalCostNoEffort, signalDiverging, signalUnstable, significantlyBetter, significantlyBetterForTerm,
	termAwareCost, withinNoise, type TuneSignal,
} from "../model/signal";

const FIXTURE_DIR = path.join(__dirname, "fixtures");
function load(name: string) {
	return parseCapture(readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}
function signalOf(name: string): TuneSignal {
	const s = computeTuneSignal(load(name), 2000);
	if (!s) { throw new Error(`${name}: computeTuneSignal returned null`); }
	return s;
}

describe("computeTuneSignal — capture validation", () => {
	it("returns null for a capture with too few samples (a truncated/corrupt CSV)", () => {
		const header = "Sample,Timestamp,Measured Motor Steps,Target Motor Steps,PID P Term\n";
		const rows = Array.from({ length: 10 }, (_, i) => `${i},${i},${i * 0.1},${i * 0.1},0`).join("\n");
		const capture = parseCapture(header + rows);
		expect(computeTuneSignal(capture, 2000)).toBeNull();
	});

	it("returns null when a garbled row NaNs out a core stat (a race with the firmware still writing the file)", () => {
		// This reproduces the field failure: a capture that looked like "rms 0.00, bias NaN" instead of
		// a real (if bad) measurement — every stat that sums over the data silently propagates the NaN.
		const header = "Sample,Timestamp,Measured Motor Steps,Target Motor Steps,PID P Term\n";
		const goodRows = Array.from({ length: 100 }, (_, i) => `${i},${i * 0.5},${i * 0.1},${i * 0.1},0`);
		goodRows[50] = "50,25,not-a-number,25.0,0"; // one garbled row
		const capture = parseCapture(header + goodRows.join("\n"));
		expect(computeTuneSignal(capture, 2000)).toBeNull();
	});

	it("still accepts a real, fully-numeric capture at the sample-count floor", () => {
		const header = "Sample,Timestamp,Measured Motor Steps,Target Motor Steps,PID P Term\n";
		const rows = Array.from({ length: 60 }, (_, i) => `${i},${i * 0.5},${i * 0.1},${i * 0.1},0`);
		const capture = parseCapture(header + rows.join("\n"));
		expect(computeTuneSignal(capture, 2000)).not.toBeNull();
	});

	it("accepts a capture RRF cut short with a trailing 'Data lost' line — the rows that DID arrive are still valid, not NaN-poisoned", () => {
		expect(computeTuneSignal(load("hold-truncated-datalost.csv"), 2000)).not.toBeNull();
	});
});

describe("computeTuneSignal — stable captures", () => {
	it.each([
		"step16-stable-lowP.csv",
		"step16-stable-midP.csv",
		"step16-stable-converged.csv",
		"move250-stable-early.csv",
		"move250-stable-best.csv",
		"move250-escalation-1.csv",
		"move250-escalation-2.csv",
		"hold-stable-transient.csv",
	])("%s is not flagged unstable", (name) => {
		expect(signalUnstable(signalOf(name))).toBe(false);
	});

	it("move250-stable-best has a small tracking-error rms", () => {
		expect(signalOf("move250-stable-best.csv").stats.moveRms).toBeLessThan(1);
	});
});

describe("computeTuneSignal — the captures that destabilised a loaded axis", () => {
	it("flags the onset of instability (P-term saturating ~14% of the capture)", () => {
		const s = signalOf("move250-instability-onset.csv");
		expect(s.pTermSatDuty).toBeGreaterThan(0.1);
		expect(signalUnstable(s)).toBe(true);
	});

	it("flags the full runaway (P-term railed a third of the capture, error hundreds of steps)", () => {
		const s = signalOf("move250-runaway.csv");
		expect(s.pTermSatDuty).toBeGreaterThan(0.3);
		expect(s.stats.movePeak).toBeGreaterThan(100);
		expect(signalUnstable(s)).toBe(true);
	});

	it("flags the standstill limit cycle (motor buzzing while meant to hold position)", () => {
		const s = signalOf("hold-limit-cycle.csv");
		expect(s.postMoveOsc).toBeGreaterThan(10);
		expect(signalUnstable(s)).toBe(true);
	});

	it("does NOT flag the equivalent stable hold as unstable", () => {
		const s = signalOf("hold-stable-transient.csv");
		expect(signalUnstable(s)).toBe(false);
	});
});

describe("signalDiverging", () => {
	it("flags a tracking-error blowup relative to the best attempt", () => {
		const best = signalOf("move250-stable-best.csv");
		const worse = signalOf("move250-runaway.csv");
		expect(signalDiverging(best, worse)).toBe(true);
	});

	it("does not flag two similarly-good attempts", () => {
		const a = signalOf("move250-stable-early.csv");
		const b = signalOf("move250-escalation-1.csv");
		expect(signalDiverging(a, b)).toBe(false);
	});
});

describe("computeTuneSignal — autocorrelation fallback for oscPeriod", () => {
	it("finds a period the zero-crossing gate misses on a small, fast-decaying at-rest oscillation", () => {
		const n = 300;
		const rateHz = 2000;
		const period = 30; // samples
		const decayPerCycle = 0.55;
		const header = "Sample,Timestamp,Measured Motor Steps,Target Motor Steps,PID P Term\n";
		const rows: Array<string> = [];
		for (let i = 0; i < n; i++) {
			const cycles = i / period;
			const amp = 1.2 * Math.pow(decayPerCycle, cycles); // decays fast enough to duck under a fixed gate
			const measured = 100 + amp * Math.sin((2 * Math.PI * i) / period);
			rows.push(`${i},${(i / rateHz) * 1000},${measured.toFixed(4)},100,0`);
		}
		const capture = parseCapture(header + rows.join("\n"));
		const s = computeTuneSignal(capture, rateHz);
		expect(s).not.toBeNull();
		expect(s!.oscPeriod).not.toBeNull();
		const periodSeconds = period / rateHz;
		expect(s!.oscPeriod!).toBeGreaterThan(periodSeconds * 0.7);
		expect(s!.oscPeriod!).toBeLessThan(periodSeconds * 1.3);

		// Confirm this genuinely exercises the fallback: the primary zero-crossing method, given the same
		// (generous) threshold computeTuneSignal itself would use, must NOT find a period on this capture.
		const time = Array.from({ length: n }, (_, i) => i / rateHz);
		const measured = capture.columns["Measured Motor Steps"];
		const error = measured.map((m) => m - 100);
		const primary = oscillationPeriod(error, time, 0, n, Math.max(0.3, 3 * s!.stats.restNoise));
		expect(primary).toBeNull();
	});
});

describe("oscillationPeriod", () => {
	it("returns null when there aren't enough gated crossings", () => {
		const flat = new Array(50).fill(0);
		const time = flat.map((_, i) => i * 0.001);
		expect(oscillationPeriod(flat, time, 0, flat.length, 0.3)).toBeNull();
	});
	it("measures the period of a clean sine-like oscillation", () => {
		const n = 400;
		const dt = 0.001;
		const time = Array.from({ length: n }, (_, i) => i * dt);
		const period = 0.05; // seconds
		const values = time.map((t) => 5 * Math.sin((2 * Math.PI * t) / period));
		const measured = oscillationPeriod(values, time, 0, n, 0.5);
		expect(measured).not.toBeNull();
		expect(measured!).toBeGreaterThan(period * 0.8);
		expect(measured!).toBeLessThan(period * 1.2);
	});
});

describe("signalCost", () => {
	it("is Infinity for an unstable capture", () => {
		expect(signalCost(signalOf("move250-runaway.csv"))).toBe(Infinity);
		expect(signalCost(signalOf("hold-limit-cycle.csv"))).toBe(Infinity);
	});

	it("ranks the best stable capture lower than an earlier, noisier stable one", () => {
		const best = signalCost(signalOf("move250-stable-best.csv"));
		const early = signalCost(signalOf("move250-stable-early.csv"));
		expect(best).toBeLessThan(early);
	});

	it("ranks a clean capture lower than one on the edge of instability", () => {
		const best = signalCost(signalOf("move250-stable-best.csv"));
		const onset = signalCost(signalOf("move250-instability-onset.csv"));
		expect(best).toBeLessThan(onset);
	});

	// Real field case (docs/PLAN-standstill-effort.md): package/refine's ONLY objective is this
	// function, and until this term existed it had no P-term/effort data in it at all — a small
	// encoder-scale dither with near-zero restBias and no railing could be jointly optimised straight
	// past. Uses the real user captures, not hand-built fakes.
	it("costs a real dithering capture more than the equivalent settled one", () => {
		const dither = signalOf("hold-dither-i0.csv");
		const settled = signalOf("hold-settled-i23.csv");
		expect(dither.restEffort.restTailValid).toBe(true);
		expect(settled.restEffort.restTailValid).toBe(true);
		expect(signalCost(dither)).toBeGreaterThan(signalCost(settled));
	});

	it("an invalid rest-effort tail contributes nothing to cost — never a penalty for an unmeasurable capture", () => {
		const base = signalOf("move250-stable-best.csv");
		const invalid: TuneSignal = { ...base, restEffort: { ...base.restEffort, restTailValid: false, pTermRestRipple: 999 } };
		const zeroRipple: TuneSignal = { ...base, restEffort: { ...base.restEffort, restTailValid: true, pTermRestRipple: 0 } };
		expect(signalCost(invalid)).toBeCloseTo(signalCost(zeroRipple), 6);
	});
});

// docs/PLAN-capture-window.md §3: "contributes nothing" above is exactly the defect in a COMPARISON —
// 0 is the best attainable value of the rest-effort term, so a capture whose tail could not be judged
// outscores one that was measured and found perfectly settled. comparableCost/signalCostNoEffort fix
// this by dropping the term from BOTH sides of a comparison whenever either one can't be judged.
describe("signalCostNoEffort / comparableCost", () => {
	// Real dithering capture vs. the SAME capture with only its tail marked unjudgeable — nothing
	// physically different. These are exact measured numbers, not estimates: if either fails, the
	// implementation drifted, not the fixture.
	const dither = signalOf("hold-dither-i0.csv");
	const unjudged: TuneSignal = { ...dither, restEffort: { ...dither.restEffort, restTailValid: false } };

	it("does not let an unmeasurable rest tail outscore the very same capture measured", () => {
		// The bug, pinned: on the full cost the unjudgeable copy looks better (lower) by the entire
		// rest-effort term, purely because it can't be judged rather than because anything improved.
		expect(signalCost(dither)).toBeCloseTo(0.5264, 3);
		expect(signalCost(unjudged)).toBeCloseTo(0.3248, 3);
		expect(signalCost(unjudged)).toBeLessThan(signalCost(dither));
		// The fix: compared against each other, both are judged only on terms both actually have — equal.
		const cost = comparableCost([dither, unjudged]);
		expect(cost(unjudged)).toBeCloseTo(cost(dither), 10);
	});

	it("still uses the full cost when every candidate has a measurable tail", () => {
		const settled = signalOf("hold-settled-i23.csv");
		expect(comparableCost([dither, settled])).toBe(signalCost);
	});

	it("falls back to the effort-free cost as soon as ANY candidate is unjudgeable", () => {
		const settled = signalOf("hold-settled-i23.csv");
		expect(comparableCost([settled, unjudged])).toBe(signalCostNoEffort);
	});

	it("signalCostNoEffort matches signalCost when there is no rest-effort contribution to drop", () => {
		const base = signalOf("move250-stable-best.csv");
		const zeroRipple: TuneSignal = { ...base, restEffort: { ...base.restEffort, restTailValid: true, pTermRestRipple: 0 } };
		expect(signalCostNoEffort(zeroRipple)).toBeCloseTo(signalCost(zeroRipple), 10);
	});

	it("is Infinity for an unstable capture, same as signalCost", () => {
		const unstable = signalOf("move250-runaway.csv");
		expect(signalCostNoEffort(unstable)).toBe(Infinity);
	});
});

describe("significantlyBetter / withinNoise", () => {
	it("says an unstable capture is never significantly better", () => {
		const stable = signalOf("move250-stable-best.csv");
		const unstable = signalOf("move250-runaway.csv");
		expect(significantlyBetter(stable, unstable)).toBe(false);
	});

	it("says a stable capture IS significantly better than an unstable one", () => {
		const stable = signalOf("move250-stable-best.csv");
		const unstable = signalOf("move250-runaway.csv");
		expect(significantlyBetter(unstable, stable)).toBe(true);
	});

	it("treats two captures of the same gains (tiny numeric jitter) as within noise", () => {
		const a = signalOf("move250-stable-best.csv");
		const b = signalOf("move250-stable-best.csv"); // identical capture, zero real difference
		expect(withinNoise(a, b)).toBe(true);
		expect(significantlyBetter(a, b)).toBe(false);
	});

	it("does not call a tiny cost delta significant even when one side is technically lower", () => {
		const base: TuneSignal = sigLike(signalOf("move250-stable-best.csv"), { restNoise: 0.2 });
		const tiny: TuneSignal = { ...base, stats: { ...base.stats, moveRms: base.stats.moveRms + 0.001 } };
		expect(significantlyBetter(base, tiny)).toBe(false);
	});

	// docs/PLAN-capture-window.md §3 — the actual field bug: a real forum report of the same axis, same
	// PID, same three-cycle auto-tune run producing wildly different results run to run. Both assertions
	// here return TRUE before the comparableCost fix (verified against real data 2026-09-06) — that gap
	// is the whole defect, and it's reached through exactly the functions autorun.ts/optimize.ts call.
	it("does not accept a candidate that only 'improves' because its rest tail became unjudgeable", () => {
		const dither = signalOf("hold-dither-i0.csv");
		const unjudged: TuneSignal = { ...dither, restEffort: { ...dither.restEffort, restTailValid: false } };
		expect(significantlyBetter(dither, unjudged)).toBe(false);
	});
});

function sigLike(s: TuneSignal, statsOver: Partial<TuneSignal["stats"]>): TuneSignal {
	return { ...s, stats: { ...s.stats, ...statsOver } };
}

describe("termAwareCost / significantlyBetterForTerm", () => {
	const base = signalOf("move250-stable-best.csv");

	it("adds a penalty for V's own target (|pTermCruiseMean|) on top of the whole-loop cost", () => {
		const good = { ...base, pTermCruiseMean: 1 };
		const bad = { ...base, pTermCruiseMean: 200 };
		expect(termAwareCost("v", bad)).toBeGreaterThan(termAwareCost("v", good));
		// The plain whole-loop cost is identical for both (pTermCruiseMean isn't part of it) — the
		// difference must come entirely from the term-aware augmentation.
		expect(signalCost(bad)).toBeCloseTo(signalCost(good), 6);
	});

	it("adds a penalty for A's own target (pTermAccelPeak) on top of the whole-loop cost", () => {
		const good = { ...base, pTermAccelPeak: 5 };
		const bad = { ...base, pTermAccelPeak: 220 };
		expect(termAwareCost("a", bad)).toBeGreaterThan(termAwareCost("a", good));
	});

	it("leaves other terms' cost untouched by pTermCruiseMean/pTermAccelPeak", () => {
		const s1 = { ...base, pTermCruiseMean: 1, pTermAccelPeak: 1 };
		const s2 = { ...base, pTermCruiseMean: 200, pTermAccelPeak: 220 };
		expect(termAwareCost("p", s1)).toBeCloseTo(termAwareCost("p", s2), 6);
		expect(termAwareCost("d", s1)).toBeCloseTo(termAwareCost("d", s2), 6);
	});

	it("defaults to signalCost as its base, same as before the `base` parameter existed", () => {
		expect(termAwareCost("p", base)).toBeCloseTo(signalCost(base), 10);
	});

	it("folds a custom base cost in instead of signalCost when one is given", () => {
		expect(termAwareCost("p", base, signalCostNoEffort)).toBeCloseTo(signalCostNoEffort(base), 10);
	});

	// docs/PLAN-capture-window.md §3 — significantlyBetterForTerm is what autorun.ts/optimize.ts's A/V
	// probing actually calls (four sites), so this is the test that proves THAT path is fixed, not just
	// the cost helpers underneath it. True before the comparableCost fix, same as significantlyBetter above.
	it("does not accept a term probe that only 'improves' because its rest tail became unjudgeable", () => {
		const dither = signalOf("hold-dither-i0.csv");
		const unjudged: TuneSignal = { ...dither, restEffort: { ...dither.restEffort, restTailValid: false } };
		expect(significantlyBetterForTerm("v", dither, unjudged)).toBe(false);
		expect(significantlyBetterForTerm("a", dither, unjudged)).toBe(false);
	});

	it("regression: refuses to call a V change 'better' when it only nudges generic cost within noise while V's own target gets far worse (the runaway-V bug)", () => {
		// This reproduces the field failure: raising V drove pTermCruiseMean from -50 (reasonable) out
		// to +900 (V massively overshot) while moveRms/cruiseLag barely moved — plain signalCost alone
		// would have called this "not significantly different" or even a tiny improvement, letting V
		// drift indefinitely since nothing ever penalised it.
		const prev = { ...base, pTermCruiseMean: -50, stats: { ...base.stats, moveRms: 0.5, cruiseLag: 0.3 } };
		const cur = { ...base, pTermCruiseMean: 900, stats: { ...base.stats, moveRms: 0.49, cruiseLag: 0.29 } };
		expect(significantlyBetter(prev, cur)).toBe(false); // already not "significant" by the plateau/noise threshold
		expect(significantlyBetterForTerm("v", prev, cur)).toBe(false); // and now unambiguously rejected on V's own target
	});

	it("still accepts a genuine V improvement that brings pTermCruiseMean toward zero", () => {
		const prev = { ...base, pTermCruiseMean: -120, stats: { ...base.stats, moveRms: 0.6 } };
		const cur = { ...base, pTermCruiseMean: -5, stats: { ...base.stats, moveRms: 0.5 } };
		expect(significantlyBetterForTerm("v", prev, cur)).toBe(true);
	});
});

describe("oscillationAmplitude", () => {
	it("returns the peak absolute value in the window", () => {
		expect(oscillationAmplitude([1, -3, 2, -0.5], 0, 4)).toBe(3);
	});
	it("ignores samples outside [start, end)", () => {
		expect(oscillationAmplitude([100, 1, -2, 1, 100], 1, 4)).toBe(2);
	});
	it("returns 0 for an empty/flat window", () => {
		expect(oscillationAmplitude([0, 0, 0], 0, 3)).toBe(0);
	});
	it("skips non-finite samples", () => {
		expect(oscillationAmplitude([NaN, 5, Infinity], 0, 2)).toBe(5);
	});
});

describe("medianSignal", () => {
	it("returns the single signal unchanged when there's only one", () => {
		const s = signalOf("move250-stable-best.csv");
		expect(medianSignal([s])).toBe(s);
	});
	it("takes the field-wise median across repeat captures, rejecting a one-off glitch", () => {
		const good1 = signalOf("move250-stable-early.csv");
		const good2 = signalOf("move250-escalation-1.csv");
		const glitch = signalOf("move250-runaway.csv");
		const med = medianSignal([good1, glitch, good2]);
		// The median of three should sit near the two "good" readings, not the glitch.
		expect(med.stats.moveRms).toBeLessThan(glitch.stats.moveRms / 10);
		expect(signalUnstable(med)).toBe(false);
	});
});
