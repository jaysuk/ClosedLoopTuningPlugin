import { describe, expect, it } from "vitest";

import {
	buildCalibrationCommand, buildCaptureCommand, buildModeCommand, buildPidCommand,
	CAPTURE_VARIABLES, captureBitmask, DEFAULT_MODE_D, parseCalibrationReply, parsePidReply,
} from "../model/m569";

describe("mode commands", () => {
	it("uses D4 closed / D5 assisted / D2 open by default, with no S (direction) param", () => {
		expect(buildModeCommand("50.0", "closed")).toBe("M569 P50.0 D4");
		expect(buildModeCommand("50.0", "assisted")).toBe("M569 P50.0 D5");
		expect(buildModeCommand("50.0", "open")).toBe("M569 P50.0 D2");
	});
	it("honours overridden D-values", () => {
		expect(buildModeCommand("50.0", "open", { ...DEFAULT_MODE_D, open: 0 })).toBe("M569 P50.0 D0");
	});
});

describe("capture command", () => {
	it("sums the variable bitmask", () => {
		expect(captureBitmask([2, 4, 8])).toBe(14);
		expect(captureBitmask([2048, 4096])).toBe(6144);
	});
	it("id:0 (a derived variable, e.g. combined current) is always a no-op in the bitmask, even if a caller forgets to filter it out", () => {
		expect(captureBitmask([2, 4, 0])).toBe(6);
	});
	it("builds a step manoeuvre capture", () => {
		const cmd = buildCaptureCommand({ driver: "50.0", samples: 500, activate: 0, rate: 0, variables: [2, 4], manoeuvre: 64 });
		expect(cmd).toBe("M569.5 P50.0 S500 A0 R0 D6 V64");
	});
	it("appends a move on the same line for A1 custom captures", () => {
		const cmd = buildCaptureCommand({ driver: "50.0", samples: 2000, activate: 1, rate: 0, variables: [2, 4, 8], manoeuvre: 0, move: "G91 G1 H2 X50 F6000 G90" });
		expect(cmd).toBe("M569.5 P50.0 S2000 A1 R0 D14 V0 G91 G1 H2 X50 F6000 G90");
	});
	it("places an `alongside` command (e.g. arming an accelerometer) after V0 and before the move — confirmed working as one line on real hardware (docs/PLAN-accelerometer.md §12.1)", () => {
		const cmd = buildCaptureCommand({
			driver: "124.0", samples: 2000, activate: 1, rate: 1000, variables: [2, 4, 8, 32], manoeuvre: 0,
			alongside: 'M956 P121.0 S1000 A0 F"t.csv"', move: "G91 G1 H2 X20 F6000 G90",
		});
		expect(cmd).toBe('M569.5 P124.0 S2000 A1 R1000 D46 V0 M956 P121.0 S1000 A0 F"t.csv" G91 G1 H2 X20 F6000 G90');
	});
	it("is byte-for-byte unchanged when `alongside` is omitted — the existing capture path must never regress", () => {
		const withoutAlongside = { driver: "50.0", samples: 2000, activate: 1 as const, rate: 0, variables: [2, 4, 8], manoeuvre: 0, move: "G91 G1 H2 X50 F6000 G90" };
		expect(buildCaptureCommand(withoutAlongside)).toBe("M569.5 P50.0 S2000 A1 R0 D14 V0 G91 G1 H2 X50 F6000 G90");
	});
});

describe("calibration command", () => {
	it("builds M569.6 with the manoeuvre id", () => {
		expect(buildCalibrationCommand("50.0", 1)).toBe("M569.6 P50.0 V1");
		expect(buildCalibrationCommand("51.0", 2)).toBe("M569.6 P51.0 V2");
	});
});

describe("parseCalibrationReply", () => {
	it("treats an Error: reply as a failure", () => {
		const r = parseCalibrationReply("Error: driver 50.0 does not support closed loop calibration");
		expect(r.ok).toBe(false);
		expect(r.residual).toBeNull();
	});
	it("treats an empty reply as a failure (no ground truth about what happened)", () => {
		expect(parseCalibrationReply("").ok).toBe(false);
		expect(parseCalibrationReply("   ").ok).toBe(false);
	});
	it("treats any non-error reply as a success", () => {
		const r = parseCalibrationReply("Calibration complete");
		expect(r.ok).toBe(true);
		expect(r.residual).toBeNull();
		expect(r.message).toBe("Calibration complete");
	});
	it("extracts a residual error figure when the reply reports one (V3 check)", () => {
		const r = parseCalibrationReply("Calibration check: residual error 0.42");
		expect(r.ok).toBe(true);
		expect(r.residual).toBe(0.42);
	});
});

describe("PID command + parse", () => {
	it("builds M569.1 with R/I/D/V/A and optional thresholds", () => {
		expect(buildPidCommand("50.0", { p: 150, i: 5000, d: 0.2, v: 400, a: 200000, warn: null, err: null }))
			.toBe("M569.1 P50.0 R150 I5000 D0.2 V400 A200000");
		expect(buildPidCommand("50.0", { p: 100, i: 0, d: 0, v: 0, a: 0, warn: 1, err: 2 }))
			.toBe("M569.1 P50.0 R100 I0 D0 V0 A0 E1:2");
	});
	it("parses a query reply", () => {
		const reply = "Closed loop driver 50.0: P=150 I=5000 D=0.2 V=400 A=200000, Warning/error threshold 1.00/2.00";
		const p = parsePidReply(reply);
		expect(p).toEqual({ p: 150, i: 5000, d: 0.2, v: 400, a: 200000, warn: 1, err: 2 });
	});
});

describe("CAPTURE_VARIABLES — derived entries (docs/PLAN-v2.4-feedback.md item I)", () => {
	it("flags the combined-current entry as derived, with a safe no-op firmware id", () => {
		const combined = CAPTURE_VARIABLES.find((v) => v.key === "motorCurrentCombined");
		expect(combined).toBeTruthy();
		expect(combined!.derived).toBe(true);
		expect(combined!.id).toBe(0);
	});
	it("every OTHER entry is a real, non-derived firmware variable", () => {
		const real = CAPTURE_VARIABLES.filter((v) => v.key !== "motorCurrentCombined");
		expect(real.every((v) => !v.derived)).toBe(true);
		expect(real.every((v) => v.id > 0)).toBe(true);
	});
});
