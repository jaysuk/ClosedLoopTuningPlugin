import { describe, expect, it } from "vitest";

import { isMachineUnsafeForTuning } from "../core/host";

describe("isMachineUnsafeForTuning", () => {
	it("is unsafe when the machine is halted (emergency stop)", () => {
		expect(isMachineUnsafeForTuning("halted")).toBe(true);
	});
	it("is unsafe when the connection to the board is lost", () => {
		expect(isMachineUnsafeForTuning("disconnected")).toBe(true);
	});
	it("is unsafe during a firmware update", () => {
		expect(isMachineUnsafeForTuning("updating")).toBe(true);
	});
	it("is safe for ordinary operating statuses", () => {
		expect(isMachineUnsafeForTuning("idle")).toBe(false);
		expect(isMachineUnsafeForTuning("processing")).toBe(false);
		expect(isMachineUnsafeForTuning("busy")).toBe(false);
	});
	it("is safe when the status isn't a recognised string (e.g. object model not loaded yet)", () => {
		expect(isMachineUnsafeForTuning(null)).toBe(false);
		expect(isMachineUnsafeForTuning(undefined)).toBe(false);
		expect(isMachineUnsafeForTuning(42)).toBe(false);
		expect(isMachineUnsafeForTuning("")).toBe(false);
	});
});
