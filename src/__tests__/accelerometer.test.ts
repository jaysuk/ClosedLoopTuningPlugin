import { describe, expect, it } from "vitest";

import {
	ACCEL_ASSUMED_RATE_HZ, accelSampleCount, buildAccelCaptureCommand, findAccelerometers, isAccelOnlyError,
} from "../model/accelerometer";

describe("findAccelerometers", () => {
	it("finds only boards that advertise an accelerometer, with the right fields", () => {
		const model = {
			boards: [
				{ canAddress: 0, accelerometer: { orientation: 12, runs: 3, points: 2000 } },
				{ canAddress: 121, drivers: [] }, // no accelerometer
			],
		};
		const found = findAccelerometers(model);
		expect(found).toHaveLength(1);
		expect(found[0]).toEqual({ boardAddress: 0, runs: 3, points: 2000 });
	});

	// DWC's own object model leaves canAddress null on the main board (@duet3d/objectmodel Board), and
	// DWC's InputShaping treats that as board 0 — so must this, or a main-board accelerometer is missed.
	it("treats a null canAddress as board 0, the way DWC's own accelerometer code does", () => {
		const model = { boards: [{ canAddress: null, accelerometer: { runs: 0, points: 0 } }] };
		expect(findAccelerometers(model)[0].boardAddress).toBe(0);
	});

	it("returns an empty array (never throws) when boards are missing or empty", () => {
		expect(findAccelerometers({})).toEqual([]);
		expect(findAccelerometers({ boards: [] })).toEqual([]);
		expect(findAccelerometers(null)).toEqual([]);
		expect(findAccelerometers(undefined)).toEqual([]);
	});
});

describe("buildAccelCaptureCommand", () => {
	it("builds the minimal command with no axes/filename", () => {
		expect(buildAccelCaptureCommand({ device: "121.0", samples: 1000, activate: 0 })).toBe("M956 P121.0 S1000 A0");
	});

	it("appends axis flags and a quoted filename when given", () => {
		expect(buildAccelCaptureCommand({ device: "121.0", samples: 1000, activate: 0, axes: ["X", "Z"], filename: "t.csv" }))
			.toBe('M956 P121.0 S1000 A0 X Z F"t.csv"');
	});

	it("supports activate:1 (on next move)", () => {
		expect(buildAccelCaptureCommand({ device: "0.0", samples: 500, activate: 1 })).toBe("M956 P0.0 S500 A1");
	});

	// docs/PLAN-rc1-accelerometer-addressing.md: RRF 3.7.0-rc.1 changed M956's P from a DriverId (which
	// also routed the command over CAN) to a small accelerometer index that carries no routing meaning at
	// all (must be 0 — only one accelerometer is supported today). Sending the old DriverId-shaped P on
	// rc.1+ fails once RRF's integer parser truncates it at the decimal point and the range check rejects
	// the result ("parameter 'P' too high").
	it("sends P0, not the DriverId, when useAccelNumberAddressing is set", () => {
		expect(buildAccelCaptureCommand({ device: "121.0", useAccelNumberAddressing: true, samples: 1000, activate: 0 }))
			.toBe("M956 P0 S1000 A0");
	});

	it("still sends the DriverId when useAccelNumberAddressing is explicitly false", () => {
		expect(buildAccelCaptureCommand({ device: "121.0", useAccelNumberAddressing: false, samples: 1000, activate: 0 }))
			.toBe("M956 P121.0 S1000 A0");
	});

	it("defaults to the DriverId when useAccelNumberAddressing is omitted (pre-rc.1 behaviour unchanged)", () => {
		expect(buildAccelCaptureCommand({ device: "121.0", samples: 1000, activate: 0 })).toBe("M956 P121.0 S1000 A0");
	});
});

