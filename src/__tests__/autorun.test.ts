import { describe, expect, it, vi } from "vitest";

import { EMPTY_REST_EFFORT, type StepMetrics } from "../model/analysis";
import {
	detectUltimate, nextBackoff, refineAxisCycle, refinementDelta, refineTerm, runAutoTune, runSignalTerm,
	runStepTerm, seedFromUltimate, verifyAccepted, type TuneEffects,
} from "../model/autorun";
import {
	AUTOTUNE_SIGNAL_SEQUENCE, P_MAX, SIGNAL_D_STRATEGY, SIGNAL_I_STRATEGY, SIGNAL_P_STRATEGY, P_STRATEGY, D_STRATEGY, I_STRATEGY,
} from "../model/autotune";
import type { PidConfig } from "../model/m569";
import type { TuneSignal } from "../model/signal";
import type { TuneEvaluation, TuneStats } from "../model/evaluate";

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
		pTermAccelPeak: 50, pTermCruiseMean: 1, pTermSatDuty: 0, postMoveOsc: 0,
		oscPeriod: null, oscAmplitude: 0, itae: 0, hasMove: true, restEffort: EMPTY_REST_EFFORT,
		...rest,
	};
}
/** A signal that every strategy accepts immediately, first capture, no ramping. */
const GOOD_SIGNAL = sig({ stats: { moveRms: 0.05, restBias: 0.05, settleOvershoot: 0.1, restRing: 0 } });
function stepM(over: Partial<StepMetrics> = {}): StepMetrics {
	return { stepSize: 16, riseTime: 0.02, overshootPct: 0, settlingTime: 0.03, steadyStateError: 0.05, peakError: 0.1, rmsError: 0.05, oscillations: 0, hasStep: true, pTermSatDuty: 0, restEffort: EMPTY_REST_EFFORT, ...over };
}
const GOOD_STEP = stepM();

const basePid = (): PidConfig => ({ p: 100, i: 0, d: 0, v: 0, a: 0, warn: null, err: null });

function evaluation(over: Partial<TuneEvaluation> = {}): TuneEvaluation {
	return { grade: "good", score: 90, headline: "", findings: [], stats: stats(), ...over };
}

