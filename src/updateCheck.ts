/**
 * Self-update for the Closed Loop Tuning plugin, working WITH the shared cross-plugin update hub in
 * dwc-plugin-runtime. On load it checks this fork's GitHub Releases and announces a newer build into
 * the hub (a host like Flexible Layouts shows it in the unified popup); otherwise it falls back to a
 * one-off notification and the About tab shows an in-context banner with one-click apply.
 *
 * Shared by both DWC generations (see ../core/host.ts) — reaches DWC only through the `HostAdapter`
 * set by whichever entry point is running, never through a store directly. That's what lets this same
 * file compile and run against both the Pinia (3.7) and Vuex (3.6) builds.
 */
// Deep subpath imports, not the package barrel: the barrel also re-exports AboutDialog/HelpTip/
// PluginWidgetConfigForm, which call Vue 3's `resolveComponent` — absent in Vue 2.7, so pulling the
// barrel into this shared module would break the DWC 3.6 build. These modules import no Vue at all.
import { applyUpdate, checkForUpdate, type UpdateResult } from "dwc-plugin-runtime/updates";
import { announceUpdate, clearAnnouncedUpdate, isUpdateHostActive, registerUpdateChecker } from "dwc-plugin-runtime/updateHub";
import { ref } from "vue";

import type { HostAdapter } from "./core/host";
import { PLUGIN_MANIFEST_ID } from "./model/constants";

/**
 * Set once at plugin load by whichever entry point is running (ui37/index.ts or ui36/index.ts). This
 * module runs before any component mounts, so it cannot reach a store directly — see ./core/host.
 */
let host: HostAdapter | null = null;
export function setUpdateHost(h: HostAdapter): void { host = h; }

const OWNER = "jaysuk";
const REPO = "ClosedLoopTuningPlugin";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const LS_ENABLED = "closedLoopTuning.updateCheck.enabled";
const LS_LAST = "closedLoopTuning.updateCheck.lastCheck";
const LS_DISMISSED = "closedLoopTuning.updateCheck.dismissed";

export const updateState = ref<UpdateResult | null>(null);
export const checking = ref(false);
export const applying = ref(false);
export const pendingReload = ref(false);
export const dismissedVersion = ref<string | null>(safeGet(LS_DISMISSED));

// Namespaced under "updates." — the plugin's own top-level title (used for the update-hub banner
// below) is a SEPARATE key, read directly via host.t("title") rather than through this helper.
const t = (key: string, named?: Record<string, unknown>) => host?.t(`updates.${key}`, named) ?? "";
const pluginTitle = () => host?.t("title") ?? "Closed Loop Tuning";

function safeGet(key: string): string | null {
	try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key: string, value: string): void {
	try { localStorage.setItem(key, value); } catch { /* storage disabled */ }
}

function currentVersion(): string {
	const plugins = (host?.model() as { plugins?: Map<string, { version?: string }> } | undefined)?.plugins;
	return plugins?.get(PLUGIN_MANIFEST_ID)?.version ?? "0.0.0";
}

export function updateChecksEnabled(): boolean {
	return safeGet(LS_ENABLED) !== "false";
}
export function setUpdateChecksEnabled(on: boolean): void {
	safeSet(LS_ENABLED, on ? "true" : "false");
	if (!on) clearAnnouncedUpdate(PLUGIN_MANIFEST_ID);
}

/** Announce (or clear) this plugin's update in the shared cross-plugin hub, based on the last check. */
function syncHub(): void {
	const s = updateState.value;
	if (s?.updateAvailable && dismissedVersion.value !== s.latestVersion) {
		announceUpdate(PLUGIN_MANIFEST_ID, pluginTitle(), s);
	} else {
		clearAnnouncedUpdate(PLUGIN_MANIFEST_ID);
	}
}

export async function runUpdateCheck(opts: { force?: boolean; notify?: boolean } = {}): Promise<UpdateResult | null> {
	if (!opts.force) {
		if (!updateChecksEnabled()) return null;
		const last = Number(safeGet(LS_LAST) || 0);
		if (Date.now() - last < CHECK_INTERVAL_MS) {
			syncHub();
			return updateState.value;
		}
	}
	checking.value = true;
	try {
		const result = await checkForUpdate({
			owner: OWNER, repo: REPO, currentVersion: currentVersion(),
			// A release ships one ZIP per DWC generation; without this the checker takes whichever
			// *.zip GitHub lists first and could offer a 3.6 user the Vue 3 package.
			...(host?.assetPattern ? { assetPattern: host.assetPattern } : {}),
		});
		updateState.value = result;
		safeSet(LS_LAST, String(Date.now()));
		if (opts.notify && result.updateAvailable && dismissedVersion.value !== result.latestVersion && !isUpdateHostActive()) {
			const message = result.scenario === "dwcUpdate"
				? t("notifyDwc", { version: result.latestVersion, dwc: result.requiredDwc })
				: t("notifyPlugin", { version: result.latestVersion });
			host?.notify("info", t("title"), message);
		}
		syncHub();
		return result;
	} catch {
		return null;
	} finally {
		checking.value = false;
	}
}

registerUpdateChecker(PLUGIN_MANIFEST_ID, async () => { await runUpdateCheck({ force: true }); });

export function dismissCurrentUpdate(): void {
	const v = updateState.value?.latestVersion;
	if (v) {
		safeSet(LS_DISMISSED, v);
		dismissedVersion.value = v;
		clearAnnouncedUpdate(PLUGIN_MANIFEST_ID);
	}
}

export async function applyUpdateNow(): Promise<void> {
	const result = updateState.value;
	if (!result?.assetUrl || !result.assetName) {
		host?.notify("warning", t("title"), t("applyFailed"));
		return;
	}
	applying.value = true;
	try {
		await applyUpdate({
			assetUrl: result.assetUrl,
			assetName: result.assetName,
			installPlugin: (filename, blob, start) => host!.installPlugin(filename, blob, start),
		});
		pendingReload.value = true;
		clearAnnouncedUpdate(PLUGIN_MANIFEST_ID);
		host?.notify("success", t("title"), t("installedReload", { version: result.latestVersion }));
	} catch (e) {
		console.warn("[ClosedLoopTuning] update failed:", e);
		host?.notify("warning", t("title"), t("corsBlocked"));
		window.location.href = result.assetUrl;
	} finally {
		applying.value = false;
	}
}
