<template>
	<v-container fluid class="pa-2">
		<v-alert v-if="updateBanner" type="info" variant="tonal" density="compact" class="mb-3">
			{{ updateBanner }}
			<template #append>
				<v-btn v-if="!pendingReload" size="small" variant="text" :loading="applying" @click="applyUpdateNow">{{ $t("plugins.closedLoopTuning.updates.apply") }}</v-btn>
				<v-btn v-if="pendingReload" size="small" variant="text" @click="reloadPage">{{ $t("plugins.closedLoopTuning.updates.reload") }}</v-btn>
				<v-btn size="small" variant="text" @click="dismissCurrentUpdate">{{ $t("plugins.closedLoopTuning.updates.dismiss") }}</v-btn>
			</template>
		</v-alert>

		<v-alert v-if="drivers.length === 0" type="warning" variant="tonal" density="compact" class="mb-3">
			No closed-loop drivers found. Connect a Duet 3 board with a 1HCL / M23CL configured for an axis or extruder.
		</v-alert>

		<v-alert type="warning" variant="tonal" density="compact" class="mb-3" icon="mdi-connection">
			<strong>Disconnect the motor from the motion system before tuning.</strong>
			Uncouple it from the belt / leadscrew (or detach the belt) so the shaft can spin freely. Tuning
			drives the motor hard and deliberately provokes oscillation to find the limits — doing that while
			it's coupled to the machine can stress or damage the mechanics. Reconnect before printing, and
			re-run a quick check once coupled (the loaded inertia shifts the ideal values slightly).
		</v-alert>

		<div class="d-flex align-center mb-2">
			<v-icon class="mr-2">mdi-chart-bell-curve-cumulative</v-icon>
			<span class="text-subtitle-1">Closed Loop Tuning</span>
			<HelpTip class="ml-1" :href="DOCS.tuning"
					 text="Follow the steps below in order: pick the driver, switch to closed/assisted mode, calibrate the encoder, tune the PID terms one at a time using the step response, then test and save. Click for the full Duet 1HCL tuning guide." />
			<v-spacer />
			<v-chip v-if="selectedDriver" size="small" variant="tonal" class="mr-2">Driver {{ selectedDriver }}</v-chip>
			<v-chip v-if="currentMode" size="small" :color="currentMode === 'open' ? 'grey' : 'success'" variant="flat">{{ MODE_LABELS[currentMode] }}</v-chip>
		</div>

		<v-stepper v-model="step" :items="stepTitles" editable flat>
			<!-- 1. Driver -->
			<template #item.1>
				<v-card flat>
					<div class="text-body-2 mb-3">
						Pick the closed-loop driver you want to tune. Tuning moves only this driver, so re-home the axis afterwards.
						<HelpTip text="The list shows every axis/extruder driver on a board that reports closed-loop support (a 1HCL or M23CL). Only one driver can be tuned at a time." />
					</div>
					<v-select v-model="selectedDriver" :items="drivers" item-title="name" item-value="value"
							  density="compact" variant="outlined" hide-details label="Closed-loop driver" style="max-width: 480px" />
					<div v-if="selectedDriver" class="text-caption text-medium-emphasis mt-3">
						Tip: read the current settings any time with the <strong>Reload</strong> button on the PID step.
					</div>
				</v-card>
			</template>

			<!-- 2. Loop mode -->
			<template #item.2>
				<v-card flat>
					<div class="text-body-2 mb-3">
						Choose how the driver runs. Tune in the mode you'll actually print in, and switch to
						<strong>closed</strong> or <strong>assisted</strong> before calibrating.
						<HelpTip :href="DOCS.m569" text="M569 D-parameter. Open = normal stepper, no feedback. Closed loop = full PID position control from the encoder. Assisted open loop = runs open-loop but uses the encoder to correct/avoid lost steps. D4=closed, D5=assisted, open returns to the normal stepper mode." />
					</div>
					<div class="d-flex flex-wrap ga-2 mb-3">
						<v-tooltip v-for="m in modeList" :key="m.value" :text="modeHelp[m.value]" location="bottom" max-width="320">
							<template #activator="{ props: tip }">
								<v-btn v-bind="tip" :color="currentMode === m.value ? 'primary' : undefined"
									   :variant="currentMode === m.value ? 'flat' : 'tonal'" size="small"
									   :disabled="!selectedDriver" @click="setMode(m.value)">{{ m.label }}</v-btn>
							</template>
						</v-tooltip>
					</div>
					<div v-if="selectedDriver" class="text-caption text-medium-emphasis">
						Will send: <code>{{ buildModeCommand(selectedDriver, 'closed', modeD) }}</code> (closed) ·
						<code>{{ buildModeCommand(selectedDriver, 'assisted', modeD) }}</code> (assisted) ·
						<code>{{ buildModeCommand(selectedDriver, 'open', modeD) }}</code> (open)
					</div>
					<v-expansion-panels class="mt-3" variant="accordion">
						<v-expansion-panel>
							<v-expansion-panel-title>
								Advanced: mode D-values
								<HelpTip class="ml-1" :href="DOCS.m569" text="The M569 D number for each mode. Defaults match RRF 3.6/3.7 (open=spreadCycle D2, closed=D4, assisted-open=D5). Only change these if your firmware differs." />
							</v-expansion-panel-title>
							<v-expansion-panel-text>
								<v-row dense>
									<v-col cols="4"><v-text-field v-model.number="modeD.open" type="number" label="Open (D)" density="compact" variant="outlined" hide-details /></v-col>
									<v-col cols="4"><v-text-field v-model.number="modeD.closed" type="number" label="Closed (D)" density="compact" variant="outlined" hide-details /></v-col>
									<v-col cols="4"><v-text-field v-model.number="modeD.assisted" type="number" label="Assisted (D)" density="compact" variant="outlined" hide-details /></v-col>
								</v-row>
							</v-expansion-panel-text>
						</v-expansion-panel>
					</v-expansion-panels>
				</v-card>
			</template>

			<!-- 3. Calibrate -->
			<template #item.3>
				<v-card flat>
					<div class="text-body-2 mb-3">
						Calibration teaches the board the relationship between the encoder and the motor. It must be done
						before closed-loop control will work. Pick your encoder type to see what's required.
						<HelpTip :href="DOCS.m569_6" text="M569.6 runs a calibration/tuning manoeuvre. The driver must already be in closed or assisted mode. These moves rotate the motor a few steps to a few revolutions." />
					</div>
					<v-select v-model="encoderType" :items="encoderTypes" item-title="title" item-value="value"
							  density="compact" variant="outlined" hide-details label="Encoder type (M569.1 T)" style="max-width: 360px" class="mb-2">
						<template #append><HelpTip :href="DOCS.m569_1" text="Set in config.g with M569.1 T: T1=linear composite, T2=quadrature motor shaft, T3=Duet3D magnetic. This only filters the calibration moves shown here — it doesn't change your config." /></template>
					</v-select>
					<v-alert type="info" variant="tonal" density="compact" class="mb-2">{{ encoderGuidance }}</v-alert>
					<v-list density="compact" class="py-0">
						<v-list-item v-for="c in calibrationMoves" :key="c.id">
							<template #title>
								{{ c.name }}
								<v-chip v-if="requiredMoveIds.includes(c.id)" size="x-small" color="primary" class="ml-1">required</v-chip>
								<v-chip v-else size="x-small" variant="tonal" class="ml-1">optional</v-chip>
							</template>
							<template #subtitle>{{ c.description }}</template>
							<template #append>
								<v-tooltip :text="`Sends ${buildCalibrationCommand(selectedDriver || 'P#.#', c.id)} — the motor will move.`" location="left">
									<template #activator="{ props: tip }">
										<v-btn v-bind="tip" size="small" variant="tonal" :disabled="!selectedDriver || currentMode === 'open'" @click="runCalibration(c)">Run</v-btn>
									</template>
								</v-tooltip>
							</template>
						</v-list-item>
					</v-list>
					<div v-if="currentMode === 'open'" class="text-caption text-warning mt-2">Switch to closed or assisted mode (step 2) before calibrating.</div>
				</v-card>
			</template>

			<!-- 4. Tune PID -->
			<template #item.4>
				<v-card flat>
					<div class="text-body-2 mb-3">
						Set the motor current to its final value and make sure the motor can spin freely (uncoupled —
						see the note above), then run <strong>Auto-tune</strong>. It tunes P, D and I from step jumps,
						then A and V from a short back-and-forth move. Manual term-by-term tuning is available below.
						<HelpTip :href="DOCS.tuning" text="Auto-tune cycles each term: P (rise time) → D (overshoot) → I (steady-state error) from step jumps, then A (accel) → V (velocity) from a G1 move. It captures after every change, converges when the response stops improving, and backs off on oscillation. Click for the full guide." />
					</div>

					<!-- Auto-tune -->
					<v-card variant="outlined" class="mb-3" :color="autoRunning ? 'primary' : undefined">
						<v-card-text>
							<div class="d-flex align-center flex-wrap ga-2">
								<v-btn color="primary" :disabled="!selectedDriver || autoRunning || recording" :loading="autoRunning" prepend-icon="mdi-auto-fix" @click="startAutoTune">
									Auto-tune (P → D → I → A → V)
								</v-btn>
								<v-btn v-if="autoRunning" color="error" variant="tonal" prepend-icon="mdi-stop" @click="abortAutoTune">Abort</v-btn>
								<HelpTip :href="DOCS.tuning" text="Fully automatic and bounded. P/D/I use step jumps; A/V use a back-and-forth move along the axis (skipped for extruders). Keep an emergency stop handy the first time." />
								<v-spacer />
								<span class="text-caption text-medium-emphasis">{{ autoStatus }}</span>
							</div>
							<div class="d-flex flex-wrap ga-1 mt-2">
								<v-chip v-for="t in pidSummary" :key="t.term" size="small"
										:color="autoRunning && wizardStep.term === t.term ? 'primary' : undefined"
										:variant="autoRunning && wizardStep.term === t.term ? 'flat' : 'tonal'">{{ t.term.toUpperCase() }} = {{ t.value }}</v-chip>
							</div>
							<div class="d-flex align-center flex-wrap ga-3 mt-2">
								<span class="text-caption text-medium-emphasis">A/V test move:</span>
								<v-text-field v-model.number="avDistance" type="number" label="Distance (mm)" density="compact" variant="outlined" hide-details style="max-width: 150px"><template #append-inner><HelpTip text="Length of the back-and-forth move used to tune A and V — long enough to reach steady speed. Default 50 mm." /></template></v-text-field>
								<v-text-field v-model.number="avFeed" type="number" label="Feed (mm/min)" density="compact" variant="outlined" hide-details style="max-width: 160px"><template #append-inner><HelpTip text="Speed of the A/V test move. Higher exercises the feed-forward terms more. Default 6000 mm/min (100 mm/s)." /></template></v-text-field>
							</div>
							<div v-if="autoLog.length" class="cl-autolog mt-2">
								<div v-for="(line, idx) in autoLog" :key="idx">{{ line }}</div>
							</div>
						</v-card-text>
					</v-card>

					<div v-if="!autoRunning" class="text-caption text-medium-emphasis mb-1">Manual tuning</div>
					<v-row v-if="!autoRunning" dense>
						<v-col cols="12" md="5">
							<v-card variant="outlined">
								<v-card-text>
									<div class="d-flex align-center mb-2">
										<v-btn size="small" variant="text" icon="mdi-chevron-left" :disabled="wizardIndex === 0" @click="wizardIndex--" />
										<div class="flex-grow-1 text-center text-subtitle-2">{{ wizardStep.title }} ({{ wizardIndex + 1 }}/{{ steps.length }})</div>
										<v-btn size="small" variant="text" icon="mdi-chevron-right" :disabled="wizardIndex === steps.length - 1" @click="wizardIndex++" />
									</div>
									<div class="text-caption mb-1"><strong>Goal:</strong> {{ wizardStep.goal }}</div>
									<div class="text-caption text-medium-emphasis mb-2">{{ wizardStep.instructions }}</div>
									<div class="d-flex ga-2 align-center mb-2">
										<v-btn size="small" color="info" :disabled="!selectedDriver || recording || autoRunning" :loading="recording" @click="runWizardCapture">
											<v-icon class="mr-1">mdi-record</v-icon> Run step &amp; analyse
										</v-btn>
										<v-btn v-if="wizardStep.term && wizardStep.defaultStart !== undefined" size="small" variant="text"
											   :disabled="!selectedDriver" @click="seedDefault">Set start ({{ wizardStep.defaultStart }})</v-btn>
										<HelpTip :href="DOCS.m569_5" text="Runs M569.5 with the step manoeuvre (V64): a 4 full-step jump so the controller's response can be measured. Recorded to a CSV and plotted below." />
									</div>
									<v-alert v-if="recommendation" :type="verdictType" variant="tonal" density="compact">
										{{ recommendation.message }}
										<template v-if="recommendation.suggested !== undefined" #append>
											<v-btn size="x-small" variant="text" @click="applySuggestion">Set {{ wizardStep.term?.toUpperCase() }}={{ recommendation.suggested }}</v-btn>
										</template>
									</v-alert>
								</v-card-text>
							</v-card>
						</v-col>

						<v-col cols="12" md="7">
							<v-card variant="outlined">
								<v-card-title class="py-2 text-subtitle-2 d-flex align-center">
									PID parameters
									<HelpTip class="ml-1" :href="DOCS.m569_1" text="M569.1 R=P (proportional), I (integral), D (derivative), V (velocity feed-forward), A (acceleration feed-forward). The wizard's suggestions write into these; Apply sends them to the driver." />
									<v-spacer />
									<v-btn size="x-small" variant="text" :disabled="!selectedDriver" @click="loadPid">Reload</v-btn>
								</v-card-title>
								<v-card-text>
									<v-row dense>
										<v-col cols="4"><v-text-field v-model.number="pid.p" type="number" label="P (R)" density="compact" variant="outlined" hide-details :class="{ 'cl-active-term': wizardStep.term === 'p' }" /></v-col>
										<v-col cols="4"><v-text-field v-model.number="pid.i" type="number" label="I" density="compact" variant="outlined" hide-details :class="{ 'cl-active-term': wizardStep.term === 'i' }" /></v-col>
										<v-col cols="4"><v-text-field v-model.number="pid.d" type="number" label="D" density="compact" variant="outlined" hide-details :class="{ 'cl-active-term': wizardStep.term === 'd' }" /></v-col>
										<v-col cols="6"><v-text-field v-model.number="pid.v" type="number" label="V (vel ff)" density="compact" variant="outlined" hide-details :class="{ 'cl-active-term': wizardStep.term === 'v' }" /></v-col>
										<v-col cols="6"><v-text-field v-model.number="pid.a" type="number" label="A (accel ff)" density="compact" variant="outlined" hide-details :class="{ 'cl-active-term': wizardStep.term === 'a' }" /></v-col>
									</v-row>
									<div class="d-flex ga-2 align-center mt-2">
										<v-btn size="small" color="primary" :disabled="!selectedDriver" :loading="applyingPid" @click="applyPid">Apply (M569.1)</v-btn>
										<span class="text-caption text-medium-emphasis text-truncate"><code>{{ pidPreview }}</code></span>
									</div>
								</v-card-text>
							</v-card>
						</v-col>
					</v-row>

					<v-expansion-panels v-if="!autoRunning" class="mt-3" variant="accordion">
						<v-expansion-panel>
							<v-expansion-panel-title>
								Advanced: manual capture
								<HelpTip class="ml-1" :href="DOCS.m569_5" text="For power users: record any combination of variables, at a chosen rate, during the step manoeuvre or a custom move. Useful for tuning A/V on a steady-speed G1 move." />
							</v-expansion-panel-title>
							<v-expansion-panel-text>
								<v-row dense>
									<v-col cols="6" sm="3"><v-text-field v-model.number="samples" type="number" label="Samples" density="compact" variant="outlined" hide-details /></v-col>
									<v-col cols="6" sm="3"><v-text-field v-model.number="sampleRate" type="number" label="Rate (/s, 0=max)" density="compact" variant="outlined" hide-details /></v-col>
									<v-col cols="12" sm="6">
										<v-radio-group v-model="moveMode" inline density="compact" hide-details>
											<v-radio label="Step manoeuvre" value="step" />
											<v-radio label="Custom move" value="custom" />
										</v-radio-group>
									</v-col>
								</v-row>
								<v-text-field v-if="moveMode === 'custom'" v-model="customMove" label="Move G-code" density="compact" variant="outlined" hide-details class="mb-2" placeholder="G91 G1 H2 X50 F6000 G90" />
								<div class="d-flex flex-wrap mb-1">
									<v-checkbox v-for="v in captureVariables" :key="v.key" v-model="recordKeys" :value="v.key" :label="v.header" density="compact" hide-details class="cl-var" />
								</div>
								<v-btn size="small" color="info" :disabled="!canRecord || recording || autoRunning" :loading="recording" @click="record()"><v-icon class="mr-1">mdi-record</v-icon> Record</v-btn>
								<div v-if="selectedDriver" class="text-caption text-medium-emphasis mt-1"><code>{{ capturePreview }}</code></div>
							</v-expansion-panel-text>
						</v-expansion-panel>
					</v-expansion-panels>
				</v-card>
			</template>

			<!-- 5. Test & save -->
			<template #item.5>
				<v-card flat>
					<div class="text-body-2 mb-3">
						Verify the tuning with a real move, then copy the tuned line into <code>config.g</code> (after your
						<code>M569</code>/<code>M906</code>/microstepping setup) and the mode + calibration lines into your homing file.
						<HelpTip :href="DOCS.tuning" text="RRF programs these registers itself from M569/M906/microstepping, so the M569.1 line must come AFTER that setup. The mode switch and calibration belong in the homing file so they run every power-on." />
					</div>

					<v-alert type="info" variant="tonal" density="compact" class="mb-3">
						<div class="text-subtitle-2 mb-1">What a well-tuned move looks like</div>
						<div class="text-body-2">
							Run a test move, then tick <strong>Current Error</strong> (and optionally Measured + Target Motor Steps) in the Plot panel:
							<ul class="mt-1">
								<li><strong>Current Error</strong> stays small and <strong>centred on zero</strong> — typically within a few encoder counts — with no steady drift away from zero. This is the single best indicator.</li>
								<li><strong>Measured</strong> tracks <strong>Target</strong> closely the whole move: it rises into the steady-speed section without lagging behind, and settles at the end with little or no overshoot or ringing.</li>
								<li>A little high-frequency “fuzz” on the error is normal (encoder resolution); a slow bow away from zero, a big spike at the start/stop, or growing oscillation are not.</li>
							</ul>
							<div class="mt-1 text-medium-emphasis">
								Bad signs: the error drifts off zero (raise <strong>I</strong>), spikes during accel/decel (raise <strong>A</strong>), sits offset during steady speed (raise <strong>V</strong>), overshoots the target (raise <strong>D</strong>), or oscillates/“sings” (lower <strong>P</strong>, or <strong>D</strong> if it’s the high-frequency kind).
							</div>
						</div>
						<HelpTip class="ml-1" :href="DOCS.tuning" text="The wiki shows annotated example plots of good vs poorly-tuned responses. The error should hover around zero at the encoder's resolution; if it's an order of magnitude larger than the encoder step, keep tuning." />
					</v-alert>

					<v-row dense>
						<v-col cols="12" md="6">
							<v-card variant="outlined" class="mb-2">
								<v-card-title class="py-2 text-subtitle-2">Test move</v-card-title>
								<v-card-text>
									<v-text-field v-model="customMove" label="Test move G-code" density="compact" variant="outlined" hide-details class="mb-2" placeholder="G91 G1 H2 X50 F6000 G90">
										<template #append-inner><HelpTip text="A real G1 move (recorded while it runs). Watch Current Error in the plot — a well-tuned drive keeps it small and centred on zero." /></template>
									</v-text-field>
									<v-btn size="small" color="info" :disabled="!selectedDriver || recording" :loading="recording" @click="runTestMove"><v-icon class="mr-1">mdi-record</v-icon> Run test move</v-btn>
								</v-card-text>
							</v-card>
						</v-col>
						<v-col cols="12" md="6">
							<v-card variant="outlined" class="mb-2">
								<v-card-title class="py-2 text-subtitle-2 d-flex align-center">
									config.g block
									<v-spacer />
									<v-btn size="x-small" variant="text" prepend-icon="mdi-content-copy" :disabled="!selectedDriver" @click="copyConfig">Copy</v-btn>
								</v-card-title>
								<v-card-text>
									<pre class="cl-config">{{ configBlock }}</pre>
								</v-card-text>
							</v-card>
						</v-col>
					</v-row>
				</v-card>
			</template>
		</v-stepper>

		<!-- Persistent results: chart + analysis from the most recent capture -->
		<v-row dense class="mt-1">
			<v-col cols="12" md="9">
				<CaptureChart :capture="capture" :overlay="overlayCapture" :selected-keys="viewKeys" :sample-rate="sampleRate" :raw-text="rawText" />
			</v-col>
			<v-col cols="12" md="3">
				<v-card class="mb-2">
					<v-card-title class="py-2 text-subtitle-1 d-flex align-center">
						Analysis
						<HelpTip class="ml-1" text="Computed automatically from the last step capture: rise time (10–90%), overshoot beyond target, settling time, and the residual steady-state error. The wizard uses these to make its recommendations." />
					</v-card-title>
					<v-card-text>
						<div v-if="!metrics" class="text-medium-emphasis text-caption">Run a step to see rise time, overshoot and steady-state error.</div>
						<v-table v-else density="compact">
							<tbody>
								<tr><td>Step size</td><td>{{ metrics.stepSize.toFixed(2) }} steps</td></tr>
								<tr><td>Rise time</td><td>{{ metrics.riseTime === null ? "—" : (metrics.riseTime * 1000).toFixed(0) + " ms" }}</td></tr>
								<tr><td>Overshoot</td><td>{{ metrics.overshootPct.toFixed(0) }} %</td></tr>
								<tr><td>Settling time</td><td>{{ metrics.settlingTime === null ? "—" : (metrics.settlingTime * 1000).toFixed(0) + " ms" }}</td></tr>
								<tr><td>Steady-state error</td><td>{{ metrics.steadyStateError.toFixed(3) }} steps</td></tr>
								<tr><td>Peak / RMS error</td><td>{{ metrics.peakError.toFixed(3) }} / {{ metrics.rmsError.toFixed(3) }}</td></tr>
							</tbody>
						</v-table>
					</v-card-text>
				</v-card>
				<v-card>
					<v-card-title class="py-2 text-subtitle-1 d-flex align-center">
						Plot
						<HelpTip class="ml-1" text="Choose which recorded variables to draw. Use Overlay to freeze the current trace and compare it against your next capture." />
						<v-spacer />
						<v-btn size="x-small" variant="text" :disabled="!capture || !!overlayCapture" @click="pinOverlay">Overlay</v-btn>
						<v-btn v-if="overlayCapture" size="x-small" variant="text" @click="overlayCapture = null">Clear</v-btn>
					</v-card-title>
					<v-card-text>
						<div v-if="availableViewVars.length === 0" class="text-medium-emphasis text-caption">No capture loaded yet.</div>
						<div class="d-flex flex-wrap">
							<v-checkbox v-for="v in availableViewVars" :key="v.key" v-model="viewKeys" :value="v.key" :label="v.header" density="compact" hide-details class="cl-var" />
						</div>
					</v-card-text>
				</v-card>
			</v-col>
		</v-row>

		<v-dialog v-model="confirmOpen" max-width="460">
			<v-card>
				<v-card-title>Confirm movement</v-card-title>
				<v-card-text>
					This will move the selected driver and may not respect endstops. Make sure the axis is in a safe position (usually the centre) with room to move.
					<div class="text-caption text-medium-emphasis mt-2"><code>{{ confirmCommand }}</code></div>
				</v-card-text>
				<v-card-actions>
					<v-spacer />
					<v-btn variant="text" @click="confirmOpen = false">Cancel</v-btn>
					<v-btn color="primary" @click="confirmProceed">Proceed</v-btn>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</v-container>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";

