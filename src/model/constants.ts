/**
 * Shared plugin identifiers. Leaf module so any file can import them without pulling in index.ts.
 */

/** Manifest id (plugin.json `id`) — kept the same as upstream so this is a drop-in replacement. */
export const PLUGIN_MANIFEST_ID = "ClosedLoopTuning";

/** camelCase key for settings persistence and i18n (`plugins.closedLoopTuning.*`). */
export const PLUGIN_ID = "closedLoopTuning";

/** Route path for the standalone DWC page. */
export const ROUTE_PATH = "/Plugins/ClosedLoopTuning";

/** localStorage key for persisted UI selections (driver, mode commands, last capture settings). */
export const LS_STATE = "closedLoopTuning.state";

/** Directory the firmware writes M569.5 capture CSVs to. */
export const CAPTURE_DIR = "0:/sys/closed-loop";

/** Duet documentation links used by the in-UI help tooltips. */
export const DOCS = {
	tuning: "https://docs.duet3d.com/User_manual/Tuning/Duet_3_1HCL_tuning",
	m569: "https://docs.duet3d.com/User_manual/Reference/Gcodes/M569",
	m569_1: "https://docs.duet3d.com/User_manual/Reference/Gcodes/M569_1",
	m569_5: "https://docs.duet3d.com/User_manual/Reference/Gcodes/M569_5",
	m569_6: "https://docs.duet3d.com/User_manual/Reference/Gcodes/M569_6",
};
