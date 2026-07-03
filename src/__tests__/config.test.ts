import { describe, expect, it } from "vitest";

import { renderTuneBlockBody, upsertTuneBlock, type TuneConfigBlock } from "../model/config";
import { DEFAULT_MODE_D } from "../model/m569";

function block(over: Partial<TuneConfigBlock> = {}): TuneConfigBlock {
	return {
		driver: "51.0",
		pid: { p: 150, i: 5000, d: 0.2, v: 400, a: 200000 },
		mode: "closed",
		modeD: DEFAULT_MODE_D,
		...over,
	};
}

describe("upsertTuneBlock", () => {
	it("appends a fresh block to a non-empty file, preserving existing content", () => {
		const original = "; user config\nM584 X0 Y1\nM906 X800\n";
		const result = upsertTuneBlock(original, block());
		expect(result.changed).toBe(true);
		expect(result.replaced).toBe(false);
		expect(result.text.startsWith(original.trimEnd())).toBe(true);
		expect(result.text).toContain("--- ClosedLoopTuning driver 51.0 begin ---");
		expect(result.text).toContain("--- ClosedLoopTuning driver 51.0 end ---");
		expect(result.text).toContain("M569.1 P51.0 R150 I5000 D0.2 V400 A200000");
	});

	it("writes a clean block into an empty file", () => {
		const result = upsertTuneBlock("", block());
		expect(result.changed).toBe(true);
		expect(result.text.startsWith("; --- ClosedLoopTuning driver 51.0 begin ---")).toBe(true);
	});

	it("replaces an existing block for the same driver, byte-preserving everything outside it", () => {
		const original = [
			"; before",
			"M584 X0 Y1",
			"; --- ClosedLoopTuning driver 51.0 begin ---",
			"M569 P51.0 D9      ; stale mode",
			"M569.1 P51.0 R10 I0 D0 V0 A0",
			"; --- ClosedLoopTuning driver 51.0 end ---",
			"; after",
			"M906 X800",
		].join("\n");
		const result = upsertTuneBlock(original, block());
		expect(result.changed).toBe(true);
		expect(result.replaced).toBe(true);
		expect(result.text).toContain("; before");
		expect(result.text).toContain("M584 X0 Y1");
		expect(result.text).toContain("; after");
		expect(result.text).toContain("M906 X800");
		expect(result.text).not.toContain("R10 I0 D0 V0 A0"); // stale values gone
		expect(result.text).toContain("R150 I5000 D0.2 V400 A200000"); // new values present
	});

	it("is idempotent — running it twice with the same block makes no further change", () => {
		const first = upsertTuneBlock("M584 X0 Y1\n", block());
		const second = upsertTuneBlock(first.text, block());
		expect(second.changed).toBe(false);
		expect(second.text).toBe(first.text);
	});

	it("only touches the block for the given driver, leaving another driver's block alone", () => {
		const withOther = upsertTuneBlock("", block({ driver: "50.0" }));
		const result = upsertTuneBlock(withOther.text, block({ driver: "51.0" }));
		expect(result.text).toContain("driver 50.0 begin");
		expect(result.text).toContain("driver 51.0 begin");
		expect(result.text).toContain("M569.1 P50.0");
		expect(result.text).toContain("M569.1 P51.0");
	});

	it("includes calibration moves as a reference comment, not a re-run command", () => {
		const lines = renderTuneBlockBody(block({ calibrationMoveIds: [1, 2] }));
		const calLines = lines.filter((l) => l.includes("M569.6"));
		expect(calLines.length).toBe(2);
		expect(calLines.every((l) => l.trim().startsWith(";"))).toBe(true);
	});
});
