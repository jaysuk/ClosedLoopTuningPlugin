/**
 * Closed Loop Tuning — entry point (DWC 3.7).
 *
 * Registers a standalone DWC page (Plugins → Closed Loop Tuning) for tuning and visualising Duet
 * closed-loop drivers: loop-mode + calibration control, a guided PID tuning wizard with
 * automatic step-response analysis, and an improved data-capture chart. Wires in the shared runtime
 * (self-update hub + error capture) and tears down app-lifetime resources on `dwcPluginUnloaded`.
 */
import { registerPluginMessages, registerRoute, unregisterRoute } from "@/plugins";
import Events from "@/utils/events";
import { clearAnnouncedUpdate, installErrorCapture } from "dwc-plugin-runtime";

import ClosedLoopTuning from "./ClosedLoopTuning.vue";
import { PLUGIN_ID, PLUGIN_MANIFEST_ID, ROUTE_PATH } from "../model/constants";
import { runUpdateCheck, setUpdateHost } from "../updateCheck";
import { createHost } from "./host";
import en from "../i18n/en.json";

registerPluginMessages(PLUGIN_ID, { en });

// updateCheck.ts is shared with the (future) DWC 3.6 build, so it reaches DWC only through the same
// host adapter the page itself uses, never through Pinia directly.
setUpdateHost(createHost());

registerRoute(ClosedLoopTuning, {
	Plugins: {
		ClosedLoopTuning: {
			icon: "mdi-chart-bell-curve-cumulative",
			caption: "plugins.closedLoopTuning.menuCaption",
			path: ROUTE_PATH,
			// The page itself carries the matching `dwc-page-fill` class (md+ only — see the mdAndUp
			// comment in ClosedLoopTuning.vue); this just tells DWC's own scrollBehavior the page manages
			// its own scrolling instead of the page-level one, same as InputShaping's own registration.
			pageFill: true,
		},
	},
});

const uninstallErrorCapture = installErrorCapture();

setTimeout(() => { void runUpdateCheck({ notify: true }); }, 4000);

function onPluginUnloaded(id: string): void {
	if (id === PLUGIN_MANIFEST_ID) {
		unregisterRoute(ROUTE_PATH);
		clearAnnouncedUpdate(PLUGIN_MANIFEST_ID);
		uninstallErrorCapture();
		Events.off("dwcPluginUnloaded", onPluginUnloaded);
	}
}
Events.on("dwcPluginUnloaded", onPluginUnloaded);
