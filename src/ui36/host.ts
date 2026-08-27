/**
 * `HostAdapter` for DuetWebControl 3.6 (Vue 2.7, Vuex 3, vue-i18n 8).
 *
 * The 3.7 counterpart (`../ui37/host.ts`) talks to Pinia stores; 3.6 has a single Vuex root store
 * with a namespaced `machine` module, and notifications are a plain exported function rather than a
 * store action. Unlike the 3.7 version this needs no active component instance, since the Vuex store
 * and the i18n instance are both module singletons.
 */
import i18n from "@/i18n";
import store from "@/store";
import { makeNotification } from "@/utils/notifications";
import { LogType } from "@/utils/logging";

import { ASSET_PATTERN_36 } from "../core/assetPatterns";
import type { HostAdapter, NotifyLevel } from "../core/host";

const LEVELS: Record<NotifyLevel, LogType> = {
	success: LogType.success,
	info: LogType.info,
	warning: LogType.warning,
	error: LogType.error,
};

export function createHost(): HostAdapter {
	return {
		// Read through the store every call rather than caching — Vue 2.7's `watch` tracks the same way
		// Vue 3's does, so the page's capture-completion watcher depends on this staying live.
		model: () => (store.state as { machine: { model: unknown } }).machine.model,

		sendCode: async (code, opts) => String(await store.dispatch("machine/sendCode", { code, log: opts?.log ?? true }) ?? ""),
		// 3.6 takes the transfer flags as named fields of the payload where 3.7 takes them positionally;
		// the intent is the same — stay quiet unless asked, this is background I/O the page itself reports on.
		upload: async (path, content, opts) => {
			await store.dispatch("machine/upload", {
				filename: path, content, showProgress: false,
				showSuccess: opts?.showSuccess ?? false, showError: opts?.showError ?? false,
			});
		},
		download: async (path) => String(await store.dispatch("machine/download", {
			filename: path, type: "text", showProgress: false, showSuccess: false, showError: false,
		}) ?? ""),
		getFileList: (dir) => store.dispatch("machine/getFileList", dir),
		deleteFile: async (path) => { await store.dispatch("machine/delete", path); },
		// 3.6's action wants the parsed archive as well as the blob (it reads plugin.json out of it to
		// check the DWC version), where 3.7 parses internally. JSZip is one of DWC 3.6's own
		// dependencies, and is imported lazily so it only costs anything on an actual self-update.
		installPlugin: async (filename, blob, start) => {
			const JSZip = (await import("jszip")).default;
			const zipFile = await new JSZip().loadAsync(blob);
			await store.dispatch("machine/installPlugin", { zipFilename: filename, zipBlob: blob, zipFile, start });
		},

		assetPattern: ASSET_PATTERN_36,

		notify: (level, title, message) => { makeNotification(LEVELS[level], title, message); },
		// vue-i18n 8 exposes `t` directly on the instance (vue-i18n 11 nests it under `.global`).
		t: (key, args) => String(i18n.t(`plugins.closedLoopTuning.${key}`, args ?? {})),
	};
}
