import { describe, expect, it, vi } from "vitest";

import { EMPTY_REST_EFFORT } from "../model/analysis";
import type { TuneEffects } from "../model/autorun";
import { P_MAX } from "../model/autotune";
import type { TuneEvaluation, TuneStats } from "../model/evaluate";
import type { PidConfig } from "../model/m569";
import {
	evaluateEnvelope, extrapolateRailOnset, identifyModelFitP, isSignificantDelta, MODEL_FIT_BACKOFF_DEFAULT,
	MODEL_FIT_SAT_ONSET, restNoiseToPTermFloor, runModelFitIdentification, solveFeedForwardTerm, solveZeroCrossing,
} from "../model/modelfit";
import { RUNAWAY_STEPS, type TuneSignal } from "../model/signal";

function stats(over: Partial<TuneStats> = {}): TuneStats {
	return {
		restBias: 0, restNoise: 0.05, restNoiseFull: 0.05, restRing: 0, cruiseRing: 0, settleOvershoot: 0, cruiseLag: 0,
		cruiseSpread: 0, accelPeak: 0, movePeak: 5, moveRms: 1, cruiseSamples: 10, restSamples: 10, moved: true,
		...over,
	};
}
function sig(over: Partial<Omit<TuneSignal, "stats">> & { stats?: Partial<TuneStats> } = {}): TuneSignal {
	const { stats: statsOver, ...rest } = over;
	return {
		stats: stats(statsOver ?? {}),
		pTermAccelPeak: 0, pTermCruiseMean: 0, pTermSatDuty: 0, postMoveOsc: 0,
		oscPeriod: null, oscAmplitude: 0, itae: 0, hasMove: true, restEffort: EMPTY_REST_EFFORT,
		...rest,
	};
}
const basePid = (): PidConfig => ({ p: 100, i: 0, d: 0, v: 0, a: 0, warn: null, err: null });

