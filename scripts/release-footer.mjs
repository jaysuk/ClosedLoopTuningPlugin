#!/usr/bin/env node
/**
 * Static footer appended to every GitHub Release body: install instructions, the DuetWebControl
 * version built against, and the machine-readable `dwc-plugin-update` marker the in-app update checker
 * looks for. DWC details come from the release workflow's environment; they fall back when run locally.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const manifest = JSON.parse(readFileSync(join(repoRoot, "plugin.json"), "utf8"));
const pkgVersion = manifest.version;

// release.yml runs the DWC 3.6 build (if src/ui36 exists) and drops its ZIP in the repo root BEFORE
// this script runs — see the "Build installable ZIP (DWC 3.6)" step. Checking for the file itself
// (rather than assuming) keeps this correct if that build is ever skipped or removed again.
const dwc36AssetName = `ClosedLoopTuning-${pkgVersion}-dwc36.zip`;
const has36 = existsSync(join(repoRoot, dwc36AssetName));

const dwcVersion = process.env.DWC_VERSION || "";
function resolveDwcRequirement(value, reference) {
	if (value === "auto") return reference;
	// "auto-major" normally narrows to major.minor (e.g. "3.7") - accurate for a single-generation
	// release. This release ships DWC 3.6 *and* 3.7 packages under one tag: 3.6.x and 3.7.x differ in
	// minor but are both DWC major 3, so narrowing to major.minor here would make the metadata comment
	// (read below) require a specific minor no build in this release actually needs. Narrowing to the
	// major only is what's true of BOTH packages, and the real per-package gate is each ZIP's own
	// embedded plugin.json dwcVersion (resolved separately by build-plugin-pkg against its own
	// checkout) - this value is only the update CHECKER's compatibility hint, not an install gate.
	if (value === "auto-major") return has36 ? reference.split(".")[0] : reference.split(".").slice(0, 2).join(".");
	return value || "";
}
const requiredDwc = resolveDwcRequirement(manifest.dwcVersion, dwcVersion);
const dwcSha = process.env.DWC_SHA || "";
const dwcRef = process.env.DWC_REF || "v3.7-dev";
const dwcBuiltAgainst = dwcVersion
	? `**DuetWebControl ${dwcVersion}**${dwcSha ? ` (\`${dwcSha}\`, ref \`${dwcRef}\`)` : ` (ref \`${dwcRef}\`)`}`
	: `DuetWebControl (ref \`${dwcRef}\`)`;

const installStep = has36
	? `1. Download the ZIP for **your** DuetWebControl from the **Assets** below — they are different builds, not alternatives:
   - DWC **3.7** and newer → \`ClosedLoopTuning-${pkgVersion}.zip\`
   - DWC **3.6** → \`${dwc36AssetName}\``
	: `1. Download \`ClosedLoopTuning-${pkgVersion}.zip\` from the **Assets** below.`;
const dwcNote = has36
	? `> 🔧 The 3.7 package is built against ${dwcBuiltAgainst}; the 3.6 package against the DWC 3.6 branch.\n> DWC refuses a package whose \`dwcVersion\` doesn't match, so picking the wrong one is safe but won't install.`
	: `> 🔧 Built against ${dwcBuiltAgainst}. Use a DuetWebControl build at or near this version.`;

const out = `
---

### 📦 Install
${installStep}
2. In DuetWebControl, go to **Settings → General → Plugins** and click **Install Plugin**.
3. Select the downloaded ZIP and accept the third-party-plugin prompt.
4. Reload DWC, then open **Plugins → Closed Loop Tuning**.

${dwcNote}
> ⚙️ Requires a Duet 3 board with closed-loop driver support (a Duet3D Expansion 1HCL / M23CL, or any other RRF board reporting closed-loop driver telemetry). Tuning moves a single driver — make sure the axis is in a safe position before recording.

<!-- dwc-plugin-update ${JSON.stringify({ version: pkgVersion, dwcVersion: requiredDwc, asset: `ClosedLoopTuning-${pkgVersion}.zip` })} -->
`;

process.stdout.write(out.replace(/^\n/, ""));
