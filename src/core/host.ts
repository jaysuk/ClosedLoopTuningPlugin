/**
 * The seam between the tuning logic and whichever DuetWebControl it is running inside.
 *
 * DWC 3.7 is Vue 3 / Pinia / vue-i18n 11; DWC 3.6 is Vue 2.7 / Vuex 3 / vue-i18n 8. Those differ in
 * how you reach the object model, dispatch G-code and raise a notification — but in nothing else the
 * tuning page or `updateCheck.ts` cares about. Both take a `HostAdapter` instead of importing any
 * store directly, so the entire driver/mode/calibrate/tune flow is written once and each UI layer
 * supplies a small implementation (see `ui37/host.ts` and `ui36/host.ts`).
 *
 * Deliberately raw: no Vue types cross this boundary, and every method is a plain read or promise —
 * which is what lets the same file compile against both Vue versions.
 */

/** Severity for `notify` — maps to DWC's own notification levels on both versions. */
export type NotifyLevel = "success" | "info" | "warning" | "error";

export interface FileListEntry {
	name: string;
	isDirectory: boolean;
	lastModified: Date | null;
}

export interface HostAdapter {
	/**
	 * Read the machine object model.
	 *
	 * MUST touch the host's reactive state on every call rather than returning a cached snapshot: the
	 * capture-completion watcher (`watch(() => selectedBoard.value?.closedLoop?.runs, …)`) and every
	 * other computed in the page depend on this being tracked at read time, not memoised.
	 */
	model(): unknown;

	/**
	 * Send a G-code line, resolving with the firmware's reply once it has completed.
	 *
	 * `opts.log` controls whether DWC echoes the command into its own console, exactly like a command
	 * the user typed. Defaults to `true` — matches the majority of call sites (mode switches, centring
	 * moves, PID writes: visible state changes the user should see). Auto-tune's own capture-loop
	 * commands pass `{ log: false }` explicitly so a run of dozens of moves doesn't spam the console.
	 */
	sendCode(code: string, opts?: { log?: boolean }): Promise<string>;

	/**
	 * Upload text content to a full path (e.g. a config.g backup or the tuned block itself).
	 *
	 * `showSuccess`/`showError` default to `false` (quiet) — used for the config.g backup copy, which
	 * the page's own try/catch already reports on; the real config.g write passes both `true` so DWC's
	 * own toast confirms it.
	 */
	upload(path: string, content: string, opts?: { showSuccess?: boolean; showError?: boolean }): Promise<void>;
	/** Download a text file by full path. Always quiet — used for capture CSVs and reading config.g. */
	download(path: string): Promise<string>;
	/** List a directory, used to find the newest capture CSV. */
	getFileList(dir: string): Promise<Array<FileListEntry>>;
	/**
	 * Delete a file by full path. Used only for capture CSVs this plugin itself created and has
	 * already read — see the "delete captures after read" setting. Named `deleteFile`, not `delete`:
	 * the latter is legal as a property name but shadows the `delete` operator at every call site.
	 */
	deleteFile(path: string): Promise<void>;
	/** Install a plugin ZIP through DWC's own installer — the one-click self-update path. */
	installPlugin(filename: string, blob: Blob, start: boolean): Promise<void>;

	/**
	 * Which release asset this DWC can actually install.
	 *
	 * A release carries one ZIP per supported DWC generation (`…-1.2.3.zip` for 3.7,
	 * `…-1.2.3-dwc36.zip` for 3.6), and the update checker otherwise just takes the first `*.zip` it
	 * finds — which would offer a 3.6 user the Vue 3 package. Each host narrows it to its own.
	 */
	assetPattern: RegExp;

	/** Raise a DWC toast/notification. */
	notify(level: NotifyLevel, title: string, message: string): void;
	/**
	 * Translate a key relative to this plugin's own namespace — implementations prepend
	 * `plugins.closedLoopTuning.`, so callers pass e.g. `"updates.title"`.
	 *
	 * Only needed by shared, non-component modules (`updateCheck.ts`) — component templates use the
	 * ambient `$t` directly, which both DWC generations install identically as a global mixin.
	 */
	t(key: string, args?: Record<string, unknown>): string;
}