function fakeEffects(over: Partial<TuneEffects> = {}): { effects: TuneEffects; log: Array<string> } {
	const log: Array<string> = [];
	const effects: TuneEffects = {
		applyPid: vi.fn(async () => {}),
		readPid: vi.fn(async () => basePid()),
		captureSignal: vi.fn(async () => GOOD_SIGNAL),
		captureStep: vi.fn(async () => GOOD_STEP),
		runCalibration: vi.fn(async () => "ok"),
		evaluateCapture: vi.fn(async () => null),
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

// ---- Pure helpers ----

describe("nextBackoff", () => {
	it("halves on the first retry, quarters on the second", () => {
		expect(nextBackoff(100, 0, "p")).toBe(50);
		expect(nextBackoff(100, 1, "p")).toBe(25);
		expect(nextBackoff(100, 2, "p")).toBe(12.5);
	});

	it("rounds to the term's own precision, not a fixed 6dp — a large A backoff stays 2dp", () => {
		// 3 halvings of a six-figure A value lands on an exact .125 binary fraction — at 6dp this used to
		// surface real-but-meaningless digits in the UI; at A's own 2dp it's clean.
		expect(nextBackoff(253125, 2, "a")).toBe(31640.63);
		expect(String(nextBackoff(253125, 2, "a"))).not.toMatch(/\.\d{3,}/);
	});
});

describe("seedFromUltimate", () => {
	it("applies the Tyreus-Luyben formula by default", () => {
		const { p, i, d } = seedFromUltimate(320, 1);
		expect(p).toBeCloseTo(320 / 3.2, 5);
		expect(i).toBeCloseTo(p / (2.2 * 1), 1); // i/d are rounded from the unrounded kp, so allow for that
		expect(d).toBeCloseTo(p * (1 / 6.3), 1);
	});
	it("applies the classic Ziegler-Nichols formula when requested", () => {
		const { p } = seedFromUltimate(320, 1, "zn-classic");
		expect(p).toBeCloseTo(0.6 * 320, 5);
	});
	it("scales the amigo rule by lambda (more aggressive with a larger lambda)", () => {
		const base = seedFromUltimate(320, 1, "amigo", 1);
		const hot = seedFromUltimate(320, 1, "amigo", 2);
		expect(hot.p).toBeGreaterThan(base.p);
	});
});

describe("detectUltimate", () => {
	it("continues while there's no sustained oscillation yet", () => {
		const result = detectUltimate([{ value: 30, signal: sig({ oscPeriod: null, stats: { restRing: 0 } }) }]);
		expect(result.kind).toBe("continue");
	});
	it("finds Ku/Tu once a clean, non-saturating oscillation appears", () => {
		const result = detectUltimate([{ value: 70, signal: sig({ oscPeriod: 0.04, stats: { restRing: 5 } }) }]);
		expect(result).toEqual({ kind: "found", ku: 70, tu: 0.04 });
	});
	it("abandons the search if the loop saturates before a clean oscillation shows up", () => {
		const result = detectUltimate([{ value: 90, signal: sig({ pTermSatDuty: 0.5 }) }]);
		expect(result.kind).toBe("abandon");
	});
});

// ---- verifyAccepted ----

describe("verifyAccepted", () => {
	it("accepts immediately when the fresh capture is stable", async () => {
		const { effects } = fakeEffects({ captureSignal: vi.fn(async () => GOOD_SIGNAL) });
		const pid = basePid();
		const result = await verifyAccepted(effects, "p", pid, 150, 1, 2);
		expect(result.ok).toBe(true);
		if (result.ok) { expect(result.value).toBe(150); }
		expect(effects.captureSignal).toHaveBeenCalledTimes(1);
	});

	it("halves the value and re-verifies when the fresh capture is unstable, then accepts", async () => {
		let call = 0;
		const captureSignal = vi.fn(async () => {
			call++;
			return call === 1 ? sig({ pTermSatDuty: 0.5 }) : GOOD_SIGNAL; // unstable once, then fine
		});
		const { effects } = fakeEffects({ captureSignal });
		const result = await verifyAccepted(effects, "p", basePid(), 200, 1, 2);
		expect(result.ok).toBe(true);
		if (result.ok) { expect(result.value).toBe(nextBackoff(200, 0, "p")); }
		expect(captureSignal).toHaveBeenCalledTimes(2);
	});

	it("fails cleanly after exhausting the verification retries", async () => {
		const { effects } = fakeEffects({ captureSignal: vi.fn(async () => sig({ pTermSatDuty: 0.9 })) });
		const result = await verifyAccepted(effects, "p", basePid(), 300, 1, 2);
		expect(result.ok).toBe(false);
		if (!result.ok) { expect(result.reason).toContain("stayed unstable"); }
	});

	it("fails immediately if the verification capture itself fails", async () => {
		const { effects } = fakeEffects({ captureSignal: vi.fn(async () => null) });
		const result = await verifyAccepted(effects, "p", basePid(), 150, 1, 2);
		expect(result.ok).toBe(false);
	});
});

// ---- runSignalTerm / runStepTerm (isolated single-term loop) ----

describe("runSignalTerm", () => {
	it("ramps P until it plateaus, then verifies and accepts", async () => {
		const pid = basePid();
		// Tracking error genuinely improves with P (asymptotically), so the strategy must ramp a few
		// times before the improvement drops below the plateau threshold — unlike a constant-signal
		// mock, which would let it "accept" the very first value tried as tied-for-best.
		const captureSignal = vi.fn(async () => sig({ stats: { moveRms: Math.max(0.05, 20 / Math.max(1, pid.p)), restNoise: 0.05 } }));
		const { effects } = fakeEffects({ captureSignal });
		const result = await runSignalTerm(effects, SIGNAL_P_STRATEGY, pid, 1, 2, 30);
		expect(result.ok).toBe(true);
		expect(pid.p).toBeGreaterThan(30); // ramped at least once
	});

	it("stops immediately when cancelled", async () => {
		const { effects } = fakeEffects({ isCancelled: () => true });
		const result = await runSignalTerm(effects, SIGNAL_D_STRATEGY, basePid(), 1, 2, 0);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("Cancelled.");
	});

	describe("I-stage dither confirmation (docs/PLAN-v2.7-feedback.md §3)", () => {
		const cleanRest = { restTailValid: true, errorRestRipple: 0.05, errorRestRms: 0.02, errorRestQuantum: 0.05, pTermRestRipple: 5, pTermRestRms: 2, dTermRestRipple: 0, outputRestRipple: 0, restTailSamples: 100 };
		const ditherRest = { ...cleanRest, errorRestRipple: 0.6 }; // 12 quanta — a real limit cycle

		it("accepts I=0 when every confirmation capture is clean", async () => {
			const captureSignal = vi.fn(async () => sig({ stats: { restBias: 0.02 }, restEffort: cleanRest }));
			const { effects, log } = fakeEffects({ captureSignal });
			const pid = basePid();
			const result = await runSignalTerm(effects, SIGNAL_I_STRATEGY, pid, 1, 2, 0);
			expect(result.ok).toBe(true);
			expect(pid.i).toBe(0);
			expect(log.some((l) => l.includes("confirmed — I=0 holds"))).toBe(true);
		});

		it("does NOT accept I=0 when a confirmation capture shows a real dither — raises I and continues", async () => {
			// n=1 accept-decide capture, n=2 verifyAccepted capture, n>=3 the confirmation captures.
			let n = 0;
			const captureSignal = vi.fn(async () => {
				n++;
				return sig({ stats: { restBias: 0.02 }, restEffort: n === 3 ? ditherRest : cleanRest });
			});
			const { effects, log } = fakeEffects({ captureSignal });
			const pid = basePid();
			const result = await runSignalTerm(effects, SIGNAL_I_STRATEGY, pid, 1, 2, 0);
			expect(result.ok).toBe(true);
			expect(pid.i).toBeGreaterThan(0);
			expect(log.some((l) => l.includes("showed standstill dither"))).toBe(true);
		});

		it("does not crash or silently accept I=0 when the confirmation captures fail outright", async () => {
			let n = 0;
			const captureSignal = vi.fn(async () => {
				n++;
				if (n <= 2) { return sig({ stats: { restBias: 0.02 }, restEffort: cleanRest }); } // accept + verify
				if (n <= 5) { return null; } // 1st confirmation captureMedian: 3 nulls exhaust its retries
				return sig({ stats: { restBias: 0.02 }, restEffort: cleanRest }); // ramp capture at the bumped I
			});
			const { effects } = fakeEffects({ captureSignal });
			const pid = basePid();
			const result = await runSignalTerm(effects, SIGNAL_I_STRATEGY, pid, 1, 2, 0);
			expect(result.ok).toBe(true);
			expect(pid.i).toBeGreaterThan(0); // bumped, not silently accepted at 0
		});

		it("does not confirm (no extra captures) when the I stage accepts a real, non-zero integrator", async () => {
			// bias only settles once I is up at 1000 — the strategy raises I to 1000, accepts, and 1000 is
			// well above I_CONFIRM_MAX so no confirmation captures are spent.
			const captureSignal = vi.fn(async () => sig({ stats: { restBias: pidI() >= 1000 ? 0.02 : 0.5 }, restEffort: cleanRest }));
			let pidRef: PidConfig;
			function pidI() { return pidRef?.i ?? 0; }
			const { effects, log } = fakeEffects({ captureSignal });
			pidRef = basePid();
			const result = await runSignalTerm(effects, SIGNAL_I_STRATEGY, pidRef, 1, 2, 0);
			expect(result.ok).toBe(true);
			expect(pidRef.i).toBeGreaterThanOrEqual(1000);
			expect(log.some((l) => l.includes("confirming I="))).toBe(false);
		});
	});

	it("fails cleanly when the capture returns null", async () => {
		const { effects } = fakeEffects({ captureSignal: vi.fn(async () => null) });
		const result = await runSignalTerm(effects, SIGNAL_P_STRATEGY, basePid(), 1, 2, 30);
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("capture failed");
	});

	it("clamps a manual D ceiling instead of following the strategy's own next value (docs/PLAN-v2.4-feedback.md §2.2)", async () => {
		const pid = basePid();
		let overshoot = 20;
		// Overshoot keeps "genuinely improving" every attempt (never plateaus, never rings) so the
		// strategy would ramp D all the way to its own max on its own — the ceiling is the only thing
		// that should stop it here.
		const captureSignal = vi.fn(async () => {
			const s = sig({ stats: { settleOvershoot: overshoot, restRing: 0 } });
			overshoot *= 0.9;
			return s;
		});
		const { effects } = fakeEffects({ captureSignal });
		const ceiling = 0.05;
		await runSignalTerm(effects, SIGNAL_D_STRATEGY, pid, 1, 2, 0, [], ceiling);
		expect(pid.d).toBeLessThanOrEqual(ceiling);
	});

	it("omitting the ceiling (default Infinity) reproduces the un-clamped ramp unchanged", async () => {
		const captureSignal = vi.fn(async () => sig({ stats: { settleOvershoot: 3, restRing: 0 } }));
		const { effects: effectsA } = fakeEffects({ captureSignal });
		const { effects: effectsB } = fakeEffects({ captureSignal });
		const noCeiling = await runSignalTerm(effectsA, SIGNAL_D_STRATEGY, basePid(), 1, 2, 0);
		const explicitInfinity = await runSignalTerm(effectsB, SIGNAL_D_STRATEGY, basePid(), 1, 2, 0, [], Infinity);
		expect(noCeiling).toEqual(explicitInfinity);
	});

	it("propagates a verification failure as a term failure", async () => {
		// D accepts D=0 immediately (overshoot low), but every fresh capture used for verification is
		// unstable, so it should exhaust verification retries and fail the whole term.
		const { effects } = fakeEffects({ captureSignal: vi.fn(async () => sig({ stats: { settleOvershoot: 0.1 }, pTermSatDuty: 0.9 })) });
		const result = await runSignalTerm(effects, SIGNAL_D_STRATEGY, basePid(), 1, 1, 0);
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("stayed unstable");
	});
});

describe("runStepTerm (legacy step-response path)", () => {
	it("converges P via rise-time plateau", async () => {
		const { effects } = fakeEffects({ captureStep: vi.fn(async () => stepM({ riseTime: 0.02 })) });
		const pid = basePid();
		const result = await runStepTerm(effects, P_STRATEGY, pid, 30);
		expect(result.ok).toBe(true);
	});

	it("accepts I=0 immediately when steady-state error is already small", async () => {
		const { effects } = fakeEffects({ captureStep: vi.fn(async () => stepM({ steadyStateError: 0.02 })) });
		const pid = basePid();
		const result = await runStepTerm(effects, I_STRATEGY, pid, 0);
		expect(result.ok).toBe(true);
		expect(pid.i).toBe(0);
	});

	it("cancels mid-loop", async () => {
		const { effects } = fakeEffects({ isCancelled: () => true });
		const result = await runStepTerm(effects, D_STRATEGY, basePid(), 0);
		expect(result.ok).toBe(false);
	});
});

// ---- Bidirectional refinement (the cycle-2+ fix: it must be able to move a value, not just repeat it) ----

describe("refinementDelta", () => {
	it("starts at 25% for cycle 2 and halves each cycle after", () => {
		expect(refinementDelta(2)).toBeCloseTo(0.25);
		expect(refinementDelta(3)).toBeCloseTo(0.125);
		expect(refinementDelta(4)).toBeCloseTo(0.0625);
	});
});

describe("refineTerm", () => {
	const flatBaseline = sig({ stats: { moveRms: 1.0, restNoise: 0.05, restBias: 0, settleOvershoot: 0, restRing: 0 } });

	it("raises the term when a higher value is a real (noise-clearing) improvement", async () => {
		const pid = basePid(); pid.p = 100;
		const captureSignal = vi.fn(async () => (pid.p === 125
			? sig({ stats: { moveRms: 0.2, restNoise: 0.05, restBias: 0, settleOvershoot: 0, restRing: 0 } })
			: flatBaseline));
		const { effects } = fakeEffects({ captureSignal });
		const result = await refineTerm(effects, "p", pid, flatBaseline, 1, 2, 0.25);
		expect(result.changed).toBe(true);
		expect(pid.p).toBe(125);
		expect(captureSignal).toHaveBeenCalledTimes(2); // one up-probe + one verification capture
	});

	it("lowers the term when only the lower value is a real improvement", async () => {
		const pid = basePid(); pid.p = 100;
		const captureSignal = vi.fn(async () => (pid.p === 75
			? sig({ stats: { moveRms: 0.2, restNoise: 0.05, restBias: 0, settleOvershoot: 0, restRing: 0 } })
			: flatBaseline));
		const { effects } = fakeEffects({ captureSignal });
		const result = await refineTerm(effects, "p", pid, flatBaseline, 1, 2, 0.25);
		expect(result.changed).toBe(true);
		expect(pid.p).toBe(75);
		expect(captureSignal).toHaveBeenCalledTimes(3); // up-probe (no help) + down-probe + verification
	});

	it("leaves the term unchanged when neither direction is a real improvement — this is the bug fix: the OLD refinement path could only ever repeat the same value, this one PROVES it (not by accident)", async () => {
		const pid = basePid(); pid.p = 100;
		const captureSignal = vi.fn(async () => flatBaseline); // identical reading in every direction
		const { effects } = fakeEffects({ captureSignal });
		const result = await refineTerm(effects, "p", pid, flatBaseline, 1, 2, 0.25);
		expect(result.changed).toBe(false);
		expect(pid.p).toBe(100);
		expect(captureSignal).toHaveBeenCalledTimes(2); // up-probe + down-probe, no verification wasted
	});

	it("reverts to the original value (without failing) when the improvement doesn't survive verification", async () => {
		const pid = basePid(); pid.p = 100;
		// The up-probe (P=125) looks better on the very first capture, but every capture from then on —
		// verification at 125 AND at every backed-off value verifyAccepted tries — is unstable.
		// Refinement must fall back to the safe original value instead of aborting the whole run.
		let calls = 0;
		const captureSignal = vi.fn(async () => {
			calls++;
			if (calls === 1) { return sig({ stats: { moveRms: 0.2, restNoise: 0.05 } }); }
			return sig({ pTermSatDuty: 0.9 });
		});
		const { effects } = fakeEffects({ captureSignal });
		const result = await refineTerm(effects, "p", pid, flatBaseline, 1, 1, 0.25);
		expect(result.changed).toBe(false);
		expect(pid.p).toBe(100);
	});

	it("uses an absolute floor step (not a zero-times-fraction no-op) when refining a term that's currently 0", async () => {
		const pid = basePid(); pid.d = 0;
		const seen: Array<number> = [];
		const captureSignal = vi.fn(async () => { seen.push(pid.d); return flatBaseline; });
		const { effects } = fakeEffects({ captureSignal });
		await refineTerm(effects, "d", pid, flatBaseline, 1, 2, 0.25);
		expect(seen.some((v) => v > 0)).toBe(true); // at least one probe actually moved off 0
	});
});

describe("refineAxisCycle", () => {
	it("visits every term in the Duet-documented order (P → A → V → D → I)", async () => {
		const pid = basePid();
		const order: Array<string> = [];
		const onStage = vi.fn((stage: string) => order.push(stage));
		const { effects } = fakeEffects({ onStage, captureSignal: vi.fn(async () => GOOD_SIGNAL) });
		await refineAxisCycle(effects, pid, 2, 1, 2);
		const perTermOrder = order.filter((_, i) => i % 2 === 0); // onStage fires running,done per term — take one per term
		expect(perTermOrder).toEqual(AUTOTUNE_SIGNAL_SEQUENCE.map((s) => s.term));
	});

	it("skips refinement gracefully (without failing) when the baseline capture fails", async () => {
		const pid = basePid();
		const { effects, log } = fakeEffects({ captureSignal: vi.fn(async () => null) });
		const result = await refineAxisCycle(effects, pid, 2, 1, 2);
		expect(result.ok).toBe(true);
		expect(result.attempts).toEqual([]);
		expect(log.some((l) => l.includes("baseline capture failed"))).toBe(true);
	});
});

// ---- runAutoTune (end-to-end orchestration) ----

describe("runAutoTune — happy path", () => {
	it("converges on an axis driver without needing a restore (model-fit default)", async () => {
		const { effects, log } = fakeEffects();
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true });
		expect(result.ok).toBe(true);
		expect(result.restored).toBeFalsy();
		// GOOD_SIGNAL has a flat accel peak (never nears the rail) — the model fit must degrade to its
		// best-measured reading, not throw the identification away and re-ramp.
		expect(log.some((l) => l.includes("using the best measured reading directly"))).toBe(true);
		expect(log.some((l) => l.includes("Seeding: probing"))).toBe(false); // never re-ramps the same curve
	});

	it("converges via the classic path when continuous-cycling is selected and nothing oscillates", async () => {
		const { effects, log } = fakeEffects();
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true, identifyMethod: "continuous-cycling" });
		expect(result.ok).toBe(true);
		expect(result.attempts.length).toBeGreaterThan(0);
		expect(log.some((l) => l.includes("falling back to the conservative ramp"))).toBe(true); // GOOD_SIGNAL never oscillates
	});

	it("converges on an extruder (no axis) via the legacy step path", async () => {
		const { effects } = fakeEffects();
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: false });
		expect(result.ok).toBe(true);
		expect(result.restored).toBeFalsy();
		expect(effects.captureStep).toHaveBeenCalled();
	});
});

