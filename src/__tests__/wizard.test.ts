import { describe, expect, it } from "vitest";

import { WIZARD_STEPS } from "../model/wizard";
import type { StepMetrics } from "../model/analysis";

const P = WIZARD_STEPS.find((s) => s.id === "p")!;
const D = WIZARD_STEPS.find((s) => s.id === "d")!;
const I = WIZARD_STEPS.find((s) => s.id === "i")!;

function metrics(over: Partial<StepMetrics>): StepMetrics {
	return { stepSize: 4, riseTime: 0.01, overshootPct: 0, settlingTime: 0.02, steadyStateError: 0, peakError: 0.1, rmsError: 0.05, oscillations: 0, hasStep: true, ...over };
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
});
