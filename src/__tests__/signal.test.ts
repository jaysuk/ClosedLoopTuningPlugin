/**
 * computeTuneSignal / signalUnstable ground-truthed against real closed-loop captures, including the
 * ones that destabilised a loaded axis in the field (see src/__tests__/fixtures — captured with the
 * PID P Term column, so satDuty/postMoveOsc are measured, not estimated).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseCapture } from "../model/csv";
import { computeTuneSignal, medianSignal, oscillationPeriod, signalDiverging, signalUnstable, type TuneSignal } from "../model/signal";

const FIXTURE_DIR = path.join(__dirname, "fixtures");
function load(name: string) {
	return parseCapture(readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}
function signalOf(name: string): TuneSignal {
	const s = computeTuneSignal(load(name), 2000);
	if (!s) { throw new Error(`${name}: computeTuneSignal returned null`); }
	return s;
}

describe("computeTuneSignal — stable captures", () => {
	it.each([
		"step16-stable-lowP.csv",
		"step16-stable-midP.csv",
		"step16-stable-converged.csv",
		"move250-stable-early.csv",
		"move250-stable-best.csv",
		"move250-escalation-1.csv",
		"move250-escalation-2.csv",
		"hold-stable-transient.csv",
	])("%s is not flagged unstable", (name) => {
		expect(signalUnstable(signalOf(name))).toBe(false);
	});

	it("move250-stable-best has a small tracking-error rms", () => {
		expect(signalOf("move250-stable-best.csv").stats.moveRms).toBeLessThan(1);
	});
});

describe("computeTuneSignal — the captures that destabilised a loaded axis", () => {
	it("flags the onset of instability (P-term saturating ~14% of the capture)", () => {
		const s = signalOf("move250-instability-onset.csv");
		expect(s.pTermSatDuty).toBeGreaterThan(0.1);
		expect(signalUnstable(s)).toBe(true);
	});

	it("flags the full runaway (P-term railed a third of the capture, error hundreds of steps)", () => {
		const s = signalOf("move250-runaway.csv");
		expect(s.pTermSatDuty).toBeGreaterThan(0.3);
		expect(s.stats.movePeak).toBeGreaterThan(100);
		expect(signalUnstable(s)).toBe(true);
	});

	it("flags the standstill limit cycle (motor buzzing while meant to hold position)", () => {
		const s = signalOf("hold-limit-cycle.csv");
		expect(s.postMoveOsc).toBeGreaterThan(10);
		expect(signalUnstable(s)).toBe(true);
	});

	it("does NOT flag the equivalent stable hold as unstable", () => {
		const s = signalOf("hold-stable-transient.csv");
		expect(signalUnstable(s)).toBe(false);
	});
});

describe("signalDiverging", () => {
	it("flags a tracking-error blowup relative to the best attempt", () => {
		const best = signalOf("move250-stable-best.csv");
		const worse = signalOf("move250-runaway.csv");
		expect(signalDiverging(best, worse)).toBe(true);
	});

	it("does not flag two similarly-good attempts", () => {
		const a = signalOf("move250-stable-early.csv");
		const b = signalOf("move250-escalation-1.csv");
		expect(signalDiverging(a, b)).toBe(false);
	});
});

describe("oscillationPeriod", () => {
	it("returns null when there aren't enough gated crossings", () => {
		const flat = new Array(50).fill(0);
		const time = flat.map((_, i) => i * 0.001);
		expect(oscillationPeriod(flat, time, 0, flat.length, 0.3)).toBeNull();
	});
	it("measures the period of a clean sine-like oscillation", () => {
		const n = 400;
		const dt = 0.001;
		const time = Array.from({ length: n }, (_, i) => i * dt);
		const period = 0.05; // seconds
		const values = time.map((t) => 5 * Math.sin((2 * Math.PI * t) / period));
		const measured = oscillationPeriod(values, time, 0, n, 0.5);
		expect(measured).not.toBeNull();
		expect(measured!).toBeGreaterThan(period * 0.8);
		expect(measured!).toBeLessThan(period * 1.2);
	});
});

describe("medianSignal", () => {
	it("returns the single signal unchanged when there's only one", () => {
		const s = signalOf("move250-stable-best.csv");
		expect(medianSignal([s])).toBe(s);
	});
	it("takes the field-wise median across repeat captures, rejecting a one-off glitch", () => {
		const good1 = signalOf("move250-stable-early.csv");
		const good2 = signalOf("move250-escalation-1.csv");
		const glitch = signalOf("move250-runaway.csv");
		const med = medianSignal([good1, glitch, good2]);
		// The median of three should sit near the two "good" readings, not the glitch.
		expect(med.stats.moveRms).toBeLessThan(glitch.stats.moveRms / 10);
		expect(signalUnstable(med)).toBe(false);
	});
});