describe("runAutoTune — E (warn/error threshold) raise-and-restore", () => {
	it("raises E before preflight's own probe runs, then restores it to whatever readPid actually reported (not a hardcoded default)", async () => {
		// A deliberately non-default snapshot — proves the restore uses the REAL prior value, not E2:4.
		// applyPid mutates and reuses the SAME pid object across the whole run, so a plain vi.fn()'s
		// .mock.calls would hold live references, not what was true at each call — snapshot with a
		// spread on every call instead.
		const snapshot: PidConfig = { p: 30, i: 0, d: 0, v: 0, a: 0, warn: 5, err: 10 };
		const applySnapshots: Array<PidConfig> = [];
		const applyPid = vi.fn(async (p: PidConfig) => { applySnapshots.push({ ...p }); });
		const { effects } = fakeEffects({ readPid: vi.fn(async () => snapshot), applyPid });
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true });
		expect(result.ok).toBe(true);

		// The very first applyPid call of the whole run is the E raise, before preflight/any capture.
		expect(applySnapshots[0]).toMatchObject({ warn: 500000, err: 1000000 });
		expect(effects.captureSignal).toHaveBeenCalled();
		const firstCaptureCallOrder = (effects.captureSignal as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
		const raiseCallOrder = applyPid.mock.invocationCallOrder[0];
		expect(raiseCallOrder).toBeLessThan(firstCaptureCallOrder);
		// Restored on success: the final PID must carry the run's own tuned P/I/D/V/A but the ORIGINAL E.
		expect(result.pid.warn).toBe(5);
		expect(result.pid.err).toBe(10);
		expect(applySnapshots[applySnapshots.length - 1]).toMatchObject({ warn: 5, err: 10 });
	});

	it("restores E (to the real snapshot, not a default) on a failed/cancelled run too", async () => {
		const snapshot: PidConfig = { p: 77, i: 1, d: 2, v: 3, a: 4, warn: 7, err: 14 };
		const { effects } = fakeEffects({ readPid: vi.fn(async () => snapshot), captureSignal: vi.fn(async () => null) });
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true });
		expect(result.ok).toBe(false);
		expect(result.pid.warn).toBe(7);
		expect(result.pid.err).toBe(14);
		expect(effects.applyPid).toHaveBeenLastCalledWith(snapshot);
	});

	it("leaves E untouched (no E parameter at all) when the user never had one set (both null)", async () => {
		const { effects } = fakeEffects({ readPid: vi.fn(async () => basePid()) }); // warn/err: null
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true });
		expect(result.ok).toBe(true);
		expect(result.pid.warn).toBeNull();
		expect(result.pid.err).toBeNull();
	});
});

