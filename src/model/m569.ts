/**
 * The M569 command family for closed-loop drivers, as pure builders/parsers (no DWC imports, so they
 * are unit-testable). Covers:
 *   M569   D<n>  — driver loop mode (open / assisted / closed)
 *   M569.1 ...   — closed-loop configuration (encoder, PID R/I/D/V/A, error thresholds)
 *   M569.5 ...   — performance data capture (optionally during an appended move)
 *   M569.6 V<n>  — calibration / tuning manoeuvres
 *
 * M569 D-values (confirmed from the RRF M569 dictionary): D0=constant off time, D1=random off time,
 * D2=spreadCycle, D3=stealthChop, D4=Closed Loop, D5=Assisted open loop (D4/D5 only on Duet 3 closed
 * loop controllers — 1HCL / Motor23CL). There is no dedicated "open loop" mode for a 1HCL: leaving
 * closed/assisted just means returning to the normal stepper driver mode, whose RRF 3.4+ default is
 * spreadCycle (D2). The UI still shows the literal command before sending and lets the D-values be
 * overridden, so a per-machine config quirk never sends a wrong mode blind.
 */

export type LoopMode = "open" | "assisted" | "closed";

export interface ModeCommandConfig {
	open: number;
	assisted: number;
	closed: number;
}

/** RRF defaults for the M569 D loop-mode parameter. open=spreadCycle default; closed=D4; assisted-open=D5. */
export const DEFAULT_MODE_D: ModeCommandConfig = { open: 2, closed: 4, assisted: 5 };

export const MODE_LABELS: Record<LoopMode, string> = {
	open: "Open loop",
	assisted: "Assisted open loop",
	closed: "Closed loop",
};

/**
 * `M569 P<driver> D<n>` — switch a driver's loop mode. ONLY the D (mode) parameter: never send S here,
 * because M569 S is the motor *direction* (S0/S1) and forcing it would flip a driver configured with
 * a reversed direction, inverting the closed-loop polarity.
 */
export function buildModeCommand(driver: string, mode: LoopMode, dValues: ModeCommandConfig = DEFAULT_MODE_D): string {
	return `M569 P${driver} D${dValues[mode]}`;
}

// --- Encoder types (M569.1 T parameter) ---

export type EncoderType = 0 | 1 | 2 | 3;

export const ENCODER_TYPES: Array<{ value: EncoderType; title: string }> = [
	{ value: 0, title: "None" },
	{ value: 1, title: "Linear composite (T1)" },
	{ value: 2, title: "Quadrature motor shaft (T2)" },
	{ value: 3, title: "Duet3D magnetic (T3)" },
];

// --- Calibration / tuning manoeuvres (M569.6 V parameter) ---

export interface CalibrationMove {
	id: number;
	name: string;
	description: string;
	/** Encoder types this move applies to (empty = all). */
	encoders: Array<EncoderType>;
}

/** M569.6 manoeuvres. V1/V2 are confirmed in the 3.7 dictionary; V3/V4 per the 1HCL tuning wiki. */
export const CALIBRATION_MOVES: Array<CalibrationMove> = [
	{ id: 1, name: "Polarity detection & zeroing", description: "Detects coil orientation / wiring and zeroes the encoder. Quadrature shaft encoders need this after every power-on.", encoders: [1, 2] },
	{ id: 2, name: "Magnetic encoder calibration", description: "Calibrates the encoder to the motor and stores it in the 1HCL flash. Run once per motor/encoder/board combination.", encoders: [1, 3] },
	{ id: 3, name: "Magnetic calibration check", description: "Checks the stored magnetic calibration and reports the residual error.", encoders: [1, 3] },
	{ id: 4, name: "Clear encoder calibration", description: "Clears the stored calibration (run if the motor/encoder/board changed).", encoders: [1, 3] },
];

/** `M569.6 P<driver> V<n>` — run a calibration / tuning manoeuvre. */
export function buildCalibrationCommand(driver: string, moveId: number): string {
	return `M569.6 P${driver} V${moveId}`;
}

// --- Capture variables (M569.5 D bitmask) ---

export interface CaptureVariable {
	/** Bit value used in the M569.5 D bitmask. */
	id: number;
	/** Stable key. */
	key: string;
	/** Column header the firmware writes (and the chart/analysis look up). */
	header: string;
	axis: "count" | "steps" | "degrees" | "unitless";
	/** Degrees-type values are 0–4095 in the CSV; scale to 0–360 for display. */
	scaleToDegrees?: boolean;
}

