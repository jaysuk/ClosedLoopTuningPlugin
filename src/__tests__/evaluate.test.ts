import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseCapture, type ParsedCapture } from "../model/csv";
import { evaluateTune, tuneStats } from "../model/evaluate";

const FIXTURE_DIR = path.join(__dirname, "fixtures");
function loadCapture(name: string): ParsedCapture {
	return parseCapture(readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

/** Trapezoid target move with a controllable measured-vs-target error model. */
function moveCapture(opts: {
	cruiseLag?: number; restBias?: number; accelSpike?: number; noise?: number; overshoot?: number; cruiseWander?: number;
	/** Fast alternating-sign error at rest / during cruise — real oscillation cycles for `restRing`/`cruiseRing`
	 * (unlike `cruiseWander`'s one slow symmetric swing, which is a mean-preserving spread, not a ring count). */
	restRingAmplitude?: number; cruiseRingAmplitude?: number;
} = {}): ParsedCapture {
	const {
		cruiseLag = 0, restBias = 0, accelSpike = 0, noise = 0, overshoot = 0, cruiseWander = 0,
		restRingAmplitude = 0, cruiseRingAmplitude = 0,
	} = opts;
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
	// A slow, roughly-symmetric swing across the whole cruise window (30..149) — one full cycle, so it
	// averages toward zero (mean-based cruiseLag stays small) while still having real spread.
	const wanderAt = (i: number) => (cruiseWander ? cruiseWander * Math.sin(((i - 30) / 120) * 2 * Math.PI) : 0);
	// A short constant-amplitude burst (not a decay, not a full-window square wave) at the START of a
	// region, then flat for the rest of it. `ringCount`'s gate is 3× the WHOLE region's own std, which is
	// self-referential: a square wave filling the entire region can never clear 3× its own std (std ==
	// amplitude for a symmetric square wave), and a slowly-decaying ring's later, smaller half-cycles drag
	// the count back down to ~1. A brief burst against an otherwise-flat region is the shape that actually
	// clears the gate multiple times — calibrated (BURST_LEN=6) against both region lengths below.
	const BURST_LEN = 6;
	const measured: Array<number> = target.map((t, i) => {
		const moving = vel[i] > 0.1;
		const accel = (i < 30 || (i >= 150 && i < 180));
		let err = 0;
		const ringAt = (amp: number, regionStart: number) => (amp && i >= regionStart && i - regionStart < BURST_LEN ? amp * (i % 2 === 0 ? 1 : -1) : 0);
		if (accel) { err += accelSpike * Math.sign(150 - i); }
		// Burst starts at i=40, not the nominal cruise start (i=30) — segmentMove's own accel/cruise
		// boundary lands a couple of samples later than this file's `moving`/`accel` booleans (verified:
		// it classifies up to i=31 as "accel"), and a burst that starts before the REAL boundary loses its
		// first samples to accelErr instead of cruiseErr, undercounting cruiseRing. Margin, not exactness.
		else if (moving) { err += -cruiseLag + wanderAt(i) + ringAt(cruiseRingAmplitude, 40); }  // trail behind target, optionally wandering/ringing
		else { err += restBias + ringAt(restRingAmplitude, 180); }  // standing offset at rest, optionally ringing
		if (i >= 180 && i < 195) { err += overshoot; }        // overshoot just after stopping
		return t + err + noiseAt(i);
	});
	return { headers: ["Measured Motor Steps", "Target Motor Steps"], columns: { "Measured Motor Steps": measured, "Target Motor Steps": target }, rowCount: n, notes: [], truncated: false };
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
		const flat: ParsedCapture = { headers: ["Measured Motor Steps", "Target Motor Steps"], columns: { "Measured Motor Steps": [5, 5, 5, 5, 5, 5], "Target Motor Steps": [5, 5, 5, 5, 5, 5] }, rowCount: 6, notes: [], truncated: false };
		expect(tuneStats(flat, 1000).moved).toBe(false);
	});

	it("regression: a symmetric cruise wander averages toward zero in cruiseLag but shows up in cruiseSpread", () => {
		// This is the exact gap a real field capture exposed: the graph visibly wandered ±0.3-0.4 step
		// during cruise, yet the mean-based lag check alone reported it as clean tracking.
		const s = tuneStats(moveCapture({ cruiseWander: 0.35 }), 1000);
		expect(Math.abs(s.cruiseLag)).toBeLessThan(0.1); // the swing cancels out in the mean
		expect(s.cruiseSpread).toBeGreaterThan(0.15);    // but the spread is real and measurable
	});

	it("reports near-zero cruiseSpread for a clean, steady cruise", () => {
		const s = tuneStats(moveCapture({ noise: 0.02 }), 1000);
		expect(s.cruiseSpread).toBeLessThan(0.1);
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

	it("regression: flags a symmetric cruise wander (points at V) even though it scores fine on mean lag alone", () => {
		// Reproduces the field capture that graded 100/100 "Excellent" despite a visible ±0.3-0.4 step
		// wander: a wander with near-zero mean should still be caught as its own finding.
		const wandering = moveCapture({ cruiseWander: 0.4, noise: 0.02 });
		const lagOnlyFinding = evaluateTune(moveCapture({ cruiseLag: 0.05, noise: 0.02 }), 1000);
		const e = evaluateTune(wandering, 1000);
		// The mean-lag check alone would call this "Tracks at speed" (as it does for a genuinely clean
		// capture) — the point is the WANDER finding catches what that check misses.
		expect(lagOnlyFinding.findings.some((f) => f.title === "Tracks at speed")).toBe(true);
		expect(e.findings.some((f) => f.title === "Cruise error wanders" || f.title === "Slight cruise wander")).toBe(true);
		expect(e.findings.some((f) => f.term === "v" && f.direction === "up" && f.title.toLowerCase().includes("wander"))).toBe(true);
	});

	it("does not flag cruise wander on a clean, steady-speed capture", () => {
		const e = evaluateTune(moveCapture({ noise: 0.02 }), 1000);
		expect(e.findings.some((f) => f.title.toLowerCase().includes("wander"))).toBe(false);
		expect(e.findings.some((f) => f.title === "Steady at speed")).toBe(true);
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
		const bad: ParsedCapture = { headers: ["Raw Encoder Reading"], columns: { "Raw Encoder Reading": [1, 2, 3] }, rowCount: 3, notes: [], truncated: false };
		expect(evaluateTune(bad, 1000).grade).toBe("unknown");
	});

	it("produces a non-empty headline and bounded score", () => {
		const e = evaluateTune(moveCapture({ cruiseLag: 1.5 }), 1000);
		expect(e.headline.length).toBeGreaterThan(0);
		expect(e.score).toBeGreaterThanOrEqual(0);
		expect(e.score).toBeLessThanOrEqual(100);
	});

	// The panel previously graded a dithering capture "Reaches target — no standing offset", good
	// severity, on restBias alone. The check flags a real position-error limit cycle instead — but NOT
	// a 1-2 encoder-count quantisation flutter, which at high P swings the P term hard without the axis
	// meaningfully moving (docs/PLAN-v2.7-feedback.md §2; the 2026-09-10 field feedback where a
	// numerically better tune scored worse purely because its final capture caught a 2-count flutter).
	describe("standstill dither (real + realistic field captures)", () => {
		it("flags a real sub-rail limit cycle instead of calling it good, and does NOT also emit 'Reaches target'", () => {
			const e = evaluateTune(loadCapture("hold-limit-cycle-soft.csv"), 2000);
			const dither = e.findings.find((f) => f.title === "Dithers at standstill");
			expect(dither).toBeTruthy();
			expect(dither!.severity).toBe("warn");
			expect(dither!.term).toBe("i");
			expect(dither!.direction).toBe("up");
			expect(e.findings.some((f) => f.title === "Reaches target")).toBe(false);
			expect(e.grade).not.toBe("excellent");
		});

		it("does NOT flag a 2-count quantisation flutter at high P (the scoring-inversion regression)", () => {
			const e = evaluateTune(loadCapture("hold-dither-i0.csv"), 2000);
			expect(e.findings.some((f) => f.title === "Dithers at standstill")).toBe(false);
			expect(e.findings.some((f) => f.title === "Reaches target")).toBe(true);
		});

		it("does not flag the equivalent settled capture, and still emits 'Reaches target'", () => {
			const e = evaluateTune(loadCapture("hold-settled-i23.csv"), 2000);
			expect(e.findings.some((f) => f.title === "Dithers at standstill")).toBe(false);
			expect(e.findings.some((f) => f.title === "Reaches target")).toBe(true);
		});

		it("does not flag ordinary encoder jitter (the stable fixture) as dithering", () => {
			const e = evaluateTune(loadCapture("hold-stable-transient.csv"), 2000);
			expect(e.findings.some((f) => f.title === "Dithers at standstill")).toBe(false);
		});
	});
});

// docs/PLAN-capture-integrity.md §3 — a real forum report: restNoise measured over the whole rest window
// reached 4.08 steps on a 1000 PPR encoder (~0.05 step/count) and was still described as "normal for the
// encoder resolution", because it was actually the settling transient/ringing being averaged in.
describe("tuneStats — restNoise measures the settled tail, not the settling transient", () => {
	// restRingAmplitude's burst occupies only the first BURST_LEN=6 samples of the rest region, then the
	// rest of it is flat (no noise/bias) — exactly the "rings then quiet" shape this fix is about.
	it("measures the noise floor from the settled tail, not the settling transient", () => {
		const s = tuneStats(moveCapture({ restRingAmplitude: 1.0 }), 1000);
		// The tail is well past the 6-sample burst — genuinely flat/no-noise by this fixture's construction.
		expect(s.restNoise).toBe(0);
	});

	it("still counts ringing — the ring gate is not softened by the lower floor", () => {
		const s = tuneStats(moveCapture({ restRingAmplitude: 1.0 }), 1000);
		expect(s.restRing).toBeGreaterThan(0);
	});

	it("falls back to the whole window when the rest tail is too short to judge", () => {
		// A rest region shorter than REST_TAIL_MIN_SAMPLES (25): restNoise must not silently become 0
		// (which would make every noise-scaled gate, e.g. cruise-spread, fire on nothing).
		const header = "Sample,Timestamp,Measured Motor Steps,Target Motor Steps,PID P Term\n";
		const moveRows = Array.from({ length: 40 }, (_, i) => `${i},${i},${i * 0.1},${i * 0.1},0`);
		const restRows = Array.from({ length: 10 }, (_, i) => {
			const t = 4.0;
			const e = i % 2 === 0 ? 0.2 : -0.2; // real, nonzero rest noise
			return `${40 + i},${40 + i},${(t + e).toFixed(3)},${t},0`;
		});
		const capture = parseCapture(header + [...moveRows, ...restRows].join("\n") + "\n");
		const stats = tuneStats(capture, 1000);
		expect(stats.restSamples).toBeGreaterThan(0);
		expect(stats.restSamples).toBeLessThan(25); // below REST_TAIL_MIN_SAMPLES — triggers the fallback
		expect(stats.restNoise).toBeGreaterThan(0);
	});
});

describe("cruise-phase ripple context (report-only, docs/PLAN-v2.4-feedback.md §2.3)", () => {
	it("computes cruiseRing alongside restRing", () => {
		const s = tuneStats(moveCapture({ restRingAmplitude: 1.0, cruiseRingAmplitude: 1.0 }), 1000);
		expect(s.restRing).toBeGreaterThan(0);
		expect(s.cruiseRing).toBeGreaterThan(0);
	});

	it("flags ringing at rest exactly as before when there is no matching cruise-phase ripple", () => {
		const e = evaluateTune(moveCapture({ restRingAmplitude: 1.0 }), 1000);
		const f = e.findings.find((x) => x.title === "Rings after stopping");
		expect(f).toBeTruthy();
		expect(f!.severity).toBe("warn");
		expect(f!.term).toBe("p");
		expect(f!.direction).toBe("down");
		expect(f!.detail).not.toMatch(/mechanical/i);
	});

	it("appends mechanical-source context to the SAME finding when ripple also shows up while cruising — never a new finding, never a different severity/fix", () => {
		const ringingAtRestOnly = evaluateTune(moveCapture({ restRingAmplitude: 1.0 }), 1000);
		const ringingBoth = evaluateTune(moveCapture({ restRingAmplitude: 1.0, cruiseRingAmplitude: 1.0 }), 1000);
		const restOnlyFinding = ringingAtRestOnly.findings.find((x) => x.title === "Rings after stopping")!;
		const bothFinding = ringingBoth.findings.find((x) => x.title === "Rings after stopping")!;
		expect(bothFinding).toBeTruthy();
		expect(bothFinding.severity).toBe(restOnlyFinding.severity);
		expect(bothFinding.term).toBe(restOnlyFinding.term);
		expect(bothFinding.direction).toBe(restOnlyFinding.direction);
		expect(bothFinding.detail).toMatch(/mechanical/i);
		expect(ringingBoth.findings.filter((x) => x.title === "Rings after stopping")).toHaveLength(1);
	});

	// docs/PLAN-capture-integrity.md §3: this fixture's cruiseRingAmplitude burst (real amplitude-1.0
	// oscillation on 6 of 120 cruise samples) also legitimately clears the cruise-wander gate on its own —
	// unrelated to the "Rings after stopping" text/severity/term/direction checks above, all of which
	// still hold unchanged (confirmed there). Before §3's fix this was masked: restNoise was measured over
	// the WHOLE rest window, which the restRingAmplitude burst inflated, so the (noise-scaled, floorless)
	// cruise-wander gate never tripped. That inflated floor hiding a real cruise oscillation is exactly the
	// bug §3 fixes — so the score dropping here (a new "Cruise error wanders" finding, unrelated to the
	// ring-context text) is the fix working, not a regression. Confirmed even with a small (0.05) realistic
	// noise floor added — this isn't a synthetic zero-noise artifact, the injected burst is genuinely big
	// enough to be real cruise wander.
	it("a real cruise-phase oscillation is now flagged in its own right, not masked by an inflated rest-noise floor", () => {
		const ringingAtRestOnly = evaluateTune(moveCapture({ restRingAmplitude: 1.0 }), 1000);
		const ringingBoth = evaluateTune(moveCapture({ restRingAmplitude: 1.0, cruiseRingAmplitude: 1.0 }), 1000);
		expect(ringingBoth.findings.some((f) => f.title === "Cruise error wanders")).toBe(true);
		expect(ringingAtRestOnly.findings.some((f) => f.title === "Cruise error wanders")).toBe(false);
		expect(ringingBoth.score).toBeLessThan(ringingAtRestOnly.score);
	});
});
