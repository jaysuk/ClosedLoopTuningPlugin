import { describe, expect, it } from "vitest";

import { A_STRATEGY, D_STRATEGY, I_STRATEGY, P_STRATEGY, V_STRATEGY, describeMetrics, type Attempt, type MoveAttempt } from "../model/autotune";
import type { MoveMetrics, StepMetrics } from "../model/analysis";

function m(over: Partial<StepMetrics>): StepMetrics {
	return { stepSize: 4, riseTime: 0.02, overshootPct: 0, settlingTime: 0.03, steadyStateError: 0, peakError: 0.1, rmsError: 0.05, oscillations: 0, hasStep: true, ...over };
}
const at = (value: number, metrics: StepMetrics): Attempt => ({ value, metrics });

describe("P strategy", () => {
	it("fails when there is no step", () => {
		expect(P_STRATEGY.decide([at(30, m({ hasStep: false }))]).kind).toBe("fail");
	});
	it("keeps increasing while rise time improves", () => {
		const d = P_STRATEGY.decide([at(30, m({ riseTime: 0.05 })), at(50, m({ riseTime: 0.03 }))]);
		expect(d.kind).toBe("set");
		if (d.kind === "set") expect(d.value).toBeGreaterThan(50);
	});
	it("accepts when rise time plateaus", () => {
		const d = P_STRATEGY.decide([at(100, m({ riseTime: 0.021 })), at(125, m({ riseTime: 0.0205 }))]);
		expect(d.kind).toBe("accept");
		if (d.kind === "accept") expect(d.value).toBe(125);
	});
	it("backs off after oscillation", () => {
		const d = P_STRATEGY.decide([at(100, m({ riseTime: 0.02, oscillations: 1 })), at(150, m({ oscillations: 12, overshootPct: 70 }))]);
		expect(d.kind).toBe("accept");
		if (d.kind === "accept") expect(d.value).toBe(100); // last stable
	});
});

describe("D strategy", () => {
	it("accepts when overshoot is within target", () => {
		expect(D_STRATEGY.decide([at(0.2, m({ overshootPct: 5 }))]).kind).toBe("accept");
	});
	it("increases D while overshoot is high", () => {
		const d = D_STRATEGY.decide([at(0, m({ overshootPct: 25 }))]);
		expect(d.kind).toBe("set");
		if (d.kind === "set") expect(d.value).toBeGreaterThan(0);
	});
	it("backs off when D causes ringing", () => {
		const d = D_STRATEGY.decide([at(0.2, m({ overshootPct: 20, oscillations: 2 })), at(0.3, m({ overshootPct: 20, oscillations: 16 }))]);
		expect(d.kind).toBe("accept");
		if (d.kind === "accept") expect(d.value).toBe(0.2);
	});
});

describe("I strategy", () => {
	it("accepts when steady-state error is small", () => {
		expect(I_STRATEGY.decide([at(1000, m({ steadyStateError: 0.05 }))]).kind).toBe("accept");
	});
	it("starts at 1000 from zero when error remains", () => {
		const d = I_STRATEGY.decide([at(0, m({ steadyStateError: 0.5 }))]);
		expect(d.kind).toBe("set");
		if (d.kind === "set") expect(d.value).toBe(1000);
	});
	it("backs off when I oscillates", () => {
		const d = I_STRATEGY.decide([at(1000, m({ steadyStateError: 0.4, oscillations: 2 })), at(1500, m({ steadyStateError: 0.4, oscillations: 16 }))]);
		expect(d.kind).toBe("accept");
		if (d.kind === "accept") expect(d.value).toBe(1000);
	});
});

describe("describeMetrics", () => {
	it("summarises a capture in one line", () => {
		expect(describeMetrics(m({ riseTime: 0.02, overshootPct: 10, steadyStateError: 0.1, oscillations: 3 }))).toContain("rise 20ms");
	});
});

function mm(over: Partial<MoveMetrics>): MoveMetrics {
	return { hasMove: true, pTermAccelPeak: 0, pTermCruiseMean: 0, cruiseSamples: 10, ...over };
}
const mat = (value: number, metrics: MoveMetrics): MoveAttempt => ({ value, metrics });

describe("A strategy (accel feed-forward)", () => {
	it("fails when no steady move was detected", () => {
		expect(A_STRATEGY.decide([mat(0, mm({ hasMove: false }))]).kind).toBe("fail");
	});
	it("raises A while the accel P-term peak keeps dropping", () => {
		const d = A_STRATEGY.decide([mat(0, mm({ pTermAccelPeak: 200 }))]);
		expect(d.kind).toBe("set");
		if (d.kind === "set") expect(d.value).toBe(50000);
	});
	it("accepts when the accel peak plateaus", () => {
		const d = A_STRATEGY.decide([mat(50000, mm({ pTermAccelPeak: 100 })), mat(100000, mm({ pTermAccelPeak: 96 }))]);
		expect(d.kind).toBe("accept");
	});
});

describe("V strategy (velocity feed-forward)", () => {
	it("accepts when the steady-speed P-term is ~0", () => {
		expect(V_STRATEGY.decide([mat(200, mm({ pTermCruiseMean: 2 }))]).kind).toBe("accept");
	});
	it("starts at 100 from zero when the cruise P-term is high", () => {
		const d = V_STRATEGY.decide([mat(0, mm({ pTermCruiseMean: 50 }))]);
		expect(d.kind).toBe("set");
		if (d.kind === "set") expect(d.value).toBe(100);
	});
});
