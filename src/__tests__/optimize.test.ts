import { describe, expect, it, vi } from "vitest";

import { EMPTY_REST_EFFORT } from "../model/analysis";
import type { TuneEffects } from "../model/autorun";
import type { TuneEvaluation, TuneStats } from "../model/evaluate";
import type { PidConfig } from "../model/m569";
import { runPackageOptimize } from "../model/optimize";
import { P_MAX } from "../model/autotune";
import type { TuneSignal } from "../model/signal";

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

describe("runPackageOptimize", () => {
	it("converges toward a known optimum for a single term", async () => {
		const pid = basePid(); pid.p = 100;
		const target = 180;
		const captureSignal = vi.fn(async () => sig({ stats: { moveRms: Math.max(0.01, Math.abs(pid.p - target) * 0.01), restNoise: 0.02 } }));
		const { effects } = fakeEffects({ captureSignal });
		const result = await runPackageOptimize(effects, pid, { terms: ["p"], captureBudget: 60 });
		expect(result.ok).toBe(true);
		expect(pid.p).toBeGreaterThan(140);
		expect(pid.p).toBeLessThan(220);
	});

	it("moves a term DOWN when the optimum is below its starting value", async () => {
		const pid = basePid(); pid.p = 300;
		const target = 200;
		const captureSignal = vi.fn(async () => sig({ stats: { moveRms: Math.max(0.01, Math.abs(pid.p - target) * 0.01), restNoise: 0.02 } }));
		const { effects } = fakeEffects({ captureSignal });
		const result = await runPackageOptimize(effects, pid, { terms: ["p"], captureBudget: 60 });
		expect(result.ok).toBe(true);
		expect(pid.p).toBeLessThan(300);
		expect(pid.p).toBeGreaterThan(150);
	});

	it("leaves every term unchanged on a flat plant (no direction ever helps)", async () => {
		const pid = basePid(); pid.p = 100; pid.d = 0.1;
		const captureSignal = vi.fn(async () => sig({ stats: { moveRms: 1, restNoise: 0.05 } }));
		const { effects } = fakeEffects({ captureSignal });
		const result = await runPackageOptimize(effects, pid, { terms: ["p", "d"], captureBudget: 30 });
		expect(result.ok).toBe(true);
		expect(pid.p).toBe(100);
		expect(pid.d).toBe(0.1);
	});

	it("respects the capture budget instead of searching indefinitely", async () => {
		const pid = basePid();
		const captureSignal = vi.fn(async () => sig({ stats: { moveRms: 1, restNoise: 0.05 } })); // never converges/improves
		const { effects } = fakeEffects({ captureSignal });
		const result = await runPackageOptimize(effects, pid, { captureBudget: 10 });
		expect(result.ok).toBe(true);
		expect(result.captures).toBeLessThanOrEqual(15); // budget (10) plus a small per-pass overshoot allowance
	});

	it("never adopts an unstable probe, even when it looks tempting on raw tracking error alone", async () => {
		const pid = basePid(); pid.p = 100;
		// Cost improves monotonically as P approaches 150 from below; anything past 150 saturates the
		// loop (reported via pTermSatDuty) even though its raw moveRms would look "better" if read alone.
		const captureSignal = vi.fn(async () => (pid.p > 150
			? sig({ pTermSatDuty: 0.9, stats: { moveRms: 0.001 } })
			: sig({ stats: { moveRms: Math.max(0.01, (150 - pid.p) * 0.01), restNoise: 0.02 } })));
		const { effects } = fakeEffects({ captureSignal });
		const result = await runPackageOptimize(effects, pid, { terms: ["p"], captureBudget: 60 });
		expect(result.ok).toBe(true);
		expect(pid.p).toBeLessThanOrEqual(150);
	});

	it("stays clamped at a term's cap when the optimum lies beyond it", async () => {
		const pid = basePid(); pid.p = 500;
		// Cost keeps improving all the way past P_MAX — the search should settle exactly at the cap.
		const captureSignal = vi.fn(async () => sig({ stats: { moveRms: Math.max(0.01, (1000 - pid.p) * 0.01), restNoise: 0.02 } }));
		const { effects } = fakeEffects({ captureSignal });
		const result = await runPackageOptimize(effects, pid, { terms: ["p"], captureBudget: 80 });
		expect(result.ok).toBe(true);
		expect(pid.p).toBe(P_MAX);
	});

	it("fails cleanly (without throwing) when the baseline capture fails", async () => {
		const { effects } = fakeEffects({ captureSignal: vi.fn(async () => null) });
		const result = await runPackageOptimize(effects, basePid());
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("baseline capture failed");
	});

	it("stops immediately when cancelled", async () => {
		const { effects } = fakeEffects({ isCancelled: () => true });
		const result = await runPackageOptimize(effects, basePid());
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("Cancelled.");
	});

	it("survives a mid-search capture failure by treating that probe as no improvement", async () => {
		const pid = basePid(); pid.p = 100;
		let call = 0;
		const captureSignal = vi.fn(async () => {
			call++;
			if (call === 2) { return null; } // the very first probe capture fails
			return sig({ stats: { moveRms: 1, restNoise: 0.05 } });
		});
		const { effects } = fakeEffects({ captureSignal });
		const result = await runPackageOptimize(effects, pid, { terms: ["p"], captureBudget: 20 });
		expect(result.ok).toBe(true);
	});

	it("logs the final settled values once the search finishes", async () => {
		const pid = basePid(); pid.p = 100; pid.d = 0.1;
		const captureSignal = vi.fn(async () => sig({ stats: { moveRms: 1, restNoise: 0.05 } })); // flat — nothing improves
		const { effects, log } = fakeEffects({ captureSignal });
		await runPackageOptimize(effects, pid, { terms: ["p", "d"], captureBudget: 20 });
		expect(log.some((l) => l.startsWith("Package optimise: final values —") && l.includes("P=") && l.includes("D="))).toBe(true);
	});

	describe("insensitiveTerms — seeding from an earlier identification pass", () => {
		it("without the hint, an always-zero term takes several passes to confirm it still doesn't matter", async () => {
			const pid = basePid(); pid.a = 0;
			const captureSignal = vi.fn(async () => sig({ stats: { moveRms: 1, restNoise: 0.05 } })); // flat
			const { effects } = fakeEffects({ captureSignal });
			const result = await runPackageOptimize(effects, pid, { terms: ["a"], captureBudget: 30 });
			const aProbes = result.attempts.filter((a) => a.term === "a").length;
			expect(aProbes).toBeGreaterThan(1);
			expect(pid.a).toBe(0);
		});

		it("with the hint, the same term settles in a single confirming probe", async () => {
			const pid = basePid(); pid.a = 0;
			const captureSignal = vi.fn(async () => sig({ stats: { moveRms: 1, restNoise: 0.05 } })); // flat
			const { effects, log } = fakeEffects({ captureSignal });
			const result = await runPackageOptimize(effects, pid, { terms: ["a"], captureBudget: 30, insensitiveTerms: ["a"] });
			const aProbes = result.attempts.filter((a) => a.term === "a").length;
			expect(aProbes).toBe(1);
			expect(pid.a).toBe(0);
			expect(log.some((l) => l.includes("starting A from a smaller step"))).toBe(true);
		});

		it("still lets a flagged term move if the joint capture shows it genuinely helps here", async () => {
			// The whole point of re-probing (rather than skipping outright) is that the joint whole-capture
			// cost can see an interaction a single term's own metric couldn't — so a real improvement must
			// still be adopted even though the term was flagged insensitive by an earlier, isolated probe.
			const pid = basePid(); pid.a = 0;
			const target = 5000; // well beyond the floor-sized first step (1000) — needs several grows to reach
			const captureSignal = vi.fn(async () => sig({ stats: { moveRms: Math.max(0.01, Math.abs(pid.a - target) * 0.001), restNoise: 0.02 } }));
			const { effects } = fakeEffects({ captureSignal });
			const result = await runPackageOptimize(effects, pid, { terms: ["a"], captureBudget: 30, insensitiveTerms: ["a"] });
			expect(result.ok).toBe(true);
			expect(pid.a).toBeGreaterThan(0);
		});
	});
});
