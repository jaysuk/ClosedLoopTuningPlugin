import { describe, expect, it } from "vitest";

import type { ParsedCapture } from "../model/csv";
import { evaluateTune, tuneStats } from "../model/evaluate";

/** Trapezoid target move with a controllable measured-vs-target error model. */
function moveCapture(opts: { cruiseLag?: number; restBias?: number; accelSpike?: number; noise?: number; overshoot?: number } = {}): ParsedCapture {
	const { cruiseLag = 0, restBias = 0, accelSpike = 0, noise = 0, overshoot = 0 } = opts;
	const n = 240;
	const vel: Array<number> = [];
	for (let i = 0; i < n; i++) {
		// accel 0..29, cruise 30..149, decel 150..179, rest 180..239
		if (i < 30) { vel.push(i / 30 * 10); }
		else if (i < 150) { vel.push(10); }
		else if (i < 180) { vel.push(Math.max(0, 10 - (i - 150) / 3)); }
		else { vel.push(0); }
	}
	const target: Array<number> = [0];
	for (let i = 1; i < n; i++) { target.push(target[i - 1] + vel[i - 1]); }
	const noiseAt = (i: number) => (noise ? noise * Math.sin(i * 1.9) : 0);
	const measured: Array<number> = target.map((t, i) => {
		const moving = vel[i] > 0.1;
		const accel = (i < 30 || (i >= 150 && i < 180));
		let err = 0;
		if (accel) { err += accelSpike * Math.sign(150 - i); }
		else if (moving) { err += -cruiseLag; }              // trail behind target
		else { err += restBias; }                            // standing offset at rest
		if (i >= 180 && i < 195) { err += overshoot; }        // overshoot just after stopping
		return t + err + noiseAt(i);
	});
	return { headers: ["Measured Motor Steps", "Target Motor Steps"], columns: { "Measured Motor Steps": measured, "Target Motor Steps": target }, rowCount: n };
}

describe("tuneStats", () => {
	it("isolates rest bias, cruise lag and accel peak by region", () => {
		const s = tuneStats(moveCapture({ cruiseLag: 1.5, restBias: 0.8, accelSpike: 4 }), 1000);
		expect(s.moved).toBe(true);
		expect(Math.abs(s.cruiseLag)).toBeGreaterThan(1);
		expect(Math.abs(s.restBias)).toBeGreaterThan(0.5);
		expect(s.accelPeak).toBeGreaterThan(2);
	});

	it("reports no movement for a flat capture", () => {
		const flat: ParsedCapture = { headers: ["Measured Motor Steps", "Target Motor Steps"], columns: { "Measured Motor Steps": [5, 5, 5, 5, 5, 5], "Target Motor Steps": [5, 5, 5, 5, 5, 5] }, rowCount: 6 };
		expect(tuneStats(flat, 1000).moved).toBe(false);
	});
});

describe("evaluateTune", () => {
	it("grades a tight tune as excellent/good with no actionable faults", () => {
		const e = evaluateTune(moveCapture({ noise: 0.05 }), 1000);
		expect(["excellent", "good"]).toContain(e.grade);
		expect(e.findings.some((f) => f.severity === "bad")).toBe(false);
		expect(e.findings.some((f) => f.severity === "warn")).toBe(false);
	});

	it("flags a standing error and tells the user to raise I", () => {
		const e = evaluateTune(moveCapture({ restBias: 1.2 }), 1000);
		const f = e.findings.find((x) => x.term === "i");
		expect(f).toBeTruthy();
		expect(f!.direction).toBe("up");
		expect(["fair", "poor"]).toContain(e.grade);
	});

	it("flags a steady-speed lag and points at V", () => {
		const e = evaluateTune(moveCapture({ cruiseLag: 2.0 }), 1000);
		expect(e.findings.some((f) => f.term === "v" && f.direction === "up")).toBe(true);
	});

	it("flags accel/decel spikes and points at A", () => {
		const e = evaluateTune(moveCapture({ accelSpike: 5 }), 1000);
		expect(e.findings.some((f) => f.term === "a" && f.direction === "up")).toBe(true);
	});

	it("flags overshoot and points at D", () => {
		const e = evaluateTune(moveCapture({ overshoot: 3 }), 1000);
		expect(e.findings.some((f) => f.term === "d")).toBe(true);
	});

	it("returns unknown when columns are missing", () => {
		const bad: ParsedCapture = { headers: ["Raw Encoder Reading"], columns: { "Raw Encoder Reading": [1, 2, 3] }, rowCount: 3 };
		expect(evaluateTune(bad, 1000).grade).toBe("unknown");
	});

	it("produces a non-empty headline and bounded score", () => {
		const e = evaluateTune(moveCapture({ cruiseLag: 1.5 }), 1000);
		expect(e.headline.length).toBeGreaterThan(0);
		expect(e.score).toBeGreaterThanOrEqual(0);
		expect(e.score).toBeLessThanOrEqual(100);
	});
});