import { useMachineStore } from "@/stores/machine";
import { LogLevel, useUiStore } from "@/stores/ui";

import { HelpTip } from "dwc-plugin-runtime";

import CaptureChart from "./CaptureChart.vue";
import { CAPTURE_DIR, DOCS, LS_STATE } from "../model/constants";
import {
	buildCalibrationCommand, buildCaptureCommand, buildModeCommand, buildPidCommand,
	CALIBRATION_MOVES, CAPTURE_VARIABLES, DEFAULT_MODE_D, ENCODER_TYPES, MODE_LABELS,
	parsePidReply, type CalibrationMove, type EncoderType, type LoopMode, type PidConfig,
} from "../model/m569";
import { parseCapture, type ParsedCapture } from "../model/csv";
import { analyzeCapture, analyzeMove, type MoveMetrics, type StepMetrics } from "../model/analysis";
import { WIZARD_STEPS, type Recommendation } from "../model/wizard";
import { AUTOTUNE_FF_SEQUENCE, AUTOTUNE_SEQUENCE, describeMetrics, describeMove, type Attempt, type MoveAttempt, type MoveTermStrategy, type TermStrategy } from "../model/autotune";
import { applying, applyUpdateNow, dismissCurrentUpdate, pendingReload, updateState } from "../model/updateCheck";

