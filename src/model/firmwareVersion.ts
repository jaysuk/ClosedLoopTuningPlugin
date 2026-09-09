/**
 * RRF firmware version comparison — semver precedence, not string comparison.
 *
 * RRF versions look like "3.7.0-beta.3+1", "3.7.0-rc.1", "3.6.0". Plain string comparison happens to get
 * "beta" < "rc" right, but that is luck, not a rule — nothing guarantees the next prerelease word sorts
 * correctly against "rc", and it gets the release-vs-prerelease case wrong outright ("3.7.0" < "3.7.0-rc.1"
 * as strings, the opposite of semver's actual precedence: a final release is NEWER than any of its own
 * prereleases). See docs/PLAN-rc1-accelerometer-addressing.md for why this exists.
 */

export interface FirmwareVersion {
	major: number;
	minor: number;
	patch: number;
	/** Dot-separated prerelease identifiers, e.g. ["rc", "1"] for "-rc.1". Empty = a final release. */
	prerelease: Array<string>;
}

/** Null for anything that doesn't parse as major.minor.patch[-prerelease][+build] — build metadata is
 *  parsed but discarded; per semver it never affects precedence. */
export function parseFirmwareVersion(version: string): FirmwareVersion | null {
	const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version.trim());
	if (!m) { return null; }
	const [, maj, min, pat, pre] = m;
	return { major: Number(maj), minor: Number(min), patch: Number(pat), prerelease: pre ? pre.split(".") : [] };
}

function compareIdentifier(a: string, b: string): number {
	const aNum = /^\d+$/.test(a), bNum = /^\d+$/.test(b);
	if (aNum && bNum) { return Number(a) - Number(b); }
	if (aNum) { return -1; } // numeric identifiers have lower precedence than alphanumeric ones
	if (bNum) { return 1; }
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Semver precedence: negative if a<b, 0 if equal, positive if a>b. */
export function compareFirmwareVersions(a: FirmwareVersion, b: FirmwareVersion): number {
	if (a.major !== b.major) { return a.major - b.major; }
	if (a.minor !== b.minor) { return a.minor - b.minor; }
	if (a.patch !== b.patch) { return a.patch - b.patch; }
	if (a.prerelease.length === 0 && b.prerelease.length === 0) { return 0; }
	if (a.prerelease.length === 0) { return 1; }  // a final release outranks any of its own prereleases
	if (b.prerelease.length === 0) { return -1; }
	const len = Math.max(a.prerelease.length, b.prerelease.length);
	for (let i = 0; i < len; i++) {
		if (i >= a.prerelease.length) { return -1; } // fewer identifiers = lower precedence, all else equal
		if (i >= b.prerelease.length) { return 1; }
		const c = compareIdentifier(a.prerelease[i], b.prerelease[i]);
		if (c !== 0) { return c; }
	}
	return 0;
}

/**
 * True when `version` is at or above `atLeast`. An unparseable or missing `version` ALWAYS returns
 * false — an unknown firmware version must never silently unlock behaviour it was never verified
 * against; the caller's job is to fall back to whatever already works everywhere else in that case.
 */
export function firmwareAtLeast(version: string | null | undefined, atLeast: string): boolean {
	if (!version) { return false; }
	const v = parseFirmwareVersion(version);
	const target = parseFirmwareVersion(atLeast);
	if (!v || !target) { return false; }
	return compareFirmwareVersions(v, target) >= 0;
}
