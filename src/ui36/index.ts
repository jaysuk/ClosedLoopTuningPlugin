/**
 * Closed Loop Tuning — DuetWebControl 3.6 entry point.
 *
 * Differences from the 3.7 entry (`../ui37/index.ts`), all forced by what 3.6's plugin API offers:
 *
 *  - `registerRoute` lives in `@/routes`, not `@/plugins`.
 *  - There is no `registerPluginMessages`. 3.6 bakes built-in plugins' strings into DWC's own
 *    `en.json`, which an external plugin cannot do, so we merge the same bundle into the live
 *    vue-i18n 8 instance ourselves. The keys are identical (`plugins.closedLoopTuning.*`), which is
 *    why `../i18n/en.json` is shared verbatim with 3.7.
 *  - There is no `dwcPluginUnloaded` event to unregister from, so the error capture installed here
 *    lives for the session — it is a passive `window.onerror` listener feeding the diagnostics
 *    report, so leaving it installed costs nothing.
 */
import { registerRoute } from "@/routes";
import i18n from "@/i18n";

// Subpath, not the barrel: the barrel pulls in Vue 3-only components (see ../updateCheck).
import { installErrorCapture } from "dwc-plugin-runtime/diagnostics";

import en from "../i18n/en.json";
import { PLUGIN_ID, ROUTE_PATH } from "../model/constants";
import { runUpdateCheck, setUpdateHost } from "../updateCheck";
import { createHost } from "./host";
import ClosedLoopTuningPage from "./ClosedLoopTuningPage.vue";

// Same namespace the 3.7 build gets from registerPluginMessages, so every $t key matches.
i18n.mergeLocaleMessage("en", { plugins: { [PLUGIN_ID]: en } });

// NB: no `translated: true` here. In 3.6 that flag means "this caption is already display text,
// don't run it through $t" (App.vue renders `page.translated ? page.caption : $t(page.caption)`),
// so setting it alongside an i18n key puts the literal string "plugins.closedLoopTuning.menuCaption"
// in the sidebar. The key resolves because of the mergeLocaleMessage call above.
registerRoute(ClosedLoopTuningPage, {
	Plugins: {
		ClosedLoopTuning: {
			icon: "mdi-chart-bell-curve-cumulative",
			caption: "plugins.closedLoopTuning.menuCaption",
			path: ROUTE_PATH,
		},
	},
});

setUpdateHost(createHost());

// Capture window errors so a bug report can carry them (the page's diagnostics button).
installErrorCapture();

// Throttled on-load update check, delayed so it doesn't compete with initial page load.
setTimeout(() => { void runUpdateCheck({ notify: true }); }, 4000);