describe("runAutoTune — safety: snapshot and rollback", () => {
	it("restores the pre-run PID snapshot when every capture fails", async () => {
		const snapshot: PidConfig = { p: 77, i: 1, d: 2, v: 3, a: 4, warn: null, err: null };
		const { effects } = fakeEffects({
			readPid: vi.fn(async () => snapshot),
			captureSignal: vi.fn(async () => null),
		});
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true });
		expect(result.ok).toBe(false);
		expect(result.restored).toBe(true);
		expect(result.pid).toEqual(snapshot);
		expect(effects.applyPid).toHaveBeenLastCalledWith(snapshot);
	});

	it("falls back to the caller-supplied starting PID when the snapshot read fails", async () => {
		const startPid: PidConfig = { p: 55, i: 5, d: 6, v: 7, a: 8, warn: null, err: null };
		const { effects } = fakeEffects({
			readPid: vi.fn(async () => null),
			captureSignal: vi.fn(async () => null),
		});
		const result = await runAutoTune(effects, startPid, { cycles: 1, hasAxis: true });
		expect(result.ok).toBe(false);
		expect(result.pid).toEqual(startPid);
		expect(effects.applyPid).toHaveBeenLastCalledWith(startPid);
	});

	it("stops immediately and restores when cancelled before the first capture", async () => {
		const snapshot: PidConfig = { p: 42, i: 0, d: 0, v: 0, a: 0, warn: null, err: null };
		const { effects } = fakeEffects({ readPid: vi.fn(async () => snapshot), isCancelled: () => true });
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("Cancelled.");
		expect(result.restored).toBe(true);
		expect(effects.captureSignal).not.toHaveBeenCalled();
	});

	it("fails cleanly (and still runs the restore, harmlessly) when ensureReady() fails before anything is touched", async () => {
		const { effects } = fakeEffects({ ensureReady: vi.fn(async () => false) });
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true });
		expect(result.ok).toBe(false);
		expect(effects.captureSignal).not.toHaveBeenCalled();
	});
});