/* eslint-disable @typescript-eslint/no-explicit-any */

const machineStore = useMachineStore();
const uiStore = useUiStore();

const captureVariables = CAPTURE_VARIABLES;
const encoderTypes = ENCODER_TYPES;
const steps = WIZARD_STEPS;
const modeList = (Object.keys(MODE_LABELS) as Array<LoopMode>).map((value) => ({ value, label: MODE_LABELS[value] }));
const modeHelp: Record<LoopMode, string> = {
	open: "Normal stepper operation with no feedback. Use this for homing, then switch to closed/assisted.",
	assisted: "Runs open-loop but uses the encoder to assist — correcting and preventing lost steps. Simpler to tune (P≈200, D/I usually 0).",
	closed: "Full closed-loop PID position control from the encoder. Best accuracy; needs the PID terms tuned below.",
};
const stepTitles = ["1. Driver", "2. Loop mode", "3. Calibrate", "4. Tune PID", "5. Test & save"];

// Persisted UI state — restored on mount so navigating away and back keeps your place.
interface SavedState {
	step?: number; wizardIndex?: number; selectedDriver?: string | null; currentMode?: LoopMode | null;
	encoderType?: EncoderType; modeD?: Partial<typeof DEFAULT_MODE_D>; pid?: Partial<PidConfig>;
	samples?: number; sampleRate?: number; moveMode?: "step" | "custom"; customMove?: string;
	recordKeys?: Array<string>; viewKeys?: Array<string>; avDistance?: number; avFeed?: number;
}
function loadState(): SavedState {
	try { return JSON.parse(localStorage.getItem(LS_STATE) ?? "{}") as SavedState; } catch { return {}; }
}
const saved = loadState();

