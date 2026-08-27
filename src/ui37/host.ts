/**
 * `HostAdapter` for DuetWebControl 3.7+ (Vue 3, Pinia, vue-i18n 11).
 *
 * Must be called from inside a component's setup, or after Pinia is otherwise active (`index.ts`
 * calls it at plugin-load time, which DWC guarantees runs after Pinia is installed) — `useMachineStore`/
 * `useUiStore` need an active Pinia instance. See `../ui36/host.ts` for the Vue 2.7 / Vuex 3 counterpart.
 */
import { useMachineStore } from "@/stores/machine";
import { LogLevel, useUiStore } from "@/stores/ui";
import i18n from "@/i18n";

import { ASSET_PATTERN_37 } from "../core/assetPatterns";
import type { FileListEntry, HostAdapter, NotifyLevel } from "../core/host";

const LEVELS: Record<NotifyLevel, LogLevel> = {
	success: LogLevel.success,
	info: LogLevel.info,
	warning: LogLevel.warning,
	error: LogLevel.error,
};

/** Extra store members not on the public typings. */
type MachineExtras = {
	getFileList(dir: string): Promise<Array<FileListEntry>>;
	installPlugin(filename: string, blob: Blob, start: boolean): Promise<void>;
	delete(filename: string, recursive?: boolean): Promise<void>;
};

/**
 * Each method resolves its store on call rather than once up front, so this can safely be built at
 * plugin-load time (from index.ts, before any component exists) as well as inside setup.
 */
export function createHost(): HostAdapter {
	const machine = () => useMachineStore();

	return {
		// Property read (not a cached destructure) so Pinia tracks it for the page's own watchers.
		model: () => machine().model,

		sendCode: async (code, opts) => String(await machine().sendCode(code, false, opts?.log ?? true) ?? ""),
		upload: async (path, content, opts) => {
			await machine().upload({ filename: path, content }, false, opts?.showSuccess ?? false, opts?.showError ?? false);
		},
		download: async (path) => String(await machine().download({ filename: path, type: "text" }, false, false, false) ?? ""),
		getFileList: (dir) => (machine() as unknown as MachineExtras).getFileList(dir),
		installPlugin: (filename, blob, start) => (machine() as unknown as MachineExtras).installPlugin(filename, blob, start),
		deleteFile: (path) => (machine() as unknown as MachineExtras).delete(path),

		assetPattern: ASSET_PATTERN_37,

		notify: (level, title, message) => { useUiStore().makeNotification(LEVELS[level], title, message); },
		t: (key, args) => i18n.global.t(`plugins.closedLoopTuning.${key}`, args ?? {}),
	};
}
