import { describe, expect, it } from "vitest";

import { compareFirmwareVersions, firmwareAtLeast, parseFirmwareVersion } from "../model/firmwareVersion";

describe("parseFirmwareVersion", () => {
	it("parses a plain release", () => {
		expect(parseFirmwareVersion("3.7.0")).toEqual({ major: 3, minor: 7, patch: 0, prerelease: [] });
	});

	it("parses a prerelease with a single identifier", () => {
		expect(parseFirmwareVersion("3.7.0-rc.1")).toEqual({ major: 3, minor: 7, patch: 0, prerelease: ["rc", "1"] });
	});

	it("parses and discards build metadata", () => {
		expect(parseFirmwareVersion("3.7.0-beta.3+1")).toEqual({ major: 3, minor: 7, patch: 0, prerelease: ["beta", "3"] });
		expect(parseFirmwareVersion("3.7.0+2")).toEqual({ major: 3, minor: 7, patch: 0, prerelease: [] });
	});

	it("tolerates surrounding whitespace", () => {
		expect(parseFirmwareVersion("  3.6.0  ")).toEqual({ major: 3, minor: 6, patch: 0, prerelease: [] });
	});

	it("returns null for anything that isn't major.minor.patch", () => {
		expect(parseFirmwareVersion("3.7")).toBeNull();
		expect(parseFirmwareVersion("not a version")).toBeNull();
		expect(parseFirmwareVersion("")).toBeNull();
	});
});

describe("compareFirmwareVersions", () => {
	const v = (s: string) => parseFirmwareVersion(s)!;

	it("compares the release triplet numerically, not lexically", () => {
		expect(compareFirmwareVersions(v("3.10.0"), v("3.9.0"))).toBeGreaterThan(0); // lexical "10" < "9" would get this backwards
		expect(compareFirmwareVersions(v("3.7.0"), v("3.7.1"))).toBeLessThan(0);
	});

	it("a final release outranks its own prereleases", () => {
		expect(compareFirmwareVersions(v("3.7.0"), v("3.7.0-rc.1"))).toBeGreaterThan(0);
		expect(compareFirmwareVersions(v("3.7.0-rc.1"), v("3.7.0"))).toBeLessThan(0);
	});

	it("orders RRF's own real prerelease sequence correctly", () => {
		// The exact tag sequence fetched from Duet3D/RepRapFirmware for 3.7.0.
		const sequence = ["3.7.0-alpha.2", "3.7.0-beta.1", "3.7.0-beta.2", "3.7.0-beta.3", "3.7.0-rc.1", "3.7.0"];
		for (let i = 0; i < sequence.length - 1; i++) {
			expect(compareFirmwareVersions(v(sequence[i]), v(sequence[i + 1]))).toBeLessThan(0);
		}
	});

	it("compares numeric prerelease identifiers numerically", () => {
		expect(compareFirmwareVersions(v("3.7.0-rc.2"), v("3.7.0-rc.10"))).toBeLessThan(0); // not lexical "2" > "10"
	});

	it("treats a numeric identifier as lower precedence than an alphanumeric one at the same position", () => {
		expect(compareFirmwareVersions(v("3.7.0-1"), v("3.7.0-rc"))).toBeLessThan(0);
	});

	it("gives lower precedence to fewer prerelease identifiers when the common prefix is equal", () => {
		expect(compareFirmwareVersions(v("3.7.0-rc"), v("3.7.0-rc.1"))).toBeLessThan(0);
	});

	it("is reflexive (equal versions compare to 0)", () => {
		expect(compareFirmwareVersions(v("3.7.0-rc.1"), v("3.7.0-rc.1"))).toBe(0);
	});
});

describe("firmwareAtLeast", () => {
	it("is true at and above the threshold", () => {
		expect(firmwareAtLeast("3.7.0-rc.1", "3.7.0-rc.1")).toBe(true);
		expect(firmwareAtLeast("3.7.0", "3.7.0-rc.1")).toBe(true);
		expect(firmwareAtLeast("3.8.0", "3.7.0-rc.1")).toBe(true);
	});

	it("is false below the threshold — the exact real-world case this exists for", () => {
		expect(firmwareAtLeast("3.7.0-beta.3+1", "3.7.0-rc.1")).toBe(false);
		expect(firmwareAtLeast("3.6.0", "3.7.0-rc.1")).toBe(false);
	});

	it("is false, never true, for missing or unparseable input", () => {
		// An unknown version must never silently unlock behaviour it wasn't verified against.
		expect(firmwareAtLeast(null, "3.7.0-rc.1")).toBe(false);
		expect(firmwareAtLeast(undefined, "3.7.0-rc.1")).toBe(false);
		expect(firmwareAtLeast("", "3.7.0-rc.1")).toBe(false);
		expect(firmwareAtLeast("not a version", "3.7.0-rc.1")).toBe(false);
	});
});