const step = ref(saved.step ?? 1);
const selectedDriver = ref<string | null>(saved.selectedDriver ?? null);
const currentMode = ref<LoopMode | null>(saved.currentMode ?? null);
const encoderType = ref<EncoderType>(saved.encoderType ?? 2);
const modeD = reactive({ ...DEFAULT_MODE_D, ...(saved.modeD ?? {}) });
const pid = reactive<PidConfig>({ p: 100, i: 0, d: 0, v: 0, a: 0, warn: null, err: null, ...(saved.pid ?? {}) });
const applyingPid = ref(false);

const samples = ref(saved.samples ?? 2000);
const sampleRate = ref(saved.sampleRate ?? 2000);
const moveMode = ref<"step" | "custom">(saved.moveMode ?? "step");
const customMove = ref(saved.customMove ?? "G91 G1 H2 X50 F6000 G90");
const recordKeys = ref<Array<string>>(saved.recordKeys ?? ["measuredMotorSteps", "targetMotorSteps", "currentError", "pidPTerm"]);
const recording = ref(false);

const capture = ref<ParsedCapture | null>(null);
const overlayCapture = ref<ParsedCapture | null>(null);
const rawText = ref<string>("");
const metrics = ref<StepMetrics | null>(null);
const viewKeys = ref<Array<string>>(saved.viewKeys ?? ["measuredMotorSteps", "targetMotorSteps", "currentError"]);

