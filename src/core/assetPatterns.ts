/**
 * Which release ZIP each DWC generation's self-updater may install — see `HostAdapter.assetPattern`
 * in `./host.ts`. A release carries up to three assets with the same version number
 * (`ClosedLoopTuning-1.2.3.zip`, `…-1.2.3-dwc36.zip`, `…-1.2.3-srcmap.zip`), and
 * `dwc-plugin-runtime/updates`' `checkForUpdate` picks the first asset matching this pattern in
 * whatever order GitHub's API returns them — so an under-specific pattern can silently offer the
 * wrong generation's package, or a debug sourcemap archive, as an "update". Kept here (no Vue/DWC
 * imports) so both hosts share one definition and it's testable without a live store — see
 * `assetPatterns.test.ts`.
 */

/** The plain "<name>-<version>.zip" — excludes the -dwc36 sibling and the -srcmap debug archive. */
export const ASSET_PATTERN_37 = /^(?!.*-(dwc36|srcmap)\.zip$).*\.zip$/i;

/** Only the "-dwc36.zip" suffixed package — installing the 3.7 one would at best be rejected by
 *  DWC's own dwcVersion check, at worst leave a broken plugin installed. */
export const ASSET_PATTERN_36 = /-dwc36\.zip$/i;
