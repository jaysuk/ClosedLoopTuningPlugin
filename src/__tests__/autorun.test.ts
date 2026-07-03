import { describe, expect, it, vi } from "vitest";

import type { StepMetrics } from "../model/analysis";
import {
	detectUltimate, nextBackoff, runAutoTune, runSignalTerm, runStepTerm, seedFromUltimate,
	verifyAccepted, type TuneEffects,
} from "../model/autorun";
import { SIGNAL_D_STRATEGY, SIGNAL_P_STRATEGY, P_STRATEGY, D_STRATEGY, I_STRATEGY } from "../model/autotune";
import type { PidConfig } from "../model/m569";
import type { TuneSignal } from "../model/signal";
import type { TuneEvaluation, TuneStats } from "../model/evaluate";

function stats(over: Partial<TuneStats> = {}): TuneStats {
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
		pTermAccelPeak: 50, pTermCruiseMean: 1, pTermSatDuty: 0, postMoveOsc: 0,
		oscPeriod: null, itae: 0, hasMove: true,
		...rest,
	};
}
/** A signal that every strategy accepts immediately, first capture, no ramping. */
const GOOD_SIGNAL = sig({ stats: { moveRms: 0.05, restBias: 0.05, settleOvershoot: 0.1, restRing: 0 } });
function stepM(over: Partial<StepMetrics> = {}): StepMetrics {
	return { stepSize: 16, riseTime: 0.02, overshootPct: 0, settlingTime: 0.03, steadyStateError: 0.05, peakError: 0.1, rmsError: 0.05, oscillations: 0, hasStep: true, pTermSatDuty: 0, ...over };
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
		expect(nextBackoff(100, 0)).toBe(50);
		expect(nextBackoff(100, 1)).toBe(25);
		expect(nextBackoff(100, 2)).toBe(12.5);
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
		if (result.ok) { expect(result.value).toBe(nextBackoff(200, 0)); }
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

	it("fails cleanly when the capture returns null", async () => {
		const { effects } = fakeEffects({ captureSignal: vi.fn(async () => null) });
		const result = await runSignalTerm(effects, SIGNAL_P_STRATEGY, basePid(), 1, 2, 30);
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("capture failed");
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

// ---- runAutoTune (end-to-end orchestration) ----

describe("runAutoTune — happy path", () => {
	it("converges on an axis driver without needing a restore", async () => {
		const { effects, log } = fakeEffects();
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true });
		expect(result.ok).toBe(true);
		expect(result.restored).toBeFalsy();
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
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true });
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
		const result = await runAutoTune(effects, basePid(), { cycles: 1, hasAxis: true });
		expect(result.ok).toBe(true); // the rest of the tune still completes on the conservative ramp
		expect(result.ku).toBeUndefined();
		expect(log.some((l) => l.includes("went unstable before a clean sustained oscillation was found"))).toBe(true);
		expect(log.some((l) => l.includes("Falling back to the conservative ramp"))).toBe(true);
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
		const result = await runAutoTune(effects, basePid(), { cycles: 2, hasAxis: true });
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
