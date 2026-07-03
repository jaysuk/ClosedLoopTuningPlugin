/**
 * config.g persistence — an idempotent, marker-delimited block so auto-tune results can be written
 * back automatically instead of hand-copied. Pure text surgery only: never touches anything outside
 * its own markers, so re-running it (or running it for a different driver) can't clobber the rest of
 * the user's config.g. The Vue layer is responsible for downloading/backing up/uploading the file —
 * this module only computes the new text.
 */
import { buildCalibrationCommand, buildModeCommand, buildPidCommand, type LoopMode, type ModeCommandConfig, type PidConfig } from "./m569";

export interface TuneConfigBlock {
	driver: string;
	pid: PidConfig;
	mode: LoopMode;
	modeD: ModeCommandConfig;
	/** Calibration moves to record for reference (documentation only — not re-run by config.g). */
	calibrationMoveIds?: Array<number>;
}

const MARKER_PREFIX = "; --- ClosedLoopTuning driver ";
const BEGIN_SUFFIX = " begin ---";
const END_SUFFIX = " end ---";

function beginMarker(driver: string): string { return `${MARKER_PREFIX}${driver}${BEGIN_SUFFIX}`; }
function endMarker(driver: string): string { return `${MARKER_PREFIX}${driver}${END_SUFFIX}`; }

/** Render the block's body lines (without markers) for a given driver's tuned config. */
export function renderTuneBlockBody(block: TuneConfigBlock): Array<string> {
	const lines = [
		buildModeCommand(block.driver, block.mode, block.modeD),
		buildPidCommand(block.driver, block.pid),
	];
	for (const moveId of block.calibrationMoveIds ?? []) {
		lines.push(`; calibration reference (run once, not on every boot): ${buildCalibrationCommand(block.driver, moveId)}`);
	}
	return lines;
}

export interface UpsertResult {
	text: string;
	/** The text differs from the input (a block was inserted or an existing one replaced). */
	changed: boolean;
	/** An existing block for this driver was found and replaced, rather than a fresh insert. */
	replaced: boolean;
}

/**
 * Insert or replace this driver's marker-delimited block in `configText`. Idempotent: running it
 * again with the same block produces no change; running it with updated values replaces only the
 * lines between this driver's markers, byte-for-byte preserving everything else in the file.
 */
export function upsertTuneBlock(configText: string, block: TuneConfigBlock): UpsertResult {
	const begin = beginMarker(block.driver);
	const end = endMarker(block.driver);
	const newBlockLines = [begin, ...renderTuneBlockBody(block), end];

	const lines = configText.split(/\r?\n/);
	const beginIdx = lines.findIndex((l) => l.trim() === begin);
	const endIdx = beginIdx >= 0 ? lines.findIndex((l, i) => i > beginIdx && l.trim() === end) : -1;

	if (beginIdx >= 0 && endIdx >= 0) {
		const before = lines.slice(0, beginIdx);
		const after = lines.slice(endIdx + 1);
		const existingBlock = lines.slice(beginIdx, endIdx + 1);
		const unchanged = existingBlock.length === newBlockLines.length && existingBlock.every((l, i) => l === newBlockLines[i]);
		if (unchanged) {
			return { text: configText, changed: false, replaced: false };
		}
		const text = [...before, ...newBlockLines, ...after].join("\n");
		return { text, changed: true, replaced: true };
	}

	// No existing block for this driver — append, keeping a blank-line separator if the file is non-empty.
	const trimmedEnd = configText.replace(/\s+$/, "");
	const text = trimmedEnd ? `${trimmedEnd}\n\n${newBlockLines.join("\n")}\n` : `${newBlockLines.join("\n")}\n`;
	return { text, changed: true, replaced: false };
}
