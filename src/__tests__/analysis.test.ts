import { describe, expect, it } from "vitest";

import { analyzeStep, type CaptureSeries } from "../model/analysis";
import { parseCapture, type ParsedCapture } from "../model/csv";
import { analyzeCapture, analyzeMove } from "../model/analysis";

/** Build a synthetic step response: target steps 0→4 at index 20, measured overshoots then settles. */
function syntheticStep(overshoot: number, ssError: number): CaptureSeries {
	const n = 200;
	const time: number[] = [];
	const target: number[] = [];
	const measured: number[] = [];
	for (let i = 0; i < n; i++) {
		time.push(i * 0.001); // 1 kHz
		const t = i < 20 ? 0 : 4;
		target.push(t);
		if (i < 20) {
			measured.push(0);
		} else {
			const k = i - 20;
			// First-order rise to (4 + ssError) with a decaying overshoot bump.
			const base = (4 + ssError) * (1 - Math.exp(-k / 8));
			const bump = overshoot * Math.exp(-k / 12) * Math.sin(k / 6);
			measured.push(base + bump);
		}
	}
	return { time, measured, target };
}

describe("analyzeStep", () => {
	it("detects the step and a positive rise time + overshoot", () => {
		const m = analyzeStep(syntheticStep(1.5, 0));
		expect(m.hasStep).toBe(true);
		expect(m.stepSize).toBe(4);
		expect(m.riseTime).not.toBeNull();
		expect(m.riseTime as number).toBeGreaterThan(0);
		expect(m.overshootPct).toBeGreaterThan(0);
	});

	it("reports a near-zero steady-state error when the response settles on target", () => {
		const m = analyzeStep(syntheticStep(0.5, 0));
		expect(Math.abs(m.steadyStateError)).toBeLessThan(0.2);
	});

	it("reports a nonzero steady-state error when the response settles short", () => {
		const m = analyzeStep(syntheticStep(0.2, 0.5));
		expect(m.steadyStateError).toBeGreaterThan(0.2);
	});

	it("reports no step for a flat capture", () => {
		const flat: CaptureSeries = { time: [0, 1, 2, 3], measured: [0, 0, 0, 0], target: [0, 0, 0, 0] };
		const m = analyzeStep(flat);
		expect(m.hasStep).toBe(false);
		expect(m.riseTime).toBeNull();
	});
});

describe("analyzeCapture (from CSV)", () => {
	it("parses a CSV and analyses it", () => {
		const csv = "Sample,Measured Motor Steps,Target Motor Steps\n0,0,0\n1,0,0\n2,1,4\n3,3,4\n4,4,4\n5,4,4\n6,4,4\n";
		const m = analyzeCapture(parseCapture(csv), 1000);
		expect(m).not.toBeNull();
		expect((m as { stepSize: number }).stepSize).toBe(4);
	});

	it("returns null when the required columns are missing", () => {
		const csv = "Sample,Raw Encoder Reading\n0,1\n1,2\n";
		expect(analyzeCapture(parseCapture(csv), 1000)).toBeNull();
	});
});

describe("analyzeMove (A/V feed-forward)", () => {
	it("finds the accel P-term peak and a near-zero cruise mean from a trapezoid move", () => {
		// Trapezoid velocity: ramp up (0..9), cruise (10..24 at v=10), ramp down (25..39).
		const n = 40;
		const vel: Array<number> = [];
		for (let i = 0; i < n; i++) { vel.push(i < 10 ? i : i < 25 ? 10 : Math.max(0, 10 - (i - 24))); }
		const target: Array<number> = [0];
		for (let i = 1; i < n; i++) { target.push(target[i - 1] + vel[i - 1]); }
		// PID P term: large during accel/decel, ~0 during steady speed.
		const pterm = vel.map((v) => (v >= 10 ? 1 : 80));
		const capture: ParsedCapture = {
			headers: ["Target Motor Steps", "PID P Term"],
			columns: { "Target Motor Steps": target, "PID P Term": pterm },
			rowCount: n,
		};
		const m = analyzeMove(capture, 1000);
		expect(m).not.toBeNull();
		expect(m!.hasMove).toBe(true);
		expect(m!.pTermAccelPeak).toBeGreaterThanOrEqual(50);
		expect(Math.abs(m!.pTermCruiseMean)).toBeLessThan(20);
	});

	it("reports no move for a static capture", () => {
		const capture: ParsedCapture = {
			headers: ["Target Motor Steps", "PID P Term"],
			columns: { "Target Motor Steps": [0, 0, 0, 0, 0, 0, 0, 0], "PID P Term": [1, 1, 1, 1, 1, 1, 1, 1] },
			rowCount: 8,
		};
		expect(analyzeMove(capture, 1000)!.hasMove).toBe(false);
	});
});
