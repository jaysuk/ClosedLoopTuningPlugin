import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { WIZARD_STEPS } from "../model/wizard";
import { analyzeCapture, EMPTY_REST_EFFORT, type StepMetrics } from "../model/analysis";
import { parseCapture } from "../model/csv";

const P = WIZARD_STEPS.find((s) => s.id === "p")!;
const D = WIZARD_STEPS.find((s) => s.id === "d")!;
const I = WIZARD_STEPS.find((s) => s.id === "i")!;

function metrics(over: Partial<StepMetrics>): StepMetrics {
	return { stepSize: 4, riseTime: 0.01, overshootPct: 0, settlingTime: 0.02, steadyStateError: 0, peakError: 0.1, rmsError: 0.05, oscillations: 0, hasStep: true, pTermSatDuty: 0, restEffort: EMPTY_REST_EFFORT, ...over };
}

const FIXTURE_DIR = path.join(__dirname, "fixtures");
function realMetrics(name: string): StepMetrics {
	const capture = parseCapture(readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
	const m = analyzeCapture(capture, 2000);
	if (!m) { throw new Error(`${name}: analyzeCapture returned null`); }
	return m;
}

describe("wizard ordering", () => {
	it("tunes P, then D, then I, with A/V advanced last", () => {
		expect(WIZARD_STEPS.map((s) => s.id)).toEqual(["p", "d", "i", "a", "v"]);
	});
});

describe("P step", () => {
	it("asks for a capture when there are no metrics", () => {
		expect(P.recommend(null, 30).verdict).toBe("info");
	});
	it("recommends decreasing P when oscillating", () => {
		const r = P.recommend(metrics({ oscillations: 10, overshootPct: 50 }), 200);
		expect(r.verdict).toBe("decrease");
		expect(r.suggested).toBeLessThan(200);
	});
	it("recommends increasing P when rise time is slow", () => {
		const r = P.recommend(metrics({ riseTime: 0.1, oscillations: 0 }), 30);
		expect(r.verdict).toBe("increase");
		expect(r.suggested).toBeGreaterThan(30);
	});
	it("accepts a fast, stable response", () => {
		expect(P.recommend(metrics({ riseTime: 0.01, oscillations: 1 }), 120).verdict).toBe("accept");
	});
});

describe("D step", () => {
	it("increases D when there is overshoot", () => {
		const r = D.recommend(metrics({ overshootPct: 20 }), 0);
		expect(r.verdict).toBe("increase");
		expect(r.suggested).toBeGreaterThan(0);
	});
	it("accepts when critically damped", () => {
		expect(D.recommend(metrics({ overshootPct: 2 }), 0.2).verdict).toBe("accept");
	});
});

describe("I step", () => {
	it("increases I to remove steady-state error", () => {
		const r = I.recommend(metrics({ steadyStateError: 0.5 }), 0);
		expect(r.verdict).toBe("increase");
		expect(r.suggested).toBe(1000);
	});
	it("accepts when settled on target", () => {
		expect(I.recommend(metrics({ steadyStateError: 0.02 }), 1000).verdict).toBe("accept");
	});

	// Real field case (docs/PLAN-standstill-effort.md): a limit cycle centred on zero has ~zero mean
	// error, so steadyStateError alone can't tell it apart from a genuinely settled driver — the
	// effort-ripple check is what does. Uses the REAL restEffort measured from the dithering capture
	// (not a hand-built fake), with steadyStateError forced comfortably below the pre-existing
	// threshold so this isolates the NEW gate rather than accidentally re-exercising the old one.
	it("recommends INCREASING I when standstill effort ripple is high, even though steady-state error alone is fine", () => {
		const dithering = realMetrics("hold-dither-i0.csv");
		expect(dithering.restEffort.restTailValid).toBe(true);
		expect(dithering.restEffort.pTermRestRipple).toBeGreaterThan(10);
		const r = I.recommend(metrics({ steadyStateError: 0.02, restEffort: dithering.restEffort }), 0);
		expect(r.verdict).toBe("increase");
	});
	it("ACCEPTS the equivalent real capture once I has actually settled the standstill dither", () => {
		const settled = realMetrics("hold-settled-i23.csv");
		expect(settled.restEffort.restTailValid).toBe(true);
		expect(settled.restEffort.pTermRestRipple).toBeLessThanOrEqual(10);
		expect(I.recommend(settled, 23.5).verdict).toBe("accept");
	});
});
