import { describe, expect, it } from "vitest";

import { autocorrelationPeriod } from "../model/dsp";

/** A clean decaying sine: amplitude shrinks every cycle, so late-window half-cycles may never clear an
 * amplitude gate — exactly the case autocorrelation should still catch. */
function decayingSine(n: number, periodSamples: number, decayPerCycle = 0.85): Array<number> {
	const omega = (2 * Math.PI) / periodSamples;
	return Array.from({ length: n }, (_, i) => {
		const cycles = i / periodSamples;
		const amp = Math.pow(decayPerCycle, cycles);
		return amp * Math.sin(omega * i);
	});
}

function whiteNoise(n: number, seed = 1): Array<number> {
	// Simple deterministic PRNG (mulberry32) so the test is reproducible without a real RNG dependency.
	let s = seed;
	const next = () => {
		s = (s + 0x6D2B79F5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return Array.from({ length: n }, () => next() * 2 - 1);
}

describe("autocorrelationPeriod", () => {
	it("finds the period of a clean decaying sine", () => {
		const period = 40;
		const values = decayingSine(400, period, 0.9);
		const result = autocorrelationPeriod(values, 0, values.length);
		expect(result).not.toBeNull();
		expect(result!.lagSamples).toBeGreaterThan(period * 0.85);
		expect(result!.lagSamples).toBeLessThan(period * 1.15);
		expect(result!.strength).toBeGreaterThan(0.4);
	});

	it("still finds the period even when the amplitude decays below any fixed gate late in the window", () => {
		// Decays hard enough that a zero-crossing amplitude gate calibrated on the early cycles would
		// miss everything past the first few cycles — autocorrelation uses the whole window instead.
		const period = 30;
		const values = decayingSine(300, period, 0.6);
		const result = autocorrelationPeriod(values, 0, values.length);
		expect(result).not.toBeNull();
		expect(result!.lagSamples).toBeGreaterThan(period * 0.8);
		expect(result!.lagSamples).toBeLessThan(period * 1.2);
	});

	it("returns null for pure noise (no periodicity to find)", () => {
		const values = whiteNoise(400, 42);
		const result = autocorrelationPeriod(values, 0, values.length);
		expect(result).toBeNull();
	});

	it("returns null for a flat (zero-variance) signal", () => {
		const values = new Array(200).fill(1.5);
		expect(autocorrelationPeriod(values, 0, values.length)).toBeNull();
	});

	it("returns null when the window is too short for even the shortest trusted period", () => {
		const values = decayingSine(10, 40, 0.9);
		expect(autocorrelationPeriod(values, 0, values.length)).toBeNull();
	});

	it("ignores non-finite samples instead of propagating NaN", () => {
		const values = decayingSine(200, 30, 0.9).map((v, i) => (i === 50 ? NaN : v));
		const result = autocorrelationPeriod(values, 0, values.length);
		expect(result).not.toBeNull();
	});

	it("respects the [start, end) window bounds", () => {
		const noise = whiteNoise(100, 7);
		const sine = decayingSine(200, 25, 0.95);
		const combined = [...noise, ...sine]; // noise in [0,100), clean signal in [100,300)
		expect(autocorrelationPeriod(combined, 0, 100)).toBeNull(); // noise-only window
		const result = autocorrelationPeriod(combined, 100, combined.length);
		expect(result).not.toBeNull();
	});
});