describe("runAutoTune — Ku/Tu seeding", () => {
	it("finds a sustained oscillation and seeds P/I/D from it", async () => {
		let lastAppliedP = 0;
		const applyPid = vi.fn(async (p: PidConfig) => { lastAppliedP = p.p; });
		const captureSignal = vi.fn(async () => {
			// P=70 is the 3rd value the seeding ramp tries (30 → 50 → 70); flag that one as a clean,
			// non-saturating sustained oscillation — everything else (the preflight probe included)
			// looks stable with no oscillation.
			if (lastAppliedP === 70) { return sig({ oscPeriod: 0.05, stats: { restRing: 5 } }); }
			return sig({ oscPeriod: null, stats: { restRing: 0 } });
		});
		const { effects, log } = fakeEffects({ applyPid, captureSignal });
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true, identifyMethod: "continuous-cycling" });
		expect(result.ok).toBe(true);
		expect(result.ku).toBe(70);
		expect(result.tu).toBe(0.05);
		expect(log.some((l) => l.includes("Seeding: found Ku=70"))).toBe(true);
		expect(log.some((l) => l.includes("Seeding: starting from P="))).toBe(true);
	});

	it("abandons seeding and falls back to the conservative ramp when it saturates first", async () => {
		let call = 0;
		const captureSignal = vi.fn(async () => {
			call++;
			if (call === 2) { return sig({ pTermSatDuty: 0.6 }); } // saturates before any oscillation is seen
			return GOOD_SIGNAL;
		});
		const { effects, log } = fakeEffects({ captureSignal });
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true, identifyMethod: "continuous-cycling" });
		expect(result.ok).toBe(true); // the rest of the tune still completes on the conservative ramp
		expect(result.ku).toBeUndefined();
		expect(log.some((l) => l.includes("went unstable before a clean sustained oscillation was found"))).toBe(true);
		expect(log.some((l) => l.includes("Falling back to the conservative ramp"))).toBe(true);
	});
});

describe("runAutoTune — relay-feedback identification (identifyMethod: 'relay')", () => {
	it("identifies Ku/Tu via the describing-function formula at a fixed high P, bypassing the ramp search", async () => {
		let lastAppliedP = 0;
		const applyPid = vi.fn(async (p: PidConfig) => { lastAppliedP = p.p; });
		const captureSignal = vi.fn(async () => (lastAppliedP === P_MAX
			// A clean bounded limit cycle: amplitude 2 steps, period 40 ms.
			? sig({ oscPeriod: 0.04, oscAmplitude: 2, stats: { movePeak: 5 } })
			: GOOD_SIGNAL)); // preflight probe and anything else looks stable/flat
		const { effects, log } = fakeEffects({ applyPid, captureSignal });
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true, identifyMethod: "relay" });
		expect(result.ok).toBe(true);
		const expectedKu = (4 * 256) / (Math.PI * 2); // P_TERM_CLAMP=256 — the relay's real saturation half-amplitude, not the P_TERM_RAIL=250 detection margin (docs/PLAN-rail-detection.md §4)
		expect(result.ku).toBeCloseTo(expectedKu, 5);
		expect(result.tu).toBe(0.04);
		expect(log.some((l) => l.includes("Relay feedback: found Ku="))).toBe(true);
		expect(log.some((l) => l.includes("Seeding: probing P="))).toBe(false); // the ramp search never runs
	});

	it("falls back to the conservative ramp when the relay probe runs away instead of a bounded limit cycle", async () => {
		let lastAppliedP = 0;
		const applyPid = vi.fn(async (p: PidConfig) => { lastAppliedP = p.p; });
		const captureSignal = vi.fn(async () => (lastAppliedP === P_MAX ? sig({ stats: { movePeak: 500 } }) : GOOD_SIGNAL));
		const { effects, log } = fakeEffects({ applyPid, captureSignal });
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true, identifyMethod: "relay" });
		expect(result.ok).toBe(true); // still completes via the conservative ramp
		expect(result.ku).toBeUndefined();
		expect(log.some((l) => l.includes("Relay feedback:") && l.includes("unbounded error"))).toBe(true);
	});

	it("falls back to the conservative ramp when no clean oscillation is found at the relay P", async () => {
		const { effects, log } = fakeEffects({ captureSignal: vi.fn(async () => GOOD_SIGNAL) }); // never oscillates
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true, identifyMethod: "relay" });
		expect(result.ok).toBe(true);
		expect(result.ku).toBeUndefined();
		expect(log.some((l) => l.includes("Relay feedback: no clean sustained oscillation found"))).toBe(true);
	});
});

