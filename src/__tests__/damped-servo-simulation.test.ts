/**
 * End-to-end simulation of the exact plant a real field run exposed: a well-damped proportional servo
 * where P×cruiseLag and P×moveRms are constant over a wide P range (so Ziegler–Nichols / relay feedback
 * can never find a sustained oscillation below the actuator's rail), V has a large true operating point
 * a naive ramp would either overshoot wildly or take many captures to approach, and A genuinely has no
 * measurable effect on this move. Runs the real `runAutoTune` orchestrator (model-fit identification,
 * default options) against a scripted plant instead of mocking metrics directly, so this exercises the
 * whole P → A → V → D → I pipeline exactly as a real machine would drive it — including surviving one
 * injected corrupt capture partway through.
 */
import { describe, expect, it, vi } from "vitest";

import { EMPTY_REST_EFFORT } from "../model/analysis";
import { runAutoTune, type TuneEffects } from "../model/autorun";
import type { TuneEvaluation } from "../model/evaluate";
import type { PidConfig } from "../model/m569";
import type { TuneSignal } from "../model/signal";

const basePid = (): PidConfig => ({ p: 100, i: 0, d: 0, v: 0, a: 0, warn: null, err: null });

// ---- The synthetic plant, fit to the field data ----
// cruise P-term ≈ -60 + 0.04·V (zero-crossing at V=1500); moveRms ≈ 50/P; cruiseLag = cruiseMean/P (so
// P×cruiseLag is constant, exactly the field signature); accel P-term tracks P up to the 256 rail,
// independent of A (A has no modelled effect on this move — like the field's "A=0→67, A=50000→71").
const TRUE_V = 1500;
const CRUISE_BASE = -60;
const V_SLOPE = -CRUISE_BASE / TRUE_V; // 0.04

function plant(pid: PidConfig): TuneSignal {
	const p = Math.max(1, pid.p);
	const cruiseMean = CRUISE_BASE + V_SLOPE * pid.v;
	const moveRms = Math.max(0.05, 50 / p);
	const cruiseLag = cruiseMean / p;
	const accelPeak = Math.min(256, p);
	const satDuty = p > 500 ? 0.5 : 0; // only an excessive P actually saturates
	return {
		stats: {
			restBias: -0.05, restNoise: 0.05, restNoiseFull: 0.05, restRing: 0, cruiseRing: 0, settleOvershoot: 0.05,
			cruiseLag, cruiseSpread: 0, accelPeak, movePeak: moveRms * 3, moveRms, cruiseSamples: 20, restSamples: 20,
			moved: true,
		},
		pTermAccelPeak: accelPeak,
		pTermCruiseMean: cruiseMean,
		pTermSatDuty: satDuty,
		postMoveOsc: 0,
		oscPeriod: null, // well-damped: never produces a sustained oscillation below the rail
		oscAmplitude: 0,
		itae: moveRms,
		hasMove: true,
		// Not modelled by this plant — restTailValid: false means the new standstill-effort gate is
		// skipped transparently, same as a real capture too short/without a PID I Term column to judge.
		restEffort: EMPTY_REST_EFFORT,
	};
}

function fakeEffects(over: Partial<TuneEffects> = {}): { effects: TuneEffects; log: Array<string> } {
	const log: Array<string> = [];
	const effects: TuneEffects = {
		applyPid: vi.fn(async () => {}),
		readPid: vi.fn(async () => basePid()),
		captureSignal: vi.fn(async () => null),
		captureStep: vi.fn(async () => null),
		runCalibration: vi.fn(async () => "ok"),
		evaluateCapture: vi.fn(async (): Promise<TuneEvaluation | null> => null),
		checkEnvelope: vi.fn(async () => null),
		ensureReady: vi.fn(async () => true),
		log: (line: string) => log.push(line),
		status: () => {},
		isCancelled: () => false,
		delay: async () => {},
		...over,
	};
	return { effects, log };
}

describe("synthetic damped-servo simulation (field-plant reproduction)", () => {
	it("model-fit lands P well below its rail, solves V near the true value, leaves A honestly at 0, and survives one corrupt capture", async () => {
		let lastApplied: PidConfig = basePid();
		const applyPid = vi.fn(async (p: PidConfig) => { lastApplied = { ...p }; });
		let callCount = 0;
		const captureSignal = vi.fn(async () => {
			callCount++;
			if (callCount === 5) { return null; } // one injected corrupt capture — must be transparently retried
			return plant(lastApplied);
		});
		const { effects, log } = fakeEffects({ applyPid, captureSignal });

		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true });

		expect(result.ok).toBe(true);
		expect(result.restored).toBeFalsy();

		// P: rail onset for this plant is P=268.56 (the ramp step that reaches accelPeak≥217.6), backed
		// off 65% -> ≈174.6. Well below P_MAX(600), and nowhere near the old bug's noise-floor accept (110).
		expect(result.pid.p).toBeGreaterThan(120);
		expect(result.pid.p).toBeLessThan(250);

		// V solves close to the plant's true zero-crossing, not overshot into the thousands (the field
		// bug) nor left near 0 (a ramp giving up early).
		expect(result.pid.v).toBeGreaterThan(TRUE_V * 0.5);
		expect(result.pid.v).toBeLessThan(TRUE_V * 1.5);

		// A has no measurable effect on this plant — model fit must say so, not guess a value.
		expect(result.pid.a).toBe(0);

		expect(log.some((l) => l.includes("Model fit: rail onset at P="))).toBe(true);
		expect(log.some((l) => l.includes("V solve"))).toBe(true);
		expect(log.some((l) => l.includes("no measurable effect"))).toBe(true);
		// Ziegler–Nichols continuous cycling is never even attempted — model fit succeeded outright.
		expect(log.some((l) => l.includes("went unstable before a clean sustained oscillation was found"))).toBe(false);
		expect(log.some((l) => l.includes("no sustained oscillation found"))).toBe(false);
	});

	it("falls back to the honest continuous-cycling failure message when explicitly asked for it on this plant", async () => {
		// Same plant, but forced onto the classical method: it must fail to find an oscillation (this
		// plant is too well-damped) and gracefully fall back to the conservative ramp instead of hanging
		// or crashing — proving the physical-inapplicability failure mode is handled, not just avoided.
		let lastApplied: PidConfig = basePid();
		const applyPid = vi.fn(async (p: PidConfig) => { lastApplied = { ...p }; });
		const captureSignal = vi.fn(async () => plant(lastApplied));
		const { effects, log } = fakeEffects({ applyPid, captureSignal });

		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true, identifyMethod: "continuous-cycling" });

		expect(result.ok).toBe(true);
		expect(result.ku).toBeUndefined();
		expect(log.some((l) => l.includes("no sustained oscillation found within the attempt budget"))).toBe(true);

		// Regression (v4): the fallback V ramp on this exact plant crosses zero between V=1048.58
		// (cruise-P −18.06) and V=1677.73 (cruise-P +7.1) — it must stop AT that sign flip and interpolate
		// the crossing (≈1500, the plant's true value), not sail through to V_MAX(10000) as it used to.
		expect(result.pid.v).toBeGreaterThan(TRUE_V * 0.7);
		expect(result.pid.v).toBeLessThan(TRUE_V * 1.3);
		expect(log.some((l) => l.includes("crossed zero"))).toBe(true);

		// A has no modelled effect on this plant regardless of P — the fallback A ramp must say so and
		// leave A=0, not accept whatever value the plateau happened to fire on.
		expect(result.pid.a).toBe(0);
		expect(log.some((l) => l.includes("A (accel feed-forward)") && l.includes("no measurable effect"))).toBe(true);
	});
});
