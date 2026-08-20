import { describe, expect, it } from "vitest";

import { ASSET_PATTERN_36, ASSET_PATTERN_37 } from "../core/assetPatterns";

// Realistic asset names off one release: the real 3.7 package, its debug sourcemap archive, and the
// 3.6 sibling — all sharing the same version number, as `dwc-plugin-verify-build`/build36.bat produce
// them. `dwc-plugin-runtime`'s checkForUpdate does `release.assets.find(a => assetPattern.test(a.name))`
// — first match wins in whatever order GitHub's API returns them — so each host's pattern must match
// EXACTLY its own package and nothing else, regardless of asset order.
const PLAIN = "ClosedLoopTuning-2.2.1.zip";
const SRCMAP = "ClosedLoopTuning-2.2.1-srcmap.zip";
const DWC36 = "ClosedLoopTuning-2.2.1-dwc36.zip";
const ALL = [PLAIN, SRCMAP, DWC36];

describe("ASSET_PATTERN_37 (3.7 host)", () => {
	it("matches only the plain package", () => {
		expect(ALL.filter((n) => ASSET_PATTERN_37.test(n))).toEqual([PLAIN]);
	});
	it("never matches the srcmap archive", () => {
		expect(ASSET_PATTERN_37.test(SRCMAP)).toBe(false);
	});
	it("never matches the dwc36 sibling", () => {
		expect(ASSET_PATTERN_37.test(DWC36)).toBe(false);
	});
	it("is order-independent — the plain package still wins first-match-wins scanning regardless of asset upload order", () => {
		for (const order of [ALL, [...ALL].reverse(), [SRCMAP, DWC36, PLAIN], [DWC36, PLAIN, SRCMAP]]) {
			expect(order.find((n) => ASSET_PATTERN_37.test(n))).toBe(PLAIN);
		}
	});
	it("matches across version numbers", () => {
		expect(ASSET_PATTERN_37.test("ClosedLoopTuning-3.0.0-rc.1.zip")).toBe(true);
	});
});

describe("ASSET_PATTERN_36 (3.6 host)", () => {
	it("matches only the dwc36 package", () => {
		expect(ALL.filter((n) => ASSET_PATTERN_36.test(n))).toEqual([DWC36]);
	});
	it("never matches the plain 3.7 package", () => {
		expect(ASSET_PATTERN_36.test(PLAIN)).toBe(false);
	});
	it("never matches the srcmap archive", () => {
		expect(ASSET_PATTERN_36.test(SRCMAP)).toBe(false);
	});
	it("is order-independent", () => {
		for (const order of [ALL, [...ALL].reverse(), [SRCMAP, PLAIN, DWC36]]) {
			expect(order.find((n) => ASSET_PATTERN_36.test(n))).toBe(DWC36);
		}
	});
});

describe("ASSET_PATTERN_37 and ASSET_PATTERN_36 together", () => {
	it("partition every real asset name with no overlap — each of PLAIN/SRCMAP/DWC36 matches exactly one host's pattern, or neither", () => {
		for (const name of ALL) {
			const hits = [ASSET_PATTERN_37.test(name), ASSET_PATTERN_36.test(name)].filter(Boolean).length;
			expect(hits).toBeLessThanOrEqual(1);
		}
		expect(ASSET_PATTERN_37.test(PLAIN)).toBe(true);
		expect(ASSET_PATTERN_36.test(DWC36)).toBe(true);
	});
});
