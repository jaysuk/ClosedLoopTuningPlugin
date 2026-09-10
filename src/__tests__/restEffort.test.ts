/**
 * computeRestEffort + dithersAtStandstill — calibrated against real field captures, not guessed
 * thresholds.
 *
 * The P-term ripple assertions below (0.00 / 3.60 / 33.60 / 512.00 P-term units) are measured values
 * from docs/PLAN-standstill-effort.md §3.3 — still reported for the log/report, and a passing
 * implementation must reproduce them exactly.
 *
 * The DITHER DECISION, though, is now the P-INDEPENDENT position-error ripple (docs/PLAN-v2.7-feedback.md
 * §2). `hold-dither-i0.csv` was captured at P≈340 (33.6 P-term ÷ 0.10 step ripple ≈ 336): its position
 * error only moves 2 encoder counts. The same-machine 2026-09-10 field feedback established that a
 * one-or-two-count flutter is encoder quantisation, not a mechanical limit cycle, and must NOT be
 * scored as one — at P=340 the old fixed P-term limit of 10 was ~0.6 counts, so any standstill motion
 * at all tripped it and a numerically better tune could score worse. So `hold-dither-i0.csv` no longer
 * counts as a dither; `hold-limit-cycle.csv` (a real railed limit cycle, 34-step ripple) still does.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	computeRestEffort, dithersAtStandstill, DITHER_MIN_STEPS, REST_TAIL_MIN_SAMPLES,
} from "../model/analysis";
import { parseCapture } from "../model/csv";

const FIXTURE_DIR = path.join(__dirname, "fixtures");
function load(name: string) {
	return parseCapture(readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

describe("computeRestEffort — calibration set (§3.3 + PLAN-v2.7 §2)", () => {
	it("hold-stable-transient.csv: normal encoder jitter, not a dither", () => {
		const re = computeRestEffort(load("hold-stable-transient.csv"), 2000);
		expect(re.restTailValid).toBe(true);
		expect(re.pTermRestRipple).toBeCloseTo(3.6, 5);
		expect(re.errorRestRipple).toBeLessThan(DITHER_MIN_STEPS);
		expect(dithersAtStandstill(re)).toBe(false);
	});

	it("hold-settled-i23.csv (user, I≈23.5 settled): not a dither", () => {
		const re = computeRestEffort(load("hold-settled-i23.csv"), 2000);
		expect(re.restTailValid).toBe(true);
		expect(re.pTermRestRipple).toBeCloseTo(0, 5);
		expect(dithersAtStandstill(re)).toBe(false);
	});

	it("hold-dither-i0.csv (P≈340, I=0): a 2-count quantisation flutter — NOT a limit cycle (PLAN-v2.7 §2)", () => {
		const re = computeRestEffort(load("hold-dither-i0.csv"), 2000);
		expect(re.restTailValid).toBe(true);
		expect(re.pTermRestRipple).toBeCloseTo(33.6, 5); // the P term still swings hard — reported, but not the decision
		expect(re.errorRestRipple).toBeCloseTo(0.10, 5); // only 2 encoder counts of actual movement
		expect(re.errorRestRipple / re.errorRestQuantum).toBeLessThanOrEqual(2);
		expect(dithersAtStandstill(re)).toBe(false);
	});

	it("hold-limit-cycle.csv (railed hunt): a real limit cycle, still a dither", () => {
		const re = computeRestEffort(load("hold-limit-cycle.csv"), 2000);
		expect(re.restTailValid).toBe(true);
		expect(re.pTermRestRipple).toBeCloseTo(512.0, 5);
		expect(re.errorRestRipple).toBeGreaterThan(DITHER_MIN_STEPS);
		expect(dithersAtStandstill(re)).toBe(true);
	});

	it("the dithering capture has SMALLER position error than the stable fixture but 9x the effort — the whole point of this metric", () => {
		const stable = computeRestEffort(load("hold-stable-transient.csv"), 2000);
		const dither = computeRestEffort(load("hold-dither-i0.csv"), 2000);
		expect(dither.pTermRestRipple).toBeGreaterThan(stable.pTermRestRipple * 5);
	});
});

describe("dithersAtStandstill — quantisation-aware threshold (PLAN-v2.7 §2)", () => {
	// A rest tail: `move` samples ramping, then `restVals` held (already quantised to `q`).
	function tail(restVals: Array<number>, q = 0.05): ReturnType<typeof computeRestEffort> {
		const rows = ["Sample,Timestamp,Measured Motor Steps,Target Motor Steps,Current Error,PID P Term"];
		for (let i = 0; i < 60; i++) { rows.push(`${i},${i * 0.5},${i},${i},0,0`); }
		restVals.forEach((e, i) => {
			const s = 60 + i;
			rows.push(`${s},${s * 0.5},${60 + e},60,${e.toFixed(4)},${(100 * e).toFixed(4)}`);
		});
		void q;
		return computeRestEffort(parseCapture(rows.join("\n")), 2000);
	}
	const rep = (v: number, n: number) => Array.from({ length: n }, () => v);
	const q = 0.05;
	// A quantised oscillation of amplitude `amp` steps at `cyclesPerN` full cycles over n samples —
	// passes through intermediate quantum levels like a real limit cycle, not a full-range square wave.
	const osc = (amp: number, n: number, cyclesPerN = 20) =>
		Array.from({ length: n }, (_, i) => Math.round(amp * Math.sin((2 * Math.PI * cyclesPerN * i) / n) / q) * q);

	it("a 1-2 encoder-count flutter at high P is NOT a dither", () => {
		const re = tail(osc(0.05, 200)); // ±1 count -> 0.10 step p2p, quantum 0.05
		expect(re.restTailValid).toBe(true);
		expect(re.errorRestQuantum).toBeCloseTo(q, 5);
		expect(dithersAtStandstill(re)).toBe(false);
	});

	it("a sustained large position limit cycle IS a dither", () => {
		const re = tail(osc(0.30, 200)); // ±0.3 step -> 0.6 step p2p, 12 quanta
		expect(dithersAtStandstill(re)).toBe(true);
	});

	it("errorRestRipple / errorRestRms / errorRestQuantum are populated, 0 when the column is absent", () => {
		const re = tail(osc(0.10, 200));
		expect(re.errorRestRipple).toBeCloseTo(0.20, 5);
		expect(re.errorRestQuantum).toBeCloseTo(q, 5);
		expect(re.errorRestRms).toBeGreaterThan(0);

		const noErr = parseCapture(
			"Sample,Timestamp,Target Motor Steps,PID P Term\n"
			+ Array.from({ length: 200 }, (_, i) => `${i},${i * 0.5},${i < 20 ? i : 20},0.1`).join("\n"),
		);
		const re2 = computeRestEffort(noErr, 2000);
		expect(re2.errorRestRipple).toBe(0);
		expect(re2.errorRestQuantum).toBe(0);
		expect(dithersAtStandstill(re2)).toBe(false); // no error column -> never a finding
	});

	it("restTailValid: false -> never a dither, however large the ripple", () => {
		const re = { ...tail(rep(0, 200)), restTailValid: false, errorRestRipple: 99, errorRestQuantum: 0.05 };
		expect(dithersAtStandstill(re)).toBe(false);
	});
});

describe("computeRestEffort — the I-convergence guard (§3.4)", () => {
	it("a capture with no PID I Term column still validates (nothing to wait for)", () => {
		const c = parseCapture(
			"Sample,Timestamp,Target Motor Steps,PID P Term\n"
			+ Array.from({ length: 200 }, (_, i) => `${i},${i * 0.5},${i < 20 ? i : 20},0.1`).join("\n"),
		);
		const re = computeRestEffort(c, 2000);
		expect(re.restTailValid).toBe(true);
	});

	it("a capture whose I term is still climbing through the tail is NOT valid — must not read a settling transient as dither", () => {
		// I ramps linearly across the WHOLE rest window and is still rising at the very last sample, so
		// the tail (the last 10% of rest, wherever it falls) always contains real I movement.
		const rows = Array.from({ length: 200 }, (_, i) => {
			const target = i < 20 ? i : 20; // moves, then holds
			const rest = Math.max(0, i - 20);
			const i_term = rest * 0.1;
			return `${i},${i * 0.5},${target},10,${i_term}`;
		});
		const c = parseCapture(`Sample,Timestamp,Target Motor Steps,PID P Term,PID I Term\n${rows.join("\n")}`);
		const re = computeRestEffort(c, 2000);
		expect(re.restTailValid).toBe(false);
	});

	it("a capture whose I term has flatlined by the tail IS valid", () => {
		const rows = Array.from({ length: 200 }, (_, i) => {
			const target = i < 20 ? i : 20;
			const rest = Math.max(0, i - 20);
			const i_term = rest < 5 ? rest * 5 : 25; // converges almost immediately after the move
			return `${i},${i * 0.5},${target},0.0,${i_term}`;
		});
		const c = parseCapture(`Sample,Timestamp,Target Motor Steps,PID P Term,PID I Term\n${rows.join("\n")}`);
		const re = computeRestEffort(c, 2000);
		expect(re.restTailValid).toBe(true);
	});

	it("a rest window shorter than REST_TAIL_MIN_SAMPLES is not valid", () => {
		const rows = Array.from({ length: 30 }, (_, i) => `${i},${i * 0.5},${i < 20 ? i : 20},0.1`);
		const c = parseCapture(`Sample,Timestamp,Target Motor Steps,PID P Term\n${rows.join("\n")}`);
		const re = computeRestEffort(c, 2000);
		expect(re.restTailSamples).toBeLessThan(REST_TAIL_MIN_SAMPLES);
		expect(re.restTailValid).toBe(false);
	});
});

describe("computeRestEffort — D and output ripple (reported, no gate)", () => {
	it("reports 0 for D/output when those columns weren't recorded", () => {
		const re = computeRestEffort(load("hold-stable-transient.csv"), 2000);
		expect(re.dTermRestRipple).toBe(0);
		expect(re.outputRestRipple).toBe(0);
	});

	it("measures real D/output ripple when the columns are present", () => {
		const re = computeRestEffort(load("hold-dither-i0.csv"), 2000);
		// The dithering capture's PID Control Signal mirrors the P term (I=D=0), so output ripple
		// should be at least as large as the P-term ripple it's derived from.
		expect(re.outputRestRipple).toBeGreaterThanOrEqual(re.pTermRestRipple - 1e-6);
	});
});

describe("computeRestEffort — never a false positive on missing/short data", () => {
	it("returns the empty/invalid shape when Target Motor Steps is missing", () => {
		const c = parseCapture("Sample,Timestamp,PID P Term\n0,0,1\n1,1,1\n");
		const re = computeRestEffort(c, 2000);
		expect(re.restTailValid).toBe(false);
		expect(re.pTermRestRipple).toBe(0);
	});

	it("returns the empty/invalid shape when PID P Term is missing", () => {
		const c = parseCapture("Sample,Timestamp,Target Motor Steps\n0,0,1\n1,1,1\n");
		const re = computeRestEffort(c, 2000);
		expect(re.restTailValid).toBe(false);
	});
});