const wizardIndex = ref(saved.wizardIndex ?? 0);
const recommendation = ref<Recommendation | null>(null);

// Save the lightweight selections (not the captured CSV) whenever they change, debounced.
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persistState(): void {
	if (saveTimer) { clearTimeout(saveTimer); }
	saveTimer = setTimeout(() => {
		try {
			localStorage.setItem(LS_STATE, JSON.stringify({
				step: step.value, wizardIndex: wizardIndex.value, selectedDriver: selectedDriver.value,
				currentMode: currentMode.value, encoderType: encoderType.value, modeD: { ...modeD }, pid: { ...pid },
				samples: samples.value, sampleRate: sampleRate.value, moveMode: moveMode.value,
				customMove: customMove.value, recordKeys: recordKeys.value, viewKeys: viewKeys.value,
				avDistance: avDistance.value, avFeed: avFeed.value,
			} satisfies SavedState));
		} catch { /* storage unavailable */ }
	}, 300);
}
watch([step, wizardIndex, selectedDriver, currentMode, encoderType, modeD, pid, samples, sampleRate, moveMode, customMove, recordKeys, viewKeys],
	persistState, { deep: true });

// --- Auto-tune ---
const autoRunning = ref(false);
const autoCancel = ref(false);
const autoStatus = ref("");
const autoLog = ref<Array<string>>([]);
const avDistance = ref(saved.avDistance ?? 50);   // mm — A/V test move length
const avFeed = ref(saved.avFeed ?? 6000);          // mm/min — A/V test move feedrate
watch([avDistance, avFeed], persistState);

const confirmOpen = ref(false);
const confirmCommand = ref("");
let confirmAction: (() => Promise<void>) | null = null;

// --- Update banner ---
const updateBanner = computed(() => {
	const s = updateState.value;
	return s?.updateAvailable ? `Closed Loop Tuning v${s.latestVersion} is available.` : "";
});
function reloadPage(): void { window.location.reload(); }

// --- Drivers from the object model ---
interface DriverEntry { name: string; value: string }
const drivers = computed<Array<DriverEntry>>(() => {
	const model = machineStore.model as any;
	const boards = model.boards ?? [];
	const hasCl = (boardAddr: string) => boards.some((b: any) => b && b.canAddress === parseInt(boardAddr) && b.closedLoop != null);
	const out: Array<DriverEntry> = [];
	for (const axis of model.move?.axes ?? []) {
		for (const drv of axis.drivers ?? []) {
			const id = `${drv.board}.${drv.driver}`;
			if (hasCl(String(drv.board))) { out.push({ name: `${axis.letter} axis (driver ${id})`, value: id }); }
		}
	}
	(model.move?.extruders ?? []).forEach((ex: any, idx: number) => {
		const drv = ex?.driver;
		if (!drv) { return; }
		const id = `${drv.board}.${drv.driver}`;
		if (hasCl(String(drv.board))) { out.push({ name: `Extruder ${idx} (driver ${id})`, value: id }); }
	});
	return out;
});

