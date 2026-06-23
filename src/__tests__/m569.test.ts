import { describe, expect, it } from "vitest";

import {
	buildCalibrationCommand, buildCaptureCommand, buildModeCommand, buildPidCommand,
	captureBitmask, DEFAULT_MODE_D, parsePidReply,
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
	it("builds a step manoeuvre capture", () => {
		const cmd = buildCaptureCommand({ driver: "50.0", samples: 500, activate: 0, rate: 0, variables: [2, 4], manoeuvre: 64 });
		expect(cmd).toBe("M569.5 P50.0 S500 A0 R0 D6 V64");
	});
	it("appends a move on the same line for A1 custom captures", () => {
		const cmd = buildCaptureCommand({ driver: "50.0", samples: 2000, activate: 1, rate: 0, variables: [2, 4, 8], manoeuvre: 0, move: "G91 G1 H2 X50 F6000 G90" });
		expect(cmd).toBe("M569.5 P50.0 S2000 A1 R0 D14 V0 G91 G1 H2 X50 F6000 G90");
	});
});

describe("calibration command", () => {
	it("builds M569.6 with the manoeuvre id", () => {
		expect(buildCalibrationCommand("50.0", 1)).toBe("M569.6 P50.0 V1");
		expect(buildCalibrationCommand("51.0", 2)).toBe("M569.6 P51.0 V2");
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