describe("runAutoTune — cycle refinement", () => {
	it("starts cycle 2 from cycle 1's accepted values instead of the strategy defaults", async () => {
		let lastAppliedP = 30;
		const applyPid = vi.fn(async (p: PidConfig) => { lastAppliedP = p.p; });
		const captureSignal = vi.fn(async () => {
			const rms = Math.max(0.05, 20 / Math.max(1, lastAppliedP));
			return sig({ stats: { moveRms: rms, restNoise: 0.05, restBias: 0.05, settleOvershoot: 0.1, restRing: 0 }, itae: 2 });
		});
		const { effects, log } = fakeEffects({ applyPid, captureSignal });
		const result = await runAutoTune(effects, basePid(), { cycles: 2, hasAxis: true, identifyMethod: "continuous-cycling" });
		expect(result.ok).toBe(true);
		// The ramp-start line ("P (proportional): P=30 → ...") should only appear once — cycle 2 must
		// begin from whatever cycle 1 converged to, not restart the ramp from the strategy default.
		const p30Lines = log.filter((l) => l.includes("P (proportional): P=30 →"));
		expect(p30Lines.length).toBe(1);
	});
});

describe("runAutoTune — ITAE plateau early-stop", () => {
	it("stops before exhausting all configured cycles once ITAE stops improving", async () => {
		const captureSignal = vi.fn(async () => sig({ stats: { moveRms: 0.05, restBias: 0.05, settleOvershoot: 0.1, restRing: 0 }, itae: 2 }));
		const { effects, log } = fakeEffects({ captureSignal });
		const result = await runAutoTune(effects, basePid(), { cycles: 5, hasAxis: true });
		expect(result.ok).toBe(true);
		const cycleLines = log.filter((l) => l.includes("──── Cycle"));
		expect(cycleLines.length).toBeLessThan(5);
		expect(log.some((l) => l.includes("ITAE") && l.includes("stopping early"))).toBe(true);
	});
});

describe("runAutoTune — preflight (axis drivers)", () => {
	it("skips calibration entirely when the driver is already tracking", async () => {
		const runCalibration = vi.fn(async () => "ok");
		const { effects } = fakeEffects({ runCalibration }); // default captureSignal (GOOD_SIGNAL) already tracks
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true, calibrationMoveIds: [1, 2] });
		expect(result.ok).toBe(true);
		expect(result.preflightActions).toEqual([]);
		expect(runCalibration).not.toHaveBeenCalled();
	});

	it("runs calibration and re-probes when the driver isn't tracking, then proceeds", async () => {
		let calibrated = false;
		const runCalibration = vi.fn(async (moveId: number) => { calibrated = true; return `Calibration V${moveId} complete`; });
		const captureSignal = vi.fn(async () => (calibrated ? GOOD_SIGNAL : sig({ stats: { movePeak: 500 } })));
		const { effects } = fakeEffects({ runCalibration, captureSignal });
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true, calibrationMoveIds: [1, 2] });
		expect(result.ok).toBe(true);
		expect(result.preflightActions).toEqual(["V1", "V2"]);
		expect(runCalibration).toHaveBeenCalledTimes(2);
	});

	it("fails cleanly (with restore) when not tracking and no calibration is configured", async () => {
		const captureSignal = vi.fn(async () => sig({ stats: { movePeak: 500 } })); // never tracks
		const snapshot: PidConfig = { p: 42, i: 1, d: 2, v: 3, a: 4, warn: null, err: null };
		const { effects } = fakeEffects({ captureSignal, readPid: vi.fn(async () => snapshot) });
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true, calibrationMoveIds: [] });
		expect(result.ok).toBe(false);
		expect(result.restored).toBe(true);
		expect(result.pid).toEqual(snapshot);
		expect(result.reason).toContain("no calibration is configured");
	});

	it("fails cleanly when calibration doesn't fix the tracking problem", async () => {
		const runCalibration = vi.fn(async () => "did nothing useful");
		const captureSignal = vi.fn(async () => sig({ stats: { movePeak: 500 } })); // stays unstable regardless
		const { effects } = fakeEffects({ runCalibration, captureSignal });
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true, calibrationMoveIds: [1] });
		expect(result.ok).toBe(false);
		expect(result.restored).toBe(true);
		expect(result.preflightActions).toEqual(["V1"]);
		expect(result.reason).toContain("Still not tracking");
	});

	it("skips the tracking probe entirely for extruders (no axis)", async () => {
		const captureSignal = vi.fn(async () => null); // would fail the run if it were ever called
		const { effects } = fakeEffects({ captureSignal });
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: false });
		expect(result.ok).toBe(true); // converges via the legacy captureStep path instead
		expect(captureSignal).not.toHaveBeenCalled();
	});
});

describe("runAutoTune — failure containment (a late measurement failure keeps earlier verified progress)", () => {
	it("reproduces the field failure: P and A verify fine, V's capture glitches persistently — the run completes instead of restoring everything", async () => {
		// P and A behave like GOOD_SIGNAL throughout (verify immediately); V's capture always comes back
		// null (e.g. a persistently corrupt CSV, or the move never reaching cruise) once V is being probed.
		const captureSignal = vi.fn(async (): Promise<TuneSignal | null> => GOOD_SIGNAL);
		const { effects, log } = fakeEffects({
			captureSignal,
			onAttempt: vi.fn((term: string) => {
				if (term === "v") { captureSignal.mockImplementation(async () => null); }
			}),
		});
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true, identifyMethod: "continuous-cycling" });
		expect(result.ok).toBe(true);
		expect(result.restored).toBeFalsy();
		expect(result.pid.v).toBe(0); // V never got a value — kept its starting value, not discarded entirely
		expect(log.some((l) => l.includes("V (velocity feed-forward):") && l.includes("Keeping V=0 and continuing"))).toBe(true);
	});

	it("still fails and restores when P itself can never be measured (capture is fundamentally broken)", async () => {
		const snapshot: PidConfig = { p: 42, i: 1, d: 2, v: 3, a: 4, warn: null, err: null };
		const { effects } = fakeEffects({
			readPid: vi.fn(async () => snapshot),
			captureSignal: vi.fn(async () => null),
		});
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true });
		expect(result.ok).toBe(false);
		expect(result.restored).toBe(true);
		expect(result.pid).toEqual(snapshot);
	});
});