const selectedBoard = computed<any>(() => {
	if (!selectedDriver.value) { return null; }
	const addr = parseInt(selectedDriver.value.split(".")[0]);
	return (machineStore.model as any).boards?.find((b: any) => b && b.canAddress === addr) ?? null;
});

/** Axis letter the selected driver belongs to (null for extruders / unknown — A/V can't be auto-tuned then). */
function axisLetterForDriver(): string | null {
	if (!selectedDriver.value) { return null; }
	const ax = (machineStore.model as any).move?.axes?.find((a: any) => (a.drivers ?? []).some((d: any) => `${d.board}.${d.driver}` === selectedDriver.value));
	return ax?.letter ?? null;
}

// --- Mode ---
async function setMode(mode: LoopMode): Promise<void> {
	if (!selectedDriver.value) { return; }
	await send(buildModeCommand(selectedDriver.value, mode, modeD));
	currentMode.value = mode;
}

// --- Calibration ---
const requiredMoveIds = computed<Array<number>>(() => {
	switch (encoderType.value) {
		case 2: return [1];        // quadrature shaft: polarity/zero every power-on
		case 3: return [2];        // magnetic: calibration once
		case 1: return [2, 1];     // linear composite: magnetic cal then polarity/zero, once
		default: return [];
	}
});
const calibrationMoves = computed<Array<CalibrationMove>>(() =>
	CALIBRATION_MOVES.filter((c) => c.encoders.length === 0 || c.encoders.includes(encoderType.value)));
const encoderGuidance = computed(() => {
	switch (encoderType.value) {
		case 2: return "Quadrature shaft encoder: run Polarity detection & zeroing (V1) after every power-on — put it in your homing file.";
		case 3: return "Duet3D magnetic encoder: run Magnetic encoder calibration (V2) once. It's stored in the 1HCL flash and survives power cycles.";
		case 1: return "Linear composite encoder: run Magnetic encoder calibration (V2) then Polarity & zeroing (V1) once. Stored in flash.";
		default: return "No encoder selected. Set the encoder type in config.g with M569.1 T (T1/T2/T3) and pick it here.";
	}
});
function runCalibration(c: CalibrationMove): void {
	if (!selectedDriver.value) { return; }
	askConfirm(buildCalibrationCommand(selectedDriver.value, c.id), async () => { await send(buildCalibrationCommand(selectedDriver.value!, c.id)); });
}

// --- PID ---
const pidPreview = computed(() => selectedDriver.value ? buildPidCommand(selectedDriver.value, pid) : "");
async function loadPid(): Promise<void> {
	if (!selectedDriver.value) { return; }
	try {
		const reply = await machineStore.sendCode(`M569.1 P${selectedDriver.value}`, false, false);
		Object.assign(pid, parsePidReply(reply));
	} catch (e) { console.warn("[ClosedLoopTuning] loadPid failed", e); }
}
async function applyPid(): Promise<void> {
	if (!selectedDriver.value) { return; }
	applyingPid.value = true;
	try { await send(buildPidCommand(selectedDriver.value, pid)); }
	finally { applyingPid.value = false; }
}

// --- Recording ---
const canRecord = computed(() => !!selectedDriver.value && recordKeys.value.length > 0);
const capturePreview = computed(() => selectedDriver.value ? buildCaptureCommand(captureOptions()) : "");

function captureOptions() {
	return {
		driver: selectedDriver.value ?? "",
		samples: samples.value,
		activate: (moveMode.value === "custom" ? 1 : 0) as 0 | 1,
		rate: sampleRate.value,
		variables: recordKeys.value.map((k) => CAPTURE_VARIABLES.find((v) => v.key === k)?.id ?? 0),
		manoeuvre: moveMode.value === "step" ? 64 : 0,
		move: moveMode.value === "custom" ? (customMove.value || undefined) : undefined,
	};
}

let runsAtStart = -1;
async function record(): Promise<void> {
	if (!canRecord.value) { return; }
	if (moveMode.value === "custom" && !customMove.value) {
		uiStore.makeNotification(LogLevel.warning, "Closed Loop Tuning", "Enter a move before recording.");
		return;
	}
	runsAtStart = selectedBoard.value?.closedLoop?.runs ?? -1;
	recording.value = true;
	try {
		const reply = await machineStore.sendCode(buildCaptureCommand(captureOptions()), false, false);
		if (reply && reply.startsWith("Error:")) {
			uiStore.makeNotification(LogLevel.error, "Closed Loop Tuning", reply);
			recording.value = false;
		}
	} catch (e) {
		console.warn("[ClosedLoopTuning] record failed", e);
		recording.value = false;
	}
}

watch(() => selectedBoard.value?.closedLoop?.runs, async (runs) => {
	if (!recording.value || runs == null || runs === runsAtStart) { return; }
	await loadLatestCapture();
	recording.value = false;
});

/** Load the newest capture CSV into the chart; returns the parsed capture (no analysis). */
async function loadLatestCsv(): Promise<ParsedCapture | null> {
	try {
		const list = await machineStore.getFileList(CAPTURE_DIR);
		const files = list.filter((f: any) => !f.isDirectory && f.name.endsWith(".csv"))
			.sort((a: any, b: any) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
		if (files.length === 0) { return null; }
		const text = await (machineStore as any).download({ filename: `${CAPTURE_DIR}/${files[0].name}`, type: "text" }, false, false, false) as string;
		rawText.value = text;
		capture.value = parseCapture(text);
		return capture.value;
	} catch (e) { console.warn("[ClosedLoopTuning] loadLatestCsv failed", e); return null; }
}

/** Manual record path: load newest CSV and analyse it as a step response. */
async function loadLatestCapture(): Promise<void> {
	const c = await loadLatestCsv();
	if (c) { metrics.value = analyzeCapture(c, sampleRate.value); }
}

const availableViewVars = computed(() => CAPTURE_VARIABLES.filter((v) => capture.value && capture.value.columns[v.header]));
function pinOverlay(): void { overlayCapture.value = capture.value; }

// --- Wizard ---
const wizardStep = computed(() => steps[wizardIndex.value]);
const pidSummary = computed(() => (["p", "d", "i", "v", "a"] as const).map((term) => ({ term, value: (pid as Record<string, number>)[term] })));
const verdictType = computed(() => {
	switch (recommendation.value?.verdict) {
		case "accept": return "success";
		case "decrease": return "warning";
		default: return "info";
	}
});
watch(wizardIndex, () => { recommendation.value = null; });
function seedDefault(): void {
	const t = wizardStep.value.term;
	if (t && wizardStep.value.defaultStart !== undefined) { (pid as any)[t] = wizardStep.value.defaultStart; void applyPid(); }
}
async function runWizardCapture(): Promise<void> {
	moveMode.value = "step";
	recordKeys.value = Array.from(new Set([...wizardStep.value.recordKeys]));
	await record();
}
watch(metrics, (m) => {
	const term = wizardStep.value.term;
	if (!term) { return; }
	recommendation.value = wizardStep.value.recommend(m, (pid as any)[term] ?? 0);
});
function applySuggestion(): void {
	const term = wizardStep.value.term;
	if (term && recommendation.value?.suggested !== undefined) {
		(pid as any)[term] = recommendation.value.suggested;
		void applyPid();
	}
}

// --- Auto-tune: run a step capture and resolve when its analysis is ready ---
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait for the board's closed-loop run counter to advance (capture finished), or time out. */
async function waitForRuns(startRuns: number, timeoutMs: number): Promise<boolean> {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		if (autoCancel.value) { return false; }
		const r = selectedBoard.value?.closedLoop?.runs;
		if (r != null && r !== startRuns) { return true; }
		await delay(200);
	}
	return false;
}