describe("accelSampleCount", () => {
	// The failure this exists to prevent: too FEW samples ends the accelerometer capture before the move
	// does, and vibration.ts then reports an empty rest region as 0 g — a still machine, not missing data.
	// So every case here checks the window is covered, never merely close.
	function coversWindow(clSamples: number, clRateHz: number, realRateHz: number, assumedRateHz: number) {
		const n = accelSampleCount(clSamples, clRateHz, assumedRateHz);
		return (n / realRateHz) >= (clSamples / clRateHz);
	}

	it("covers the closed-loop window with margin when the assumed rate is right", () => {
		// 2000 samples at 1000 Hz = 2.0 s; at 800 Hz that needs 1600 samples, plus the 1.2 margin.
		expect(accelSampleCount(2000, 1000, 800)).toBe(1920);
		expect(coversWindow(2000, 1000, 800, 800)).toBe(true);
	});

	// ACCEL_ASSUMED_RATE_HZ is used only when useClosedLoopTuning.ts's ensureAccelRateKnown probe couldn't
	// measure the real rate first — a rare fallback, not the normal path. Real captures are sized from the
	// MEASURED rate (accelSampleCount(clSamples, clRateHz, realRateHz)), which always covers the window
	// exactly regardless of what the real rate turns out to be; these two tests exist only to document the
	// fallback's asymmetric tradeoff for the one-off case where that measurement itself failed.
	it("undercovers the window when the real rate is HIGHER than the fallback guess — an accepted tradeoff", () => {
		// A guess this low against a fast ADXL345 (1600 Hz) collects for less than half the window. Left
		// this way on purpose (see ACCEL_ASSUMED_RATE_HZ's doc comment): vibration.ts's `coverage` and
		// `RegionVibration.samples` already report the shortfall honestly as missing data, never as a false
		// "0 g" reading — a well-handled failure, unlike the alternative this used to be (see below).
		expect(coversWindow(2000, 1000, 1600, ACCEL_ASSUMED_RATE_HZ)).toBe(false);
	});

	it("covers the window when the real rate is at or below the fallback guess", () => {
		expect(coversWindow(2000, 1000, 800, ACCEL_ASSUMED_RATE_HZ)).toBe(true); // the testbench's rate
		expect(coversWindow(2000, 1000, 400, ACCEL_ASSUMED_RATE_HZ)).toBe(true); // a slower real rate
	});

	it("rounds up rather than down — a rounded-down count truncates the end of the move", () => {
		expect(accelSampleCount(10, 1000, 801)).toBe(Math.ceil(10 * (801 / 1000) * 1.2));
	});

	it("never returns a nonsense count for nonsense input", () => {
		expect(accelSampleCount(0, 1000, 800)).toBe(1);
		expect(accelSampleCount(2000, 0, 800)).toBe(1);
		expect(accelSampleCount(2000, 1000, 0)).toBe(1);
	});
});

describe("isAccelOnlyError", () => {
	// Real hardware, verbatim: a busy accelerometer's M956 fails on a shared line, and — before this
	// function existed — useClosedLoopTuning.ts treated that as the WHOLE tuning capture failing, abandoning
	// the M569.5 capture that (per RRF's own per-command line processing) almost certainly still ran. The
	// retry then collided with that uncollected capture ("M569.5: Closed loop data is already being
	// collected"), cascading into a failed preflight. This is the exact reply that must be recognised as
	// accelerometer-only so the tuning capture is no longer thrown away underneath it.
	it("recognises the real busy-accelerometer reply as accel-only", () => {
		expect(isAccelOnlyError("Error: M956: Accelerometer 123.0 is busy collecting data")).toBe(true);
	});

	it("recognises the RRF source's exact wording too", () => {
		expect(isAccelOnlyError("Error: M956: Accelerometer is already collecting data")).toBe(true);
	});

	it("is NOT accel-only when the closed-loop command itself is what failed", () => {
		expect(isAccelOnlyError("Error: M569.5: Closed loop data is already being collected")).toBe(false);
	});

	it("is NOT accel-only when there is no M956 in the reply at all", () => {
		expect(isAccelOnlyError("Error: Driver not found")).toBe(false);
		expect(isAccelOnlyError("")).toBe(false);
	});

	it("is NOT accel-only when BOTH the accelerometer and the closed-loop command failed", () => {
		expect(isAccelOnlyError("Error: M569.5: Closed loop data is already being collected\nError: M956: Accelerometer is already collecting data")).toBe(false);
	});

	it("is accel-only across multiple M956 lines (e.g. a warning plus an error)", () => {
		expect(isAccelOnlyError("Warning: M956: something minor\nError: M956: Accelerometer is already collecting data")).toBe(true);
	});
});