export const CAPTURE_VARIABLES: Array<CaptureVariable> = [
	{ id: 1, key: "encoderReading", header: "Raw Encoder Reading", axis: "count" },
	{ id: 2, key: "measuredMotorSteps", header: "Measured Motor Steps", axis: "steps" },
	{ id: 4, key: "targetMotorSteps", header: "Target Motor Steps", axis: "steps" },
	{ id: 8, key: "currentError", header: "Current Error", axis: "steps" },
	{ id: 16, key: "pidControlSignal", header: "PID Control Signal", axis: "unitless" },
	{ id: 32, key: "pidPTerm", header: "PID P Term", axis: "unitless" },
	{ id: 64, key: "pidITerm", header: "PID I Term", axis: "unitless" },
	{ id: 128, key: "pidDTerm", header: "PID D Term", axis: "unitless" },
	{ id: 256, key: "stepPhase", header: "Measured Step Phase", axis: "degrees", scaleToDegrees: true },
	{ id: 512, key: "desiredStepPhase", header: "Desired Step Phase", axis: "degrees", scaleToDegrees: true },
	{ id: 1024, key: "phaseShift", header: "Phase Shift", axis: "degrees", scaleToDegrees: true },
	{ id: 2048, key: "coilACurrent", header: "Coil A Current", axis: "unitless" },
	{ id: 4096, key: "coilBCurrent", header: "Coil B Current", axis: "unitless" },
	{ id: 8192, key: "pidVTerm", header: "PID V Term", axis: "unitless" },
	{ id: 16384, key: "pidATerm", header: "PID A Term", axis: "unitless" },
	{ id: 32768, key: "motorCurrentFraction", header: "Motor current fraction", axis: "unitless" },
];

/** Sum the bit ids of the chosen variables into the M569.5 D bitmask. */
export function captureBitmask(variableIds: Array<number>): number {
	return variableIds.reduce((acc, id) => acc | id, 0);
}

export interface CaptureOptions {
	driver: string;
	samples: number;
	/** 0 = record immediately, 1 = record on the next move. */
	activate: 0 | 1;
	/** Samples per second; 0 = as fast as possible. */
	rate: number;
	/** Variable bit ids to record. */
	variables: Array<number>;
	/** Tuning manoeuvre (0 = none, 64 = step). */
	manoeuvre?: number;
	/** Move G-code to append on the same line (recommended with activate=1). */
	move?: string;
	/** Step-change time in ms for a step manoeuvre. */
	stepTimeMs?: number;
}

/** Build the `M569.5` capture command, optionally with a move appended on the same line. */
export function buildCaptureCommand(opts: CaptureOptions): string {
	const d = captureBitmask(opts.variables);
	const parts = [
		`M569.5 P${opts.driver}`,
		`S${opts.samples}`,
		`A${opts.activate}`,
		`R${opts.rate}`,
		`D${d}`,
		`V${opts.manoeuvre ?? 0}`,
	];
	if (opts.manoeuvre === 64 && opts.stepTimeMs != null) {
		parts.push(`T${opts.stepTimeMs}`);
	}
	let cmd = parts.join(" ");
	if (opts.move && opts.move.trim()) {
		cmd += ` ${opts.move.trim()}`;
	}
	return cmd;
}

// --- M569.1 closed-loop configuration (PID etc.) ---

export interface PidValues {
	p: number;
	i: number;
	d: number;
	v: number;
	a: number;
}

export interface PidConfig extends PidValues {
	warn?: number | null;
	err?: number | null;
}

/** `M569.1 P<driver> R<P> I<I> D<D> V<V> A<A> [E<warn>:<err>]`. */
export function buildPidCommand(driver: string, cfg: PidConfig): string {
	let cmd = `M569.1 P${driver} R${cfg.p} I${cfg.i} D${cfg.d} V${cfg.v} A${cfg.a}`;
	if (cfg.warn != null && cfg.err != null) {
		cmd += ` E${cfg.warn}:${cfg.err}`;
	}
	return cmd;
}

export interface ParsedPid extends PidValues {
	warn: number | null;
	err: number | null;
}

/** Parse the reply of a bare `M569.1 P<driver>` query into PID + error-threshold values. */
export function parsePidReply(reply: string): ParsedPid {
	const num = (re: RegExp): number => {
		const m = re.exec(reply);
		return m ? Number(m[1]) : 0;
	};
	const thresh = /threshold\s+([0-9.]+)\/([0-9.]+)/i.exec(reply);
	return {
		p: num(/P=([0-9.]+)/),
		i: num(/I=([0-9.]+)/),
		d: num(/D=([0-9.]+)/),
		v: num(/V=([0-9.]+)/),
		a: num(/A=([0-9.]+)/),
		warn: thresh ? Number(thresh[1]) : null,
		err: thresh ? Number(thresh[2]) : null,
	};
}
