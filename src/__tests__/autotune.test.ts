import { describe, expect, it } from "vitest";

import {
	D_STRATEGY, I_STRATEGY, P_STRATEGY, SIGNAL_A_STRATEGY, SIGNAL_D_STRATEGY, SIGNAL_I_STRATEGY,
	SIGNAL_P_STRATEGY, SIGNAL_V_STRATEGY, describeMetrics, type Attempt, type SignalAttempt,
} from "../model/autotune";
import type { StepMetrics } from "../model/analysis";
import type { TuneSignal } from "../model/signal";
import type { TuneStats } from "../model/evaluate";

function m(over: Partial<StepMetrics>): StepMetrics {
	return { stepSize: 4, riseTime: 0.02, overshootPct: 0, settlingTime: 0.03, steadyStateError: 0, peakError: 0.1, rmsError: 0.05, oscillations: 0, hasStep: true, pTermSatDuty: 0, ...over };
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
	it("backs off when the P term is saturating even without a high overshoot reading", () => {
		// This is the real failure mode: a trapezoid move under load can rail the P term for the whole
		// capture while overshoot/oscillation still read low, because those metrics are dominated by the
		// commanded motion profile rather than the loop gain.
		const d = P_STRATEGY.decide([at(100, m({ riseTime: 0.02 })), at(150, m({ riseTime: 0.019, overshootPct: 5, oscillations: 1, pTermSatDuty: 0.5 }))]);
		expect(d.kind).toBe("accept");
		if (d.kind === "accept") expect(d.value).toBe(100);
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
	it("backs off when D saturates the P term", () => {
		const d = D_STRATEGY.decide([at(0.2, m({ overshootPct: 20 })), at(0.3, m({ overshootPct: 5, pTermSatDuty: 0.4 }))]);
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

// ---- Unified TuneSignal strategies (axis drivers; trapezoid move captures) ----

function stats(over: Partial<TuneStats>): TuneStats {
	return {
		restBias: 0, restNoise: 0.05, restRing: 0, settleOvershoot: 0, cruiseLag: 0,
		accelPeak: 0, movePeak: 5, moveRms: 1, cruiseSamples: 10, restSamples: 10, moved: true,
		...over,
	};
}
function sig(over: Partial<TuneSignal> & { stats?: Partial<TuneStats> } = {}): TuneSignal {
	const { stats: statsOver, ...rest } = over;
	return {
		stats: stats(statsOver ?? {}),
		pTermAccelPeak: 0, pTermCruiseMean: 0, pTermSatDuty: 0, postMoveOsc: 0,
		oscPeriod: null, itae: 0, hasMove: true,
		...rest,
	};
}
const sat = (value: number, signal: TuneSignal): SignalAttempt => ({ value, signal });

describe("SIGNAL_P_STRATEGY", () => {
	it("fails when no steady move was detected", () => {
		expect(SIGNAL_P_STRATEGY.decide([sat(30, sig({ hasMove: false }))]).kind).toBe("fail");
	});
	it("keeps increasing while tracking error improves", () => {
		const d = SIGNAL_P_STRATEGY.decide([
			sat(30, sig({ stats: { moveRms: 3 } })),
			sat(50, sig({ stats: { moveRms: 2 } })),
		]);
		expect(d.kind).toBe("set");
		if (d.kind === "set") expect(d.value).toBeGreaterThan(50);
	});
	it("accepts once tracking error is at the encoder noise floor", () => {
		const d = SIGNAL_P_STRATEGY.decide([sat(150, sig({ stats: { moveRms: 0.1, restNoise: 0.05 } }))]);
		expect(d.kind).toBe("accept");
		if (d.kind === "accept") expect(d.value).toBe(150);
	});
	it("accepts when tracking error plateaus", () => {
		const d = SIGNAL_P_STRATEGY.decide([
			sat(100, sig({ stats: { moveRms: 2.0 } })),
			sat(125, sig({ stats: { moveRms: 1.96 } })),
		]);
		expect(d.kind).toBe("accept");
	});
	it("backs off before the values that destabilised the real machine (saturation)", () => {
		// Mirrors the real capture escalation: P ramped past stability with the loop railing hard.
		const d = SIGNAL_P_STRATEGY.decide([
			sat(150, sig({ stats: { moveRms: 1.2 } })),
			sat(200, sig({ stats: { moveRms: 0.9 } })),
			sat(256, sig({ stats: { moveRms: 40, movePeak: 400 }, pTermSatDuty: 0.4 })),
		]);
		expect(d.kind).toBe("accept");
		if (d.kind === "accept") expect(d.value).toBe(200);
	});
	it("backs off on divergence even without hitting the hard saturation/ring limits", () => {
		const d = SIGNAL_P_STRATEGY.decide([
			sat(100, sig({ stats: { moveRms: 1.0 } })),
			sat(150, sig({ stats: { moveRms: 5.0 } })), // 5x worse — diverging, not yet vetoed as "unstable"
		]);
		expect(d.kind).toBe("accept");
		if (d.kind === "accept") expect(d.value).toBe(100);
	});
});

describe("SIGNAL_D_STRATEGY", () => {
	it("accepts when critically damped (low overshoot, no ring)", () => {
		expect(SIGNAL_D_STRATEGY.decide([sat(0.2, sig({ stats: { settleOvershoot: 0.5, restRing: 1 } }))]).kind).toBe("accept");
	});
	it("increases D while overshoot is high", () => {
		const d = SIGNAL_D_STRATEGY.decide([sat(0, sig({ stats: { settleOvershoot: 3 } }))]);
		expect(d.kind).toBe("set");
		if (d.kind === "set") expect(d.value).toBeGreaterThan(0);
	});
	it("does NOT accept D=0 on a trapezoid move whose true overshoot is small relative to the whole move but still bad in absolute steps", () => {
		// This is the category-error regression: the legacy step metrics would see ~2% overshoot on a
		// 250-step move and call it fine. The signal strategy judges absolute settle-overshoot in steps.
		const d = SIGNAL_D_STRATEGY.decide([sat(0, sig({ stats: { settleOvershoot: 5, restRing: 6 } }))]);
		expect(d.kind).not.toBe("accept");
	});
	it("backs off when D increases ringing", () => {
		const d = SIGNAL_D_STRATEGY.decide([
			sat(0.2, sig({ stats: { settleOvershoot: 3, restRing: 2 } })),
			sat(0.3, sig({ stats: { settleOvershoot: 3, restRing: 6 } })),
		]);
		expect(d.kind).toBe("accept");
		if (d.kind === "accept") expect(d.value).toBe(0.2);
	});
	it("backs off on the saturation veto", () => {
		const d = SIGNAL_D_STRATEGY.decide([
			sat(0.2, sig({ stats: { settleOvershoot: 3 } })),
			sat(0.3, sig({ stats: { settleOvershoot: 1 }, pTermSatDuty: 0.5 })),
		]);
		expect(d.kind).toBe("accept");
		if (d.kind === "accept") expect(d.value).toBe(0.2);
	});
});

describe("SIGNAL_I_STRATEGY", () => {
	it("accepts when standing error is small", () => {
		expect(SIGNAL_I_STRATEGY.decide([sat(1000, sig({ stats: { restBias: 0.1 } }))]).kind).toBe("accept");
	});
	it("starts at 1000 from zero when standing error remains", () => {
		const d = SIGNAL_I_STRATEGY.decide([sat(0, sig({ stats: { restBias: 0.5 } }))]);
		expect(d.kind).toBe("set");
		if (d.kind === "set") expect(d.value).toBe(1000);
	});
	it("backs off on hunting (postMoveOsc) even if standing bias looks fine", () => {
		const d = SIGNAL_I_STRATEGY.decide([
			sat(1000, sig({ stats: { restBias: 0.3 } })),
			sat(1500, sig({ stats: { restBias: 0.05 }, postMoveOsc: 10 })),
		]);
		expect(d.kind).toBe("accept");
		if (d.kind === "accept") expect(d.value).toBe(1000);
	});
});

describe("SIGNAL_A_STRATEGY (accel feed-forward)", () => {
	it("fails when no steady move was detected", () => {
		expect(SIGNAL_A_STRATEGY.decide([sat(0, sig({ hasMove: false }))]).kind).toBe("fail");
	});
	it("raises A while the accel P-term peak keeps dropping", () => {
		const d = SIGNAL_A_STRATEGY.decide([sat(0, sig({ pTermAccelPeak: 200 }))]);
		expect(d.kind).toBe("set");
		if (d.kind === "set") expect(d.value).toBe(50000);
	});
	it("accepts when the accel peak plateaus", () => {
		const d = SIGNAL_A_STRATEGY.decide([sat(50000, sig({ pTermAccelPeak: 100 })), sat(100000, sig({ pTermAccelPeak: 96 }))]);
		expect(d.kind).toBe("accept");
	});
	it("backs off to the last stable value when A destabilises the move (saturation)", () => {
		const d = SIGNAL_A_STRATEGY.decide([
			sat(50000, sig({ pTermAccelPeak: 120 })),
			sat(75000, sig({ pTermAccelPeak: 90 })),
			sat(112500, sig({ pTermAccelPeak: 40, pTermSatDuty: 0.5 })), // railed half the move
		]);
		expect(d.kind).toBe("accept");
		if (d.kind === "accept") expect(d.value).toBe(75000);
	});
	it("backs off when the axis hunts (rails back and forth) after the move stops", () => {
		const d = SIGNAL_A_STRATEGY.decide([
			sat(50000, sig({ pTermAccelPeak: 120 })),
			sat(75000, sig({ pTermAccelPeak: 60, postMoveOsc: 20 })), // limit cycle at the hold
		]);
		expect(d.kind).toBe("accept");
		if (d.kind === "accept") expect(d.value).toBe(50000);
	});
	it("turns feed-forward off if the very first move is already unstable", () => {
		const d = SIGNAL_A_STRATEGY.decide([sat(0, sig({ pTermAccelPeak: 40, pTermSatDuty: 0.6 }))]);
		expect(d.kind).toBe("accept");
		if (d.kind === "accept") expect(d.value).toBe(0);
	});
});

describe("SIGNAL_V_STRATEGY (velocity feed-forward)", () => {
	it("accepts when the steady-speed P-term is ~0", () => {
		expect(SIGNAL_V_STRATEGY.decide([sat(200, sig({ pTermCruiseMean: 2 }))]).kind).toBe("accept");
	});
	it("starts at 100 from zero when the cruise P-term is high", () => {
		const d = SIGNAL_V_STRATEGY.decide([sat(0, sig({ pTermCruiseMean: 50 }))]);
		expect(d.kind).toBe("set");
		if (d.kind === "set") expect(d.value).toBe(100);
	});
	it("backs off to the last stable value when V destabilises the move", () => {
		const d = SIGNAL_V_STRATEGY.decide([
			sat(100, sig({ pTermCruiseMean: 20 })),
			sat(160, sig({ pTermCruiseMean: 8 })),
			sat(256, sig({ pTermCruiseMean: 4, postMoveOsc: 15 })), // hunting at the hold
		]);
		expect(d.kind).toBe("accept");
		if (d.kind === "accept") expect(d.value).toBe(160);
	});
});