const varIds = (keys: Array<string>) => keys.map((k) => CAPTURE_VARIABLES.find((v) => v.key === k)?.id ?? 0);

/** Run a capture command (built directly, not from the user's manual settings), wait for it to finish, load the CSV. */
async function runCapture(opts: Parameters<typeof buildCaptureCommand>[0]): Promise<ParsedCapture | null> {
	const startRuns = selectedBoard.value?.closedLoop?.runs ?? -1;
	const reply = await machineStore.sendCode(buildCaptureCommand(opts), false, false);
	if (reply && reply.startsWith("Error:")) {
		uiStore.makeNotification(LogLevel.error, "Closed Loop Tuning", reply);
		log(`Firmware rejected the capture: ${reply}`);
		return null;
	}
	const captureMs = opts.rate > 0 ? (opts.samples / opts.rate) * 1000 : 4000;
	if (!(await waitForRuns(startRuns, captureMs + 8000))) { log("Timed out waiting for the capture to finish — is the driver calibrated and in closed loop?"); return null; }
	await delay(300); // let the CSV finish writing
	return loadLatestCsv();
}

/** Step-manoeuvre capture → step metrics (for P/D/I). */
async function captureStep(): Promise<StepMetrics | null> {
	const c = await runCapture({ driver: selectedDriver.value ?? "", samples: samples.value, activate: 0, rate: sampleRate.value, variables: varIds(["measuredMotorSteps", "targetMotorSteps", "currentError", "pidPTerm"]), manoeuvre: 64 });
	if (!c) { return null; }
	metrics.value = analyzeCapture(c, sampleRate.value);
	return metrics.value;
}

/** G1-move capture → move metrics (for A/V). Captures the outward move, then returns the axis to start. */
async function captureMove(): Promise<MoveMetrics | null> {
	const axis = axisLetterForDriver();
	if (!axis) { uiStore.makeNotification(LogLevel.warning, "Closed Loop Tuning", "A/V tuning needs the driver's axis — skipped."); return null; }
	viewKeys.value = ["pidPTerm", "targetMotorSteps"];
	const c = await runCapture({ driver: selectedDriver.value ?? "", samples: samples.value, activate: 1, rate: sampleRate.value, variables: varIds(["targetMotorSteps", "pidPTerm", "measuredMotorSteps"]), manoeuvre: 0, move: `G91 G1 H2 ${axis}${avDistance.value} F${avFeed.value} G90` });
	try { await machineStore.sendCode(`G91 G1 H2 ${axis}-${avDistance.value} F${avFeed.value} G90`, false, false); } catch { /* ignore return-move error */ }
	if (!c) { return null; }
	return analyzeMove(c, sampleRate.value);
}

function log(line: string): void { autoLog.value = [...autoLog.value, line].slice(-40); }

/** Drive one term to convergence using its strategy. Returns false to abort the whole run. */
async function autoTuneTerm(strategy: TermStrategy): Promise<boolean> {
	let value = strategy.start;
	const attempts: Array<Attempt> = [];
	for (let k = 0; k <= strategy.maxAttempts; k++) {
		if (autoCancel.value) { return false; }
		(pid as any)[strategy.term] = value;
		await applyPid();
		await delay(400); // settle
		autoStatus.value = `${strategy.label}: testing ${strategy.term.toUpperCase()}=${value}…`;
		const m = await captureStep();
		if (!m) { log(`${strategy.label}: capture failed — aborting.`); return false; }
		attempts.push({ value, metrics: m });
		log(`${strategy.label}: ${strategy.term.toUpperCase()}=${value} → ${describeMetrics(m)}`);
		const d = strategy.decide(attempts);
		if (d.kind === "fail") { log(`${strategy.label}: ${d.reason}`); return false; }
		if (d.kind === "accept") {
			(pid as any)[strategy.term] = d.value;
			await applyPid();
			log(`${strategy.label}: ✓ ${d.note}`);
			return true;
		}
		value = d.value;
	}
	return true;
}

/** Drive a feed-forward term (A/V) to convergence using a G1-move capture. */
async function autoTuneMoveTerm(strategy: MoveTermStrategy): Promise<boolean> {
	let value = strategy.start;
	const attempts: Array<MoveAttempt> = [];
	for (let k = 0; k <= strategy.maxAttempts; k++) {
		if (autoCancel.value) { return false; }
		(pid as any)[strategy.term] = value;
		await applyPid();
		await delay(400);
		autoStatus.value = `${strategy.label}: testing ${strategy.term.toUpperCase()}=${value}…`;
		const m = await captureMove();
		if (!m) { log(`${strategy.label}: capture failed — skipping.`); return false; }
		attempts.push({ value, metrics: m });
		log(`${strategy.label}: ${strategy.term.toUpperCase()}=${value} → ${describeMove(m)}`);
		const d = strategy.decide(attempts);
		if (d.kind === "fail") { log(`${strategy.label}: ${d.reason}`); return false; }
		if (d.kind === "accept") { (pid as any)[strategy.term] = d.value; await applyPid(); log(`${strategy.label}: ✓ ${d.note}`); return true; }
		value = d.value;
	}
	return true;
}