describe("runAutoTune — final verification", () => {
	it("skips the correction pass when the grade is already good", async () => {
		const evaluateCapture = vi.fn(async () => evaluation({ grade: "excellent", score: 96 }));
		const { effects } = fakeEffects({ evaluateCapture });
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true });
		expect(result.ok).toBe(true);
		expect(result.evaluation?.grade).toBe("excellent");
		expect(evaluateCapture).toHaveBeenCalledTimes(1);
	});

	it("applies one bounded correction pass when the grade is below good, and keeps it if it helps", async () => {
		let call = 0;
		const evaluateCapture = vi.fn(async () => {
			call++;
			return call === 1
				? evaluation({ grade: "fair", score: 60, findings: [{ severity: "warn", title: "Slight standing error", detail: "x", term: "d", direction: "up" }] })
				: evaluation({ grade: "good", score: 85 });
		});
		const { effects } = fakeEffects({ evaluateCapture });
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true });
		expect(result.ok).toBe(true);
		expect(result.evaluation?.grade).toBe("good");
		expect(evaluateCapture).toHaveBeenCalledTimes(2);
		expect(result.pid.d).toBeGreaterThan(0); // D was raised from 0 by the correction
	});

	it("reverts the correction pass if it doesn't help, keeping the pre-correction evaluation", async () => {
		let call = 0;
		const evaluateCapture = vi.fn(async () => {
			call++;
			return call === 1
				? evaluation({ grade: "fair", score: 60, findings: [{ severity: "warn", title: "x", detail: "x", term: "p", direction: "up" }] })
				: evaluation({ grade: "poor", score: 20 }); // correction made it worse
		});
		const { effects } = fakeEffects({ evaluateCapture });
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true });
		expect(result.ok).toBe(true);
		expect(result.evaluation?.grade).toBe("fair"); // reverted — reports the pre-correction grade
	});

	it("doesn't fail the run when the verification capture itself fails", async () => {
		const { effects } = fakeEffects({ evaluateCapture: vi.fn(async () => null) });
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true });
		expect(result.ok).toBe(true);
		expect(result.evaluation).toBeUndefined();
	});
});

describe("runAutoTune — envelope check (docs/PLAN-envelope-check.md)", () => {
	const envCheck = (over: Record<string, unknown>) => ({ feedMmPerMin: 36000, achievedFeedMmPerMin: 35000, satDuty: 0.001, outcome: "holds" as const, ...over });

	it("carries a holding result through to AutoRunResult and logs it", async () => {
		const checkEnvelope = vi.fn(async () => envCheck({}));
		const { effects, log } = fakeEffects({ checkEnvelope });
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true });
		expect(result.ok).toBe(true);
		expect(result.envelopeCheck?.outcome).toBe("holds");
		expect(checkEnvelope).toHaveBeenCalledTimes(1);
		expect(log.some((l) => l.includes("Envelope check: holds"))).toBe(true);
	});

	it("carries a saturating result through and logs it as a warning, without touching the tuned pid", async () => {
		// Same tuning inputs (a converging signal), differing only in what checkEnvelope reports — proves
		// a saturating envelope check (report-only) does not perturb the P the run already converged on.
		const captureSignal = vi.fn(async () => sig({ stats: { moveRms: Math.max(0.05, 20 / Math.max(1, 100)), restNoise: 0.05 } }));
		const holding = fakeEffects({ captureSignal, checkEnvelope: vi.fn(async () => envCheck({ satDuty: 0 })) });
		const failing = fakeEffects({ captureSignal, checkEnvelope: vi.fn(async () => envCheck({ satDuty: 0.05, outcome: "saturates" })) });
		const holdingResult = await runAutoTune(holding.effects, basePid(), { cycles: 1, hasAxis: true });
		const failingResult = await runAutoTune(failing.effects, basePid(), { cycles: 1, hasAxis: true });
		expect(failingResult.ok).toBe(true);
		expect(failingResult.envelopeCheck?.outcome).toBe("saturates");
		expect(failing.log.some((l) => l.includes("does NOT hold"))).toBe(true);
		expect(failingResult.pid).toEqual(holdingResult.pid);
	});

	it("logs an inconclusive result distinctly (PLAN-v2.7 §5)", async () => {
		const checkEnvelope = vi.fn(async () => envCheck({ feedMmPerMin: 96000, achievedFeedMmPerMin: 45000, satDuty: 0, outcome: "inconclusive" }));
		const { effects, log } = fakeEffects({ checkEnvelope });
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true });
		expect(result.envelopeCheck?.outcome).toBe("inconclusive");
		expect(log.some((l) => l.includes("Envelope check: inconclusive") && l.includes("F45000"))).toBe(true);
	});

	it("leaves envelopeCheck undefined and doesn't fail the run when there is nothing to check", async () => {
		const checkEnvelope = vi.fn(async () => null);
		const { effects } = fakeEffects({ checkEnvelope });
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true });
		expect(result.ok).toBe(true);
		expect(result.envelopeCheck).toBeUndefined();
	});

	it("doesn't fail the run when the check itself throws", async () => {
		const checkEnvelope = vi.fn(async () => { throw new Error("capture pipeline error"); });
		const { effects, log } = fakeEffects({ checkEnvelope });
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true });
		expect(result.ok).toBe(true);
		expect(result.envelopeCheck).toBeUndefined();
		expect(log.some((l) => l.includes("Envelope check skipped"))).toBe(true);
	});

	it("still runs when the run itself needed a correction pass during final verification", async () => {
		let call = 0;
		const evaluateCapture = vi.fn(async () => {
			call++;
			return call === 1
				? evaluation({ grade: "fair", score: 60, findings: [{ severity: "warn", title: "x", detail: "x", term: "d", direction: "up" }] })
				: evaluation({ grade: "good", score: 85 });
		});
		const checkEnvelope = vi.fn(async () => envCheck({ feedMmPerMin: 24000, achievedFeedMmPerMin: 23000, satDuty: 0 }));
		const { effects } = fakeEffects({ evaluateCapture, checkEnvelope });
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true });
		expect(result.ok).toBe(true);
		expect(result.envelopeCheck?.outcome).toBe("holds");
	});
});

