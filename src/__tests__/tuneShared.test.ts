import { describe, expect, it, vi } from "vitest";

import { EMPTY_REST_EFFORT } from "../model/analysis";
import type { TuneEvaluation, TuneStats } from "../model/evaluate";
import type { PidConfig } from "../model/m569";
import type { TuneSignal } from "../model/signal";
import { captureMedian, type TuneEffects } from "../model/tuneShared";

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
		ensureReady: vi.fn(async () => true),
		log: (line: string) => log.push(line),
		status: () => {},
		isCancelled: () => false,
		delay: async () => {},
		...over,
	};
	return { effects, log };
}

describe("captureMedian — retry on a null/invalid capture", () => {
	it("retries a failed capture and succeeds if a later attempt is good", async () => {
		let call = 0;
		const captureSignal = vi.fn(async () => {
			call++;
			return call < 3 ? null : sig({ stats: { moveRms: 0.5 } }); // fails twice, then a good capture
		});
		const { effects, log } = fakeEffects({ captureSignal });
		const result = await captureMedian(effects, 1);
		expect(result).not.toBeNull();
		expect(result!.stats.moveRms).toBe(0.5);
		expect(captureSignal).toHaveBeenCalledTimes(3);
		expect(log.some((l) => l.includes("retrying"))).toBe(true);
	});

	it("gives up (returns null) after exhausting the retry budget", async () => {
		const captureSignal = vi.fn(async () => null);
		const { effects } = fakeEffects({ captureSignal });
		const result = await captureMedian(effects, 1);
		expect(result).toBeNull();
		expect(captureSignal.mock.calls.length).toBeLessThanOrEqual(3); // bounded, not unbounded retries
		expect(captureSignal.mock.calls.length).toBeGreaterThan(1); // did retry at least once
	});

	it("does not retry a capture that succeeds on the first try", async () => {
		const captureSignal = vi.fn(async () => sig());
		const { effects } = fakeEffects({ captureSignal });
		const result = await captureMedian(effects, 1);
		expect(result).not.toBeNull();
		expect(captureSignal).toHaveBeenCalledTimes(1);
	});

	it("applies the same retry budget independently to each of several median captures", async () => {
		let call = 0;
		const captureSignal = vi.fn(async () => {
			call++;
			// Every first attempt for a given sample fails, then succeeds — across 2 samples that's
			// calls 1 (fail), 2 (ok, sample 1), 3 (fail), 4 (ok, sample 2).
			return call % 2 === 1 ? null : sig({ stats: { moveRms: 0.5 } });
		});
		const { effects } = fakeEffects({ captureSignal });
		const result = await captureMedian(effects, 2);
		expect(result).not.toBeNull();
		expect(captureSignal).toHaveBeenCalledTimes(4);
	});

	it("stops retrying immediately if cancelled mid-retry", async () => {
		let cancelled = false;
		const captureSignal = vi.fn(async () => { cancelled = true; return null; });
		const { effects } = fakeEffects({ captureSignal, isCancelled: () => cancelled });
		const result = await captureMedian(effects, 1);
		expect(result).toBeNull();
		expect(captureSignal).toHaveBeenCalledTimes(1); // cancelled flag flips inside the first call, so no retry
	});
});