function startAutoTune(): void {
	if (!selectedDriver.value) { return; }
	const hasAxis = !!axisLetterForDriver();
	const msg = hasAxis
		? "Auto-tune will repeatedly move the driver: short step jumps to tune P/D/I, then back-and-forth moves along the axis to tune A/V"
		: "Auto-tune will repeatedly move the driver with short step jumps to tune P/D/I (A/V need an axis and will be skipped)";
	askConfirm(msg, runAutoTune);
}

async function runAutoTune(): Promise<void> {
	autoRunning.value = true;
	autoCancel.value = false;
	autoLog.value = [];
	viewKeys.value = ["measuredMotorSteps", "targetMotorSteps", "currentError"];
	try {
		// The step manoeuvre only moves in closed/assisted loop — the board may have reverted to open
		// loop (e.g. after a reboot) even if the plugin remembers otherwise, so (re)assert the mode.
		const mode: LoopMode = currentMode.value === "assisted" ? "assisted" : "closed";
		log(`Ensuring ${MODE_LABELS[mode]} — sending ${buildModeCommand(selectedDriver.value ?? "", mode, modeD)}`);
		await send(buildModeCommand(selectedDriver.value ?? "", mode, modeD));
		currentMode.value = mode;
		await delay(600);

		// Phase 1 — P/D/I from the step response. Zero the other terms first so P is measured alone.
		pid.i = 0; pid.d = 0; pid.v = 0; pid.a = 0;
		await applyPid();
		let ok = true;
		for (const strategy of AUTOTUNE_SEQUENCE) {
			wizardIndex.value = WIZARD_STEPS.findIndex((s) => s.term === strategy.term);
			if (autoCancel.value) { ok = false; break; }
			if (!(await autoTuneTerm(strategy))) { ok = false; break; }
		}
		// Phase 2 — A/V feed-forward from a G1 move (best-effort; needs an axis).
		if (ok && !autoCancel.value) {
			if (axisLetterForDriver()) {
				log("Tuning A/V on a moving axis…");
				for (const strategy of AUTOTUNE_FF_SEQUENCE) {
					wizardIndex.value = WIZARD_STEPS.findIndex((s) => s.term === strategy.term);
					if (autoCancel.value) { break; }
					await autoTuneMoveTerm(strategy); // don't fail the whole run if A/V can't converge
				}
			} else {
				log("A/V skipped — this driver has no axis (extruder?).");
			}
		}
		autoStatus.value = autoCancel.value
			? "Auto-tune aborted."
			: `Auto-tune complete — P=${pid.p} D=${pid.d} I=${pid.i} A=${pid.a} V=${pid.v}.`;
		if (!autoCancel.value) {
			uiStore.makeNotification(LogLevel.success, "Closed Loop Tuning", autoStatus.value + " Review the plot, then save to config.g.");
		}
	} catch (e) {
		console.warn("[ClosedLoopTuning] auto-tune failed", e);
		autoStatus.value = "Auto-tune stopped (see console).";
	} finally {
		autoRunning.value = false;
	}
}

function abortAutoTune(): void { autoCancel.value = true; autoStatus.value = "Stopping after this capture…"; }

// --- Test & save ---
async function runTestMove(): Promise<void> {
	moveMode.value = "custom";
	recordKeys.value = ["measuredMotorSteps", "targetMotorSteps", "currentError"];
	viewKeys.value = ["currentError"];
	await record();
}
const configBlock = computed(() => {
	const id = selectedDriver.value ?? "#.#";
	const lines = [
		`; --- Closed-loop tuning for driver ${id} ---`,
		`; Put this in config.g AFTER your M569 / M906 / microstepping setup:`,
		buildPidCommand(id, pid),
		"",
		`; Put this in the homing file, after homing in open loop and moving to a safe spot:`,
		`${buildModeCommand(id, currentMode.value === "assisted" ? "assisted" : "closed", modeD)}     ; ${currentMode.value === "assisted" ? "assisted open loop" : "closed loop"}`,
	];
	for (const mid of requiredMoveIds.value) {
		const move = CALIBRATION_MOVES.find((c) => c.id === mid);
		lines.push(`${buildCalibrationCommand(id, mid)}        ; ${move?.name ?? "calibration"}`);
	}
	return lines.join("\n");
});
async function copyConfig(): Promise<void> {
	try {
		await navigator.clipboard.writeText(configBlock.value);
		uiStore.makeNotification(LogLevel.success, "Closed Loop Tuning", "config.g block copied to clipboard.");
	} catch {
		uiStore.makeNotification(LogLevel.warning, "Closed Loop Tuning", "Couldn't access the clipboard — select and copy the block manually.");
	}
}

// --- Shared confirm + send ---
function askConfirm(command: string, action: () => Promise<void>): void {
	confirmCommand.value = command;
	confirmAction = action;
	confirmOpen.value = true;
}
async function confirmProceed(): Promise<void> {
	confirmOpen.value = false;
	const action = confirmAction;
	confirmAction = null;
	if (action) { await action(); }
}
async function send(code: string): Promise<void> {
	try {
		const reply = await machineStore.sendCode(code, false, true);
		if (reply && reply.startsWith("Error:")) {
			uiStore.makeNotification(LogLevel.error, "Closed Loop Tuning", reply);
		}
	} catch (e) { console.warn("[ClosedLoopTuning] send failed", code, e); }
}

watch(selectedDriver, (d) => { if (d) { void loadPid(); } });
</script>

<style scoped>
.cl-var {
	flex: 0 0 50%;
}
:deep(.cl-var .v-label) {
	font-size: 0.8rem;
}
.cl-config {
	white-space: pre-wrap;
	font-size: 0.78rem;
	background: rgba(var(--v-theme-on-surface), 0.05);
	padding: 8px;
	border-radius: 4px;
}
:deep(.cl-active-term .v-field) {
	outline: 2px solid rgb(var(--v-theme-primary));
	border-radius: 4px;
}
.cl-autolog {
	max-height: 140px;
	overflow-y: auto;
	font-family: monospace;
	font-size: 0.74rem;
	line-height: 1.35;
	background: rgba(var(--v-theme-on-surface), 0.05);
	padding: 6px 8px;
	border-radius: 4px;
}
</style>