function fakeEffects(over: Partial<TuneEffects> = {}): { effects: TuneEffects; log: Array<string> } {
	const log: Array<string> = [];
	const effects: TuneEffects = {
		applyPid: vi.fn(async () => {}),
		readPid: vi.fn(async () => basePid()),
		captureSignal: vi.fn(async () => sig()),
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

describe("solveZeroCrossing", () => {
	it("solves the zero-crossing of a line through (0,y0) and (x1,y1)", () => {
		// y = -50 + 0.5x -> zero at x=100
		expect(solveZeroCrossing(-50, 0, 100)).toBeCloseTo(100, 5);
	});
	it("returns 0 for a degenerate (flat) fit", () => {
		expect(solveZeroCrossing(-50, -50, 100)).toBe(0);
	});
	it("returns 0 when x1 is 0", () => {
		expect(solveZeroCrossing(-50, 0, 0)).toBe(0);
	});
});

describe("isSignificantDelta", () => {
	it("is true when the change clears the noise floor", () => {
		expect(isSignificantDelta(10, 5)).toBe(true);
		expect(isSignificantDelta(-10, 5)).toBe(true);
	});
	it("is false when the change is within the noise floor", () => {
		expect(isSignificantDelta(3, 5)).toBe(false);
	});
});

describe("restNoiseToPTermFloor", () => {
	it("scales step noise by the P gain (P-term ≈ P × error)", () => {
		expect(restNoiseToPTermFloor(0.08, 110)).toBeCloseTo(8.8, 5);
	});
});

describe("evaluateEnvelope (docs/PLAN-envelope-check.md)", () => {
	it("holds when satDuty stays below MODEL_FIT_SAT_ONSET", () => {
		const r = evaluateEnvelope(36000, MODEL_FIT_SAT_ONSET / 2);
		expect(r).toEqual({ feedMmPerMin: 36000, satDuty: MODEL_FIT_SAT_ONSET / 2, holds: true });
	});

	it("does not hold once satDuty reaches the same threshold model-fit's own ramp uses", () => {
		const r = evaluateEnvelope(36000, MODEL_FIT_SAT_ONSET);
		expect(r.holds).toBe(false);
	});

	it("does not hold well above the threshold", () => {
		expect(evaluateEnvelope(36000, 0.2).holds).toBe(false);
	});
});

describe("extrapolateRailOnset", () => {
	it("extrapolates the field run's tail (89 → 105 → 180) to onset ≈ 369", () => {
		const onset = extrapolateRailOnset([
			{ p: 214.85, accelPeak: 89 }, { p: 268.56, accelPeak: 105 }, { p: 335.7, accelPeak: 180 },
		]);
		expect(onset).not.toBeNull();
		expect(onset!).toBeGreaterThan(350);
		expect(onset!).toBeLessThan(390);
	});
	it("returns null for a flat tail (nothing to extrapolate)", () => {
		expect(extrapolateRailOnset([
			{ p: 214.85, accelPeak: 65 }, { p: 268.56, accelPeak: 66 }, { p: 335.7, accelPeak: 65 },
		])).toBeNull();
	});
	it("returns null with fewer than 3 points", () => {
		expect(extrapolateRailOnset([{ p: 268.56, accelPeak: 105 }, { p: 335.7, accelPeak: 180 }])).toBeNull();
	});
	it("clamps the extrapolated onset to P_MAX", () => {
		const onset = extrapolateRailOnset([
			{ p: 400, accelPeak: 100 }, { p: 500, accelPeak: 101 }, { p: 600, accelPeak: 102 },
		]);
		expect(onset).not.toBeNull();
		expect(onset!).toBeLessThanOrEqual(P_MAX);
	});
});

describe("identifyModelFitP", () => {
	it("ramps P to the rail onset and backs off by the given fraction", async () => {
		// Well-damped servo: accel P-term rises with P, hitting the rail fraction at P=214.85 (the 8th
		// geometric-ramp value: 30,50,70,90,110,137.5,171.88,214.85).
		let lastAppliedP = 0;
		const applyPid = vi.fn(async (p: PidConfig) => { lastAppliedP = p.p; });
		const captureSignal = vi.fn(async () => sig({ pTermAccelPeak: lastAppliedP >= 214 ? 220 : 60 }));
		const { effects, log } = fakeEffects({ applyPid, captureSignal });
		const { result } = await identifyModelFitP(effects, 1, 0.65);
		expect(result).not.toBeNull();
		expect(result!.basis).toBe("rail");
		expect(result!.pRailOnset).toBeCloseTo(214.85, 1);
		expect(result!.pStar).toBeCloseTo(0.65 * 214.85, 1);
		expect(log.some((l) => l.includes("rail onset at P="))).toBe(true);
	});

	it("also triggers on saturation duty alone (a noisy accel PEAK can read low while the loop rails)", async () => {
		let lastAppliedP = 0;
		const applyPid = vi.fn(async (p: PidConfig) => { lastAppliedP = p.p; });
		const captureSignal = vi.fn(async () => sig({ pTermAccelPeak: 100, pTermSatDuty: lastAppliedP >= 268 ? 0.03 : 0 }));
		const { effects } = fakeEffects({ applyPid, captureSignal });
		const { result } = await identifyModelFitP(effects, 1, 0.65);
		expect(result).not.toBeNull();
		expect(result!.basis).toBe("rail");
		expect(result!.pRailOnset).toBeCloseTo(268.56, 1);
	});

	it("uses the last clean reading as rail onset if it goes unstable before the accel-peak threshold", async () => {
		let lastAppliedP = 0;
		const applyPid = vi.fn(async (p: PidConfig) => { lastAppliedP = p.p; });
		const captureSignal = vi.fn(async () => (lastAppliedP >= 137
			? sig({ pTermSatDuty: 0.9 }) // unstable well before the accel-peak rail check would fire
			: sig({ pTermAccelPeak: 30 })));
		const { effects, log } = fakeEffects({ applyPid, captureSignal });
		const { result } = await identifyModelFitP(effects, 1, 0.65);
		expect(result).not.toBeNull();
		expect(result!.basis).toBe("unstable-backoff");
		expect(result!.pRailOnset).toBeCloseTo(110, 1); // the last clean value before 137.5 went unstable
		expect(log.some((l) => l.includes("went unstable"))).toBe(true);
	});

	it("regression (field run 2026-07-04): rail past the ramp end with a rising tail → EXTRAPOLATES onset instead of falling back", async () => {
		// The field plant: accel peak stays modest then rises steeply near the rail (onset ≈ 369, past
		// the old 10-attempt budget). The ramp now runs further AND, if it still ends below threshold,
		// extrapolates the rising tail instead of throwing the whole identification away.
		let lastAppliedP = 0;
		const applyPid = vi.fn(async (p: PidConfig) => { lastAppliedP = p.p; });
		// accel peak: gentle below 268, steep 268→335 (105→180), then capture goes unstable above 380
		// before the 0.85 threshold ever reads — approximating the real machine's behaviour if pushed.
		const captureSignal = vi.fn(async () => {
			const p = lastAppliedP;
			if (p <= 268.56) { return sig({ pTermAccelPeak: Math.max(60, p * 0.39) }); }
			if (p <= 335.7) { return sig({ pTermAccelPeak: 105 + (p - 268.56) * 1.12 }); }
			return sig({ pTermSatDuty: 0.9 }); // pushing past 335.7 destabilises — same info, different route
		});
		const { effects, log } = fakeEffects({ applyPid, captureSignal });
		const { result } = await identifyModelFitP(effects, 1, 0.65);
		expect(result).not.toBeNull();
		// Unstable at 419.63 → last clean reading 335.7 is used with backoff (the unstable-backoff path
		// fires before extrapolation gets a chance — both give a defensible P* near 218-240).
		expect(result!.pStar).toBeGreaterThan(200);
		expect(result!.pStar).toBeLessThan(260);
		expect(log.some((l) => l.includes("went unstable") || l.includes("extrapolates onset"))).toBe(true);
	});

	it("extrapolates from the rising tail when the whole ramp stays clean but below threshold", async () => {
		let lastAppliedP = 0;
		const applyPid = vi.fn(async (p: PidConfig) => { lastAppliedP = p.p; });
		// Clean everywhere; accel peak grows with P but only reaches ~200 at P_MAX — threshold is 217.6.
		const captureSignal = vi.fn(async () => sig({ pTermAccelPeak: 40 + lastAppliedP * 0.27 }));
		const { effects, log } = fakeEffects({ applyPid, captureSignal });
		const { result } = await identifyModelFitP(effects, 1, 0.65);
		expect(result).not.toBeNull();
		expect(result!.basis).toBe("extrapolated");
		expect(log.some((l) => l.includes("extrapolates onset"))).toBe(true);
	});

	it("uses the best measured reading directly when the tail is flat (no rail, no trend — no fallback re-ramp)", async () => {
		const { effects, log } = fakeEffects({ captureSignal: vi.fn(async () => sig({ pTermAccelPeak: 10 })) });
		const { result, attempts } = await identifyModelFitP(effects, 1, 0.65);
		expect(result).not.toBeNull();
		expect(result!.basis).toBe("best-measured");
		expect(attempts.length).toBeGreaterThan(10); // the readings are returned for reuse
		expect(log.some((l) => l.includes("using the best measured reading directly"))).toBe(true);
	});

	it("returns a null result (but keeps any attempts) when the very first capture fails", async () => {
		const { effects } = fakeEffects({ captureSignal: vi.fn(async () => null) });
		const { result, attempts } = await identifyModelFitP(effects, 1, 0.65);
		expect(result).toBeNull();
		expect(attempts).toEqual([]);
	});

	// --- Rail confirmation (docs/PLAN-rail-detection.md §1) -------------------------------------
	// The accel PEAK alone is weak evidence: on one unchanged field profile it read 212-219 at the SAME
	// P, against a threshold of 212.5, while nothing was saturating. Believing it ends identification
	// and collapses P* to backoff x SEED_START, so it must be re-measured first. Saturation duty is
	// strong evidence (samples really are pinned at the clamp) and still stands on a single reading.

	it("regression (field 2026-09): a lone accel-peak crossing at the seed is re-measured, not believed", async () => {
		let n = 0;
		const captureSignal = vi.fn(async () => {
			n++;
			// First probe at the seed reads 216 (> 212.5) with nothing saturating — the false rail that
			// cost four field runs an 11x-too-low P. Every later read sits well clear of the threshold.
			return n === 1 ? sig({ pTermAccelPeak: 216, pTermSatDuty: 0 }) : sig({ pTermAccelPeak: 120, pTermSatDuty: 0 });
		});
		let lastAppliedP = 0;
		const applyPid = vi.fn(async (p: PidConfig) => { lastAppliedP = Math.max(lastAppliedP, p.p); });
		const { effects, log } = fakeEffects({ applyPid, captureSignal });
		const { result } = await identifyModelFitP(effects, 1, 0.65);
		expect(result).not.toBeNull();
		expect(result!.basis).not.toBe("rail");
		// The bug's signature: rail declared at the seed, so P* collapses to 0.65 x SEED_START = 19.5,
		// a number derived purely from the seed constant with nothing measured about the axis in it.
		expect(result!.pStar).not.toBeCloseTo(19.5, 1);
		expect(lastAppliedP).toBeGreaterThan(30); // the ramp carried on past the seed
		expect(log.some((l) => l.includes("re-measuring to confirm"))).toBe(true);
		expect(log.some((l) => l.includes("not confirmed"))).toBe(true);
	});

	it("accepts an accel-peak rail once a second capture at the same P confirms it", async () => {
		let lastAppliedP = 0;
		const applyPid = vi.fn(async (p: PidConfig) => { lastAppliedP = p.p; });
		const captureSignal = vi.fn(async () => sig({ pTermAccelPeak: lastAppliedP >= 110 ? 220 : 100, pTermSatDuty: 0 }));
		const { effects } = fakeEffects({ applyPid, captureSignal });
		const { result } = await identifyModelFitP(effects, 1, 0.65);
		expect(result!.basis).toBe("rail");
		expect(result!.pRailOnset).toBe(110);
		expect(result!.pStar).toBeCloseTo(71.5, 1);
	});

	it("rails on saturation duty without spending a confirmation capture", async () => {
		const captureSignal = vi.fn(async () => sig({ pTermAccelPeak: 256, pTermSatDuty: 0.04 }));
		const { effects, log } = fakeEffects({ captureSignal });
		const { result } = await identifyModelFitP(effects, 1, 0.65);
		expect(result!.basis).toBe("rail");
		expect(result!.pRailOnset).toBe(30);
		expect(captureSignal).toHaveBeenCalledTimes(1); // strong evidence — believed on one reading
		expect(log.some((l) => l.includes("re-measuring to confirm"))).toBe(false);
	});

	it("flags a rail that lands on the seed as seed-derived rather than measured (§2)", async () => {
		const captureSignal = vi.fn(async () => sig({ pTermAccelPeak: 256, pTermSatDuty: 0.04 }));
		const { effects, log } = fakeEffects({ captureSignal });
		await identifyModelFitP(effects, 1, 0.65);
		expect(log.some((l) => l.includes("at the seed P=30") && l.includes("lower feedrate"))).toBe(true);
	});

	it("returns a null result when the confirmation capture itself fails", async () => {
		let n = 0;
		const captureSignal = vi.fn(async () => { n++; return n === 1 ? sig({ pTermAccelPeak: 216, pTermSatDuty: 0 }) : null; });
		const { effects } = fakeEffects({ captureSignal });
		const { result, attempts } = await identifyModelFitP(effects, 1, 0.65);
		expect(result).toBeNull();
		expect(attempts).toHaveLength(1); // the probe that triggered the confirmation is kept
	});

	it("backs off from the last clean reading when the confirmation comes back unstable", async () => {
		let n = 0;
		const captureSignal = vi.fn(async () => {
			n++;
			if (n === 1) { return sig({ pTermAccelPeak: 100, pTermSatDuty: 0 }); }        // P=30, clean
			if (n === 2) { return sig({ pTermAccelPeak: 216, pTermSatDuty: 0 }); }        // P=50, triggers confirm
			return sig({ pTermAccelPeak: 216, pTermSatDuty: 0, stats: { movePeak: RUNAWAY_STEPS } }); // confirm: unstable
		});
		const { effects } = fakeEffects({ captureSignal });
		const { result } = await identifyModelFitP(effects, 1, 0.65);
		expect(result!.basis).toBe("unstable-backoff");
		expect(result!.pRailOnset).toBe(30);   // the unstable P=50 is discarded, not kept as the onset
		expect(result!.pStar).toBeCloseTo(19.5, 1);
	});
});

describe("solveFeedForwardTerm", () => {
	const baseline = sig({ pTermCruiseMean: -50, stats: { restNoise: 0.05 } });

	it("solves V from a two-point linear fit and verifies it", async () => {
		// True zero-crossing at V=1000: pTermCruiseMean(V) = -50 + 0.05*V
		const pid = basePid();
		const captureSignal = vi.fn(async () => sig({ pTermCruiseMean: -50 + 0.05 * pid.v, stats: { restNoise: 0.05 } }));
		const { effects, log } = fakeEffects({ captureSignal });
		const result = await solveFeedForwardTerm(effects, "v", pid, baseline, 1, 2, 1);
		expect(result.measurable).toBe(true);
		expect(result.applied).toBeGreaterThan(800);
		expect(result.applied).toBeLessThan(1200);
		expect(pid.v).toBe(result.applied);
		expect(log.some((l) => l.includes("V solve"))).toBe(true);
	});

	it("leaves the term at 0 when neither probe shows a measurable effect", async () => {
		const pid = basePid();
		const captureSignal = vi.fn(async () => sig({ pTermAccelPeak: 60, stats: { restNoise: 0.05 } })); // never changes
		const { effects, log } = fakeEffects({ captureSignal });
		const result = await solveFeedForwardTerm(effects, "a", pid, sig({ pTermAccelPeak: 60, stats: { restNoise: 0.05 } }), 1, 2, 1);
		expect(result.measurable).toBe(false);
		expect(result.applied).toBe(0);
		expect(pid.a).toBe(0);
		expect(log.some((l) => l.includes("no measurable effect"))).toBe(true);
	});

	it("tries a second, bigger probe before giving up when the first is inconclusive", async () => {
		const pid = basePid();
		// True zero-crossing is far out (V=1400) — the first (small) probe alone looks flat.
		const captureSignal = vi.fn(async () => sig({ pTermCruiseMean: -50 + (50 / 1400) * pid.v, stats: { restNoise: 0.05 } }));
		const { effects, log } = fakeEffects({ captureSignal });
		const result = await solveFeedForwardTerm(effects, "v", pid, sig({ pTermCruiseMean: -50, stats: { restNoise: 0.05 } }), 1, 2, 1);
		expect(result.measurable).toBe(true);
		expect(captureSignal.mock.calls.length).toBeGreaterThanOrEqual(2); // first probe + second (bigger) probe
		expect(result.applied).toBeGreaterThan(1000);
	});

	it("reverts to 0 when the first probe itself destabilises the loop", async () => {
		const pid = basePid();
		const captureSignal = vi.fn(async () => sig({ pTermSatDuty: 0.9 }));
		const { effects, log } = fakeEffects({ captureSignal });
		const result = await solveFeedForwardTerm(effects, "a", pid, baseline, 1, 2, 1);
		expect(result.measurable).toBe(false);
		expect(pid.a).toBe(0);
		expect(log.some((l) => l.includes("destabilised the loop"))).toBe(true);
	});

	it("reverts to 0 when the solved value fails verification", async () => {
		const pid = basePid();
		let probeDone = false;
		const captureSignal = vi.fn(async () => {
			if (!probeDone) { probeDone = true; return sig({ pTermCruiseMean: -50 + 0.05 * pid.v, stats: { restNoise: 0.05 } }); }
			return sig({ pTermSatDuty: 0.9 }); // every verification attempt is unstable
		});
		const { effects, log } = fakeEffects({ captureSignal });
		const result = await solveFeedForwardTerm(effects, "v", pid, baseline, 1, 1, 1);
		expect(result.measurable).toBe(false);
		expect(pid.v).toBe(0);
		expect(log.some((l) => l.includes("leaving V=0"))).toBe(true);
	});
});

describe("runModelFitIdentification (full P → A → V flow)", () => {
	it("identifies P, then solves A and V, mutating pid in place", async () => {
		const pid = basePid();
		let lastApplied: PidConfig = { ...pid };
		const applyPid = vi.fn(async (p: PidConfig) => { lastApplied = p; });
		const captureSignal = vi.fn(async () => {
			if (lastApplied.a === 0 && lastApplied.v === 0) {
				// P-ramp / P-verify phase: accel P-term tracks P (well-damped servo) until the rail.
				return sig({ pTermAccelPeak: Math.min(256, lastApplied.p), stats: { restNoise: 0.05 } });
			}
			// A/V solve phase: report accel/cruise P-terms that solve cleanly.
			return sig({
				pTermAccelPeak: lastApplied.a > 0 ? Math.max(5, 60 - lastApplied.a / 3000) : 60,
				pTermCruiseMean: -50 + 0.05 * lastApplied.v,
				stats: { restNoise: 0.05 },
			});
		});
		const { effects, log } = fakeEffects({ applyPid, captureSignal });
		const { fit } = await runModelFitIdentification(effects, pid, 1, 2, MODEL_FIT_BACKOFF_DEFAULT);
		expect(fit).not.toBeNull();
		expect(pid.p).toBeGreaterThan(0);
		expect(pid.p).toBeLessThanOrEqual(P_MAX);
		expect(log.some((l) => l.includes("rail onset at P="))).toBe(true);
	});

	it("returns a null fit (keeping the ramp attempts) when the P ramp itself fails", async () => {
		const pid = basePid();
		const { effects } = fakeEffects({ captureSignal: vi.fn(async () => null) });
		const { fit, pRampAttempts } = await runModelFitIdentification(effects, pid, 1, 2, MODEL_FIT_BACKOFF_DEFAULT);
		expect(fit).toBeNull();
		expect(pRampAttempts).toEqual([]);
	});
});