describe("runAutoTune — identifiedAtSeed (docs/PLAN-v2.7-feedback.md §1)", () => {
	it("flags identifiedAtSeed when cycle-1 model-fit rails at the seed P", async () => {
		// Every capture already at the clamp with high sat duty — a genuine rail at P=SEED_START.
		const captureSignal = vi.fn(async () => sig({ pTermAccelPeak: 256, pTermSatDuty: 0.1, stats: { restNoise: 0.05 } }));
		const { effects } = fakeEffects({ captureSignal });
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true });
		expect(result.ok).toBe(true);
		expect(result.identifiedAtSeed).toBe(true);
	});

	it("leaves identifiedAtSeed falsy on a normal run that never rails at the seed", async () => {
		const { effects } = fakeEffects(); // GOOD_SIGNAL — flat accel peak, degrades to best-measured
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true });
		expect(result.ok).toBe(true);
		expect(result.identifiedAtSeed).toBeFalsy();
	});

	it("leaves identifiedAtSeed undefined for an extruder run (model-fit never runs)", async () => {
		const { effects } = fakeEffects();
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: false });
		expect(result.ok).toBe(true);
		expect(result.identifiedAtSeed).toBeUndefined();
	});
});

describe("runAutoTune — method dispatch", () => {
	it("method 'refine' skips seeding/ramp entirely and runs a single joint-optimisation pass from the starting values", async () => {
		const startPid: PidConfig = { p: 77, i: 200, d: 0.05, v: 10, a: 1000, warn: null, err: null };
		const { effects, log } = fakeEffects({ captureSignal: vi.fn(async () => GOOD_SIGNAL) });
		const result = await runAutoTune(effects, startPid, { cycles: 5, hasAxis: true, method: "refine" });
		expect(result.ok).toBe(true);
		expect(log.some((l) => l.includes("Seeding:"))).toBe(false);
		expect(log.some((l) => l.includes("──── Cycle 2"))).toBe(false); // forced to a single pass
		expect(log.some((l) => l.includes("Package optimise:"))).toBe(true);
	});

	it("method 'package' ramps once (cycle 1), then runs exactly one joint-optimisation pass regardless of the cycles setting", async () => {
		const { effects, log } = fakeEffects();
		const result = await runAutoTune(effects, basePid(), { cycles: 6, hasAxis: true, method: "package" });
		expect(result.ok).toBe(true);
		expect(log.some((l) => l.includes("──── Cycle 1"))).toBe(true);
		expect(log.some((l) => l.includes("──── Cycle 2"))).toBe(true);
		expect(log.some((l) => l.includes("──── Cycle 3"))).toBe(false); // capped at ramp (1) + one package pass (2)
		expect(log.some((l) => l.includes("Package optimise:"))).toBe(true);
	});

	it("carries cycle 1's model-fit 'no measurable effect' findings into cycle 2's package pass", async () => {
		// GOOD_SIGNAL never changes with the applied PID, so model-fit's A/V probes both read "no effect" —
		// exactly the case a real well-damped axis produces for A. Cycle 2's package pass should be told
		// this instead of re-discovering it from scratch (see optimize.ts's `insensitiveTerms`).
		const { effects, log } = fakeEffects({ captureSignal: vi.fn(async () => GOOD_SIGNAL) });
		const result = await runAutoTune(effects, basePid(), { cycles: 6, hasAxis: true, method: "package", identifyMethod: "model-fit" });
		expect(result.ok).toBe(true);
		expect(log.some((l) => l.includes("no measurable effect"))).toBe(true); // cycle 1's own finding
		expect(log.some((l) => l.includes("starting A, V from a smaller step"))).toBe(true); // cycle 2 reused it
	});

	it("method 'sequential' (the default) never logs a package-optimise pass", async () => {
		const { effects, log } = fakeEffects();
		const result = await runAutoTune(effects, basePid(), { cycles: 2, hasAxis: true });
		expect(result.ok).toBe(true);
		expect(log.some((l) => l.includes("Package optimise:"))).toBe(false);
	});

	it("ignores 'method' entirely on an extruder (no axis) — a persisted axis-driver choice can't change extruder cycle counts", async () => {
		const { effects, log } = fakeEffects();
		const result = await runAutoTune(effects, basePid(), { cycles: 4, hasAxis: false, method: "refine" });
		expect(result.ok).toBe(true);
		expect(effects.captureStep).toHaveBeenCalled();
		expect(effects.captureSignal).not.toHaveBeenCalled();
		expect(log.some((l) => l.includes("Package optimise:"))).toBe(false);
	});
});

describe("runAutoTune — stage-status callbacks", () => {
	it("reports preflight, every term, and verify as running then done on a clean axis run", async () => {
		const stages: Array<string> = [];
		const onStage = vi.fn((stage: string, state: string) => stages.push(`${stage}:${state}`));
		const { effects } = fakeEffects({ onStage });
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true });
		expect(result.ok).toBe(true);
		for (const stage of ["preflight", "p", "d", "i", "a", "v", "verify"]) {
			expect(stages).toContain(`${stage}:running`);
			expect(stages).toContain(`${stage}:done`);
		}
		// Every stage must report "running" before it reports "done".
		for (const stage of ["preflight", "p", "d", "i", "a", "v", "verify"]) {
			expect(stages.indexOf(`${stage}:running`)).toBeLessThan(stages.indexOf(`${stage}:done`));
		}
	});

	it("marks the failing stage as failed, and never starts a later stage in the same run", async () => {
		const stages: Array<string> = [];
		const onStage = vi.fn((stage: string, state: string) => stages.push(`${stage}:${state}`));
		let preflightDone = false;
		const captureSignal = vi.fn(async () => {
			if (!preflightDone) { preflightDone = true; return GOOD_SIGNAL; } // let preflight's probe succeed
			return null; // everything afterwards (seeding + the P ramp) fails outright
		});
		const { effects } = fakeEffects({ onStage, captureSignal });
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true });
		expect(result.ok).toBe(false);
		expect(stages).toContain("preflight:done");
		const failedStages = stages.filter((s) => s.endsWith(":failed"));
		expect(failedStages.length).toBe(1); // exactly one stage fails, and the run stops there
		expect(stages).not.toContain("i:running");
		expect(stages).not.toContain("a:running");
		expect(stages).not.toContain("v:running");
		expect(stages).not.toContain("verify:running");
	});

	it("reports preflight as failed when the driver never starts tracking", async () => {
		const stages: Array<string> = [];
		const onStage = vi.fn((stage: string, state: string) => stages.push(`${stage}:${state}`));
		const { effects } = fakeEffects({ onStage, captureSignal: vi.fn(async () => sig({ stats: { movePeak: 500 } })) });
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true, calibrationMoveIds: [] });
		expect(result.ok).toBe(false);
		expect(stages).toEqual(["preflight:running", "preflight:failed"]);
	});
});
