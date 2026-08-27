/**
 * computeRestEffort — calibrated against real field captures, not guessed thresholds.
 *
 * hold-settled-i23.csv / hold-dither-i0.csv are the two captures a user supplied while reporting that
 * auto-tune's I strategy accepts a driver that is audibly dithering at standstill: with I=0 the motor
 * repeatedly moves by one encoder count (P term toggling ±16.8), which restBias/restRing (evaluate.ts)
 * cannot see — a limit cycle centred on zero has ~zero mean error and never clears restRing's 0.3-step
 * amplitude gate. Once I is raised enough to actually hold the static load, the dither stops.
 *
 * The four assertions below (0.00 / 3.60 / 33.60 / 512.00) are measured values from
 * docs/PLAN-standstill-effort.md §3.3, not illustrations — a passing implementation must reproduce
 * them exactly, and any future change to the tail-window logic must be re-verified against them.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { computeRestEffort, REST_TAIL_MIN_SAMPLES } from "../model/analysis";
import { parseCapture } from "../model/csv";

const FIXTURE_DIR = path.join(__dirname, "fixtures");
function load(name: string) {
	return parseCapture(readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

describe("computeRestEffort — calibration set (§3.3)", () => {
	it("hold-stable-transient.csv: normal encoder jitter, must NOT trip a limit of 10", () => {
		const re = computeRestEffort(load("hold-stable-transient.csv"), 2000);
		expect(re.restTailValid).toBe(true);
		expect(re.pTermRestRipple).toBeCloseTo(3.6, 5);
	});

	it("hold-settled-i23.csv (user, I≈23.5 settled): must NOT trip", () => {
		const re = computeRestEffort(load("hold-settled-i23.csv"), 2000);
		expect(re.restTailValid).toBe(true);
		expect(re.pTermRestRipple).toBeCloseTo(0, 5);
	});

	it("hold-dither-i0.csv (user, I=0 dithering): MUST trip a limit of 10", () => {
		const re = computeRestEffort(load("hold-dither-i0.csv"), 2000);
		expect(re.restTailValid).toBe(true);
		expect(re.pTermRestRipple).toBeCloseTo(33.6, 5);
	});

	it("hold-limit-cycle.csv (railed hunt, already caught by postMoveOsc): far above any reasonable limit", () => {
		const re = computeRestEffort(load("hold-limit-cycle.csv"), 2000);
		expect(re.restTailValid).toBe(true);
		expect(re.pTermRestRipple).toBeCloseTo(512.0, 5);
	});

	it("the dithering capture has SMALLER position error than the stable fixture but 9x the effort — the whole point of this metric", () => {
		const stable = computeRestEffort(load("hold-stable-transient.csv"), 2000);
		const dither = computeRestEffort(load("hold-dither-i0.csv"), 2000);
		expect(dither.pTermRestRipple).toBeGreaterThan(stable.pTermRestRipple * 5);
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
