<!--
  DWC 3.6 (Vue 2.7 / Vuetify 2) counterpart of ../ui37/ClosedLoopTuning.vue.

  This file is TEMPLATE ONLY. All state and behaviour — including the travel-limit / CoreXY coupling
  safety gate — comes from ../core/useClosedLoopTuning, shared verbatim with the 3.7 page, so tuning
  behaviour cannot drift between the two generations. Change behaviour there; change appearance here.

  What differs from the 3.7 template, and only this, is Vuetify 2's markup (translation table in
  docs/PLAN-dwc36-backport.md §6): v-stepper's structural rewrite into header/items/content,
  item-title -> item-text, density="compact" -> dense, variant="outlined" -> outlined, no "tonal"
  variant, v-table -> v-simple-table, #append-inner -> #append, and list items rewrapped in
  v-list-item-content / -icon / -action.
-->
<template>
	<v-container fluid class="pa-2">
		<v-alert v-if="updateBanner" type="info" text dense class="mb-3">
			<div class="d-flex align-center">
				<span>{{ updateBanner }}</span>
				<v-spacer />
				<v-btn v-if="!pendingReload" text small :loading="applying" @click="applyUpdateNow">{{ $t("plugins.closedLoopTuning.updates.apply") }}</v-btn>
				<v-btn v-if="pendingReload" text small @click="reloadPage">{{ $t("plugins.closedLoopTuning.updates.reload") }}</v-btn>
				<v-btn text small @click="dismissCurrentUpdate">{{ $t("plugins.closedLoopTuning.updates.dismiss") }}</v-btn>
			</div>
		</v-alert>

		<v-alert v-if="drivers.length === 0" type="warning" text dense class="mb-3">
			No closed-loop drivers found. Connect a board with closed-loop support (a Duet 3 1HCL / M23CL, or any
			other RRF board reporting closed-loop driver telemetry) configured for an axis or extruder.
		</v-alert>

		<v-alert type="warning" text dense class="mb-3" icon="mdi-axis-arrow">
			<strong>Tune with the axis loaded — coupled to the belt/leadscrew, under real load.</strong>
			Home the axis first: tuning moves ignore endstops and soft limits, so the plugin can only keep them
			off the frame if it knows where the axis actually is. Before each move it centres the axis
			(see the "Safety margin" setting below) and clamps the move to stay inside that margin of the
			travel limits — but an unhomed axis, or one whose limits the machine hasn't reported, isn't protected
			at all. Keep an emergency stop within reach the first time.
		</v-alert>

		<div class="d-flex align-center mb-2">
			<v-icon class="mr-2">mdi-chart-bell-curve-cumulative</v-icon>
			<span class="text-subtitle-1">Closed Loop Tuning</span>
			<HelpTip class="ml-1" :href="DOCS.tuning"
					 text="Follow the steps below in order: pick the driver, switch to closed/assisted mode, calibrate the encoder, tune the PID terms one at a time using the step response, then test and save. Click for the full closed-loop tuning guide." />
			<v-spacer />
			<v-chip v-if="selectedDriver" small class="mr-2">Driver {{ selectedDriver }}</v-chip>
			<v-chip v-if="currentMode" small :color="currentMode === 'open' ? 'grey' : 'success'">{{ MODE_LABELS[currentMode] }}</v-chip>
			<v-tooltip bottom>
				<template #activator="{ on, attrs }">
					<v-btn v-bind="attrs" v-on="on" icon text small class="ml-1" @click="aboutOpen = true"><v-icon small>mdi-information-outline</v-icon></v-btn>
				</template>
				<span>About, updates &amp; diagnostics</span>
			</v-tooltip>
		</div>

		<AboutDialog v-model="aboutOpen" plugin-id="ClosedLoopTuning" title="Closed Loop Tuning"
					 :description="aboutDescription" :model="host.model()"
					 repo="https://github.com/jaysuk/ClosedLoopTuningPlugin"
					 :docs-url="DOCS.tuning" docs-label="Duet closed-loop tuning guide"
					 :update-available="updateState?.updateAvailable ?? false" :latest-version="updateState?.latestVersion"
					 :checking="checking" :applying="applying" :pending-reload="pendingReload" :auto-check="autoCheck"
					 :extra-actions="aboutExtraActions"
					 @check-update="onCheckUpdate" @apply-update="applyUpdateNow" @toggle-auto-check="onToggleAutoCheck" />

		<v-stepper v-model="step">
			<v-stepper-header>
				<template v-for="(title, idx) in stepTitles">
					<v-stepper-step :key="`step-${idx}`" :step="idx + 1" editable>{{ title }}</v-stepper-step>
					<v-divider v-if="idx < stepTitles.length - 1" :key="`div-${idx}`" />
				</template>
			</v-stepper-header>
			<v-stepper-items>
				<!-- 1. Driver -->
				<v-stepper-content step="1">
					<v-card flat>
						<div class="text-body-2 mb-3">
							Pick the closed-loop driver you want to tune. Tuning moves only this driver, so re-home the axis afterwards.
							<HelpTip text="The list shows every axis/extruder driver on a board that reports closed-loop support — a Duet3D closed-loop board (1HCL / M23CL) or any other RRF board exposing closed-loop driver telemetry. Only one driver can be tuned at a time." />
						</div>
						<v-select v-model="selectedDriver" :items="drivers" item-text="name" item-value="value"
								  dense outlined hide-details label="Closed-loop driver" style="max-width: 480px" />
						<div v-if="selectedDriver" class="text-caption text--secondary mt-3">
							Tip: read the current settings any time with the <strong>Reload</strong> button on the PID step.
						</div>
					</v-card>
				</v-stepper-content>

				<!-- 2. Loop mode -->
				<v-stepper-content step="2">
					<v-card flat>
						<div class="text-body-2 mb-3">
							Choose how the driver runs. Tune in the mode you'll actually print in, and switch to
							<strong>closed</strong> or <strong>assisted</strong> before calibrating.
							<HelpTip :href="DOCS.m569" text="M569 D-parameter. Open = normal stepper, no feedback. Closed loop = full PID position control from the encoder. Assisted open loop = runs open-loop but uses the encoder to correct/avoid lost steps. D4=closed, D5=assisted, open returns to the normal stepper mode." />
						</div>
						<div class="d-flex flex-wrap mb-3">
							<v-tooltip v-for="m in modeList" :key="m.value" bottom max-width="320">
								<template #activator="{ on, attrs }">
									<v-btn v-bind="attrs" v-on="on" class="mr-2 mb-2" :color="currentMode === m.value ? 'primary' : undefined"
										   :outlined="currentMode !== m.value" small
										   :disabled="!selectedDriver" @click="setMode(m.value)">{{ m.label }}</v-btn>
								</template>
								<span>{{ modeHelp[m.value] }}</span>
							</v-tooltip>
						</div>
						<div v-if="selectedDriver" class="text-caption text--secondary">
							Will send: <code>{{ buildModeCommand(selectedDriver, 'closed', modeD) }}</code> (closed) ·
							<code>{{ buildModeCommand(selectedDriver, 'assisted', modeD) }}</code> (assisted) ·
							<code>{{ buildModeCommand(selectedDriver, 'open', modeD) }}</code> (open)
						</div>
						<v-expansion-panels class="mt-3" accordion>
							<v-expansion-panel>
								<v-expansion-panel-header>
									Advanced: mode D-values
									<HelpTip class="ml-1" :href="DOCS.m569" text="The M569 D number for each mode. Defaults match RRF 3.6/3.7 (open=spreadCycle D2, closed=D4, assisted-open=D5). Only change these if your firmware differs." />
								</v-expansion-panel-header>
								<v-expansion-panel-content>
									<v-row dense>
										<v-col cols="4"><v-text-field v-model.number="modeD.open" type="number" label="Open (D)" dense outlined hide-details /></v-col>
										<v-col cols="4"><v-text-field v-model.number="modeD.closed" type="number" label="Closed (D)" dense outlined hide-details /></v-col>
										<v-col cols="4"><v-text-field v-model.number="modeD.assisted" type="number" label="Assisted (D)" dense outlined hide-details /></v-col>
									</v-row>
								</v-expansion-panel-content>
							</v-expansion-panel>
						</v-expansion-panels>
					</v-card>
				</v-stepper-content>

				<!-- 3. Calibrate -->
				<v-stepper-content step="3">
					<v-card flat>
						<div class="text-body-2 mb-3">
							Calibration teaches the board the relationship between the encoder and the motor. It must be done
							before closed-loop control will work. Pick your encoder type to see what's required.
							<HelpTip :href="DOCS.m569_6" text="M569.6 runs a calibration/tuning manoeuvre. The driver must already be in closed or assisted mode. These moves rotate the motor a few steps to a few revolutions." />
						</div>
						<v-select v-model="encoderType" :items="encoderTypes" item-text="title" item-value="value"
								  dense outlined hide-details label="Encoder type (M569.1 T)" style="max-width: 360px" class="mb-2">
							<template #append><HelpTip :href="DOCS.m569_1" text="Set in config.g with M569.1 T: T1=linear composite, T2=quadrature motor shaft, T3=Duet3D magnetic. This only filters the calibration moves shown here — it doesn't change your config." /></template>
						</v-select>
						<v-alert type="info" text dense class="mb-2">{{ encoderGuidance }}</v-alert>
						<v-list dense class="py-0">
							<v-list-item v-for="c in calibrationMoves" :key="c.id">
								<v-list-item-content>
									<v-list-item-title>
										{{ c.name }}
										<v-chip v-if="requiredMoveIds.includes(c.id)" x-small color="primary" class="ml-1">required</v-chip>
										<v-chip v-else x-small class="ml-1">optional</v-chip>
									</v-list-item-title>
									<v-list-item-subtitle>{{ c.description }}</v-list-item-subtitle>
								</v-list-item-content>
								<v-list-item-action>
									<v-tooltip left>
										<template #activator="{ on, attrs }">
											<v-btn v-bind="attrs" v-on="on" small outlined :disabled="!selectedDriver || currentMode === 'open'" @click="runCalibration(c)">Run</v-btn>
										</template>
										<span>Sends {{ buildCalibrationCommand(selectedDriver || 'P#.#', c.id) }} — the motor will move.</span>
									</v-tooltip>
								</v-list-item-action>
							</v-list-item>
						</v-list>
						<div v-if="currentMode === 'open'" class="text-caption warning--text mt-2">Switch to closed or assisted mode (step 2) before calibrating.</div>
					</v-card>
				</v-stepper-content>

				<!-- 4. Tune PID -->
				<v-stepper-content step="4">
					<v-card flat>
						<div class="text-body-2 mb-3">
							Calibrate the encoder (Step 3), set the motor current to its final value, and uncouple the
							motor (see the note above). Then run <strong>Auto-tune</strong>: on an axis it tunes
							P → A → V → D → I (the Duet-documented order) from repeated trapezoid-move captures, refining
							every term together over the chosen number of cycles. Extruders (no axis) tune P → D → I from
							step jumps instead — A/V need an axis. Manual term-by-term tuning is available below.
							<HelpTip :href="DOCS.tuning" text="Auto-tune ensures closed loop, then on an axis cycles P (tracking error) → A (accel feed-forward) → V (velocity feed-forward) → D (overshoot) → I (steady-state error) from a trapezoid move. It captures after every change, converges when the response stops improving, refines every term again each cycle, and backs off on oscillation. It does NOT calibrate — do that in Step 3 first." />
						</div>

						<!-- Auto-tune. NB: highlight the running state with a border class, NOT `color`.
							 Vuetify 2's VSheet (VCard's base) passes `color` to setBackgroundColor, so
							 `outlined color="primary"` FILLS the card solid blue — whereas Vuetify 4's
							 `variant="outlined" color="primary"` only tints the border and text. -->
						<v-card outlined class="mb-3" :class="{ 'cl-card-running': autoRunning }">
							<v-card-text>
								<div class="d-flex align-center flex-wrap">
									<v-btn color="primary" class="mr-2 mb-2" :disabled="!selectedDriver || autoRunning || recording" :loading="autoRunning" @click="startAutoTune">
										<v-icon left>mdi-auto-fix</v-icon>
										Auto-tune ({{ hasAxisSelected ? "P → A → V → D → I" : "P → D → I" }})
									</v-btn>
									<v-btn v-if="autoRunning" color="error" outlined class="mr-2 mb-2" @click="abortAutoTune"><v-icon left>mdi-stop</v-icon>Abort</v-btn>
									<HelpTip :href="DOCS.tuning" text="Fully automatic and bounded. On an axis, every term is tuned (and later refined) from the same trapezoid-move capture; extruders (no axis) use step jumps for P/D/I only — A/V are skipped. Keep an emergency stop handy the first time." />
									<v-spacer />
									<span class="text-caption text--secondary">{{ autoStatus }}</span>
								</div>
								<div class="d-flex align-center flex-wrap mt-2">
									<span class="text-caption text--secondary mr-3">Tuning method:</span>
									<v-btn-toggle v-model="tuneMethod" mandatory dense color="primary" class="mr-3" :disabled="!hasAxisSelected">
										<v-btn v-for="m in TUNE_METHODS" :key="m.value" :value="m.value" small>{{ m.label }}</v-btn>
									</v-btn-toggle>
									<span class="text-caption text--secondary mr-2">≈ {{ estimatedMoves }} moves</span>
									<HelpTip text="Standard tunes each term in Duet's order, then refines every term again each cycle. Thorough adds a joint (all-terms-at-once) optimisation pass judged on the whole capture, not one term's own metric — closer to how the original tuner's author recommends tuning as a complete package, at the cost of more moves. Refine skips straight to that joint pass from whatever's on the driver now. Extruders (no axis) always use the standard P→D→I ramp." />
								</div>
								<div v-if="hasAxisSelected && tuneMethod !== 'sequential'" class="text-caption text--secondary mt-1">
									{{ tuneMethod === "refine" ? "Cycles is ignored — this runs a single joint-optimisation pass." : "Cycles only affects the initial ramp's refinement; the joint-optimisation pass always runs once." }}
								</div>
								<div v-if="autoRunning || tuneSession" class="d-flex flex-wrap mt-2">
									<v-chip v-for="s in STAGE_ORDER" :key="s.id" small class="mr-1 mb-1"
											:color="stageColor(stageStates[s.id])"
											:outlined="stageStates[s.id] === 'pending'">
										<v-icon left small>{{ stageIcon(stageStates[s.id]) }}</v-icon>{{ s.label }}
									</v-chip>
								</div>
								<div class="d-flex flex-wrap mt-2">
									<v-chip v-for="t in pidSummary" :key="t.term" small class="mr-1 mb-1"
											:color="autoRunning && wizardStep.term === t.term ? 'primary' : undefined">{{ t.term.toUpperCase() }} = {{ t.value }}</v-chip>
								</div>
								<div class="d-flex align-center flex-wrap mt-2">
									<v-text-field v-model.number="cycles" type="number" :min="1" :max="10" label="Cycles" dense outlined hide-details style="max-width: 120px" class="mr-3 mb-2"><template #append><HelpTip text="How many times to iterate the P→A→V→D→I tuning. Cycle 1 tunes every term from scratch; each cycle after that refines every term again (up or down) against the whole capture. 3 is a good default." /></template></v-text-field>
									<span class="text-caption text--secondary mr-2">A/V test move:</span>
									<v-text-field v-model.number="avDistance" type="number" :min="0" label="Distance (mm) — 0 = auto" dense outlined hide-details style="max-width: 170px" class="mr-3 mb-2"><template #append><HelpTip text="Length of the tuning move, centred on the middle of the axis's travel. 0 (default) uses the longest reasonable move that fits — longer moves give a longer cruise section and tune more reliably. Set a specific value to override." /></template></v-text-field>
									<v-text-field v-model.number="avFeed" type="number" label="Feed (mm/min)" dense outlined hide-details style="max-width: 160px" class="mr-3 mb-2"><template #append><HelpTip text="Speed of the A/V test move. Higher exercises the feed-forward terms more. Default 6000 mm/min (100 mm/s)." /></template></v-text-field>
									<v-text-field v-model.number="marginMm" type="number" :min="0" label="Safety margin (mm)" dense outlined hide-details style="max-width: 170px" class="mb-2"><template #append><HelpTip text="Kept clear of the axis's min/max limits. Tuning moves are auto-clamped inside this margin, and (if needed) the axis is centred in its travel before tuning starts. Only enforced on a homed axis." /></template></v-text-field>
								</div>
								<div v-if="axisTravelInfo" class="text-caption text--secondary mt-1">{{ axisTravelInfo }}</div>
								<v-expansion-panels class="mt-2" accordion>
									<v-expansion-panel>
										<v-expansion-panel-header>Advanced tuning options</v-expansion-panel-header>
										<v-expansion-panel-content>
											<div class="d-flex align-center flex-wrap">
												<span class="text-caption text--secondary mr-3">Identification method:</span>
												<v-btn-toggle v-model="identifyMethod" mandatory dense color="primary" class="mr-3" :disabled="!hasAxisSelected">
													<v-btn v-for="m in IDENTIFY_METHODS" :key="m.value" :value="m.value" small>{{ m.label }}</v-btn>
												</v-btn-toggle>
												<HelpTip text="Model fit (default): ramps P toward the actuator's own effort rail (not toward an oscillation — some axes are too well-damped to ever produce one below saturation) and backs off a fixed fraction, then solves A and V directly from two captures each. Continuous cycling (classic Ziegler–Nichols): ramp P until a clean sustained oscillation appears — can fail outright on a well-damped axis. Relay feedback (Åström–Hägglund): jump straight to a fixed high P so the P-term saturates like a bounded on/off relay, then read Ku/Tu off that limit cycle directly." />
											</div>
											<div class="d-flex align-center flex-wrap mt-3">
												<v-text-field v-if="identifyMethod === 'model-fit'" v-model.number="modelFitBackoff" type="number" step="0.05" :min="0.3" :max="0.9" label="P backoff fraction" dense outlined hide-details style="max-width: 170px" class="mr-3 mb-2"><template #append><HelpTip text="Fraction of the effort-rail-onset P used as the final P. Lower is quieter/safer, higher is faster/more aggressive. Default 0.65." /></template></v-text-field>
												<v-select v-if="identifyMethod !== 'model-fit'" v-model="seedRule" :items="SEED_RULES" item-text="title" item-value="value"
														  :disabled="!hasAxisSelected" dense outlined hide-details
														  label="Ku/Tu seed rule" style="max-width: 280px" class="mr-3 mb-2">
													<template #append><HelpTip text="Classical rule used to turn the identified Ku/Tu into starting P/I/D at the start of cycle 1 (axis drivers only). Tyreus–Luyben is the conservative default; zn-classic is Ziegler-Nichols' own gain formula." /></template>
												</v-select>
												<v-text-field v-if="identifyMethod !== 'model-fit' && seedRule === 'amigo'" v-model.number="seedLambda" type="number" step="0.1" label="λ (aggressiveness)" dense outlined hide-details style="max-width: 160px" class="mr-3 mb-2"><template #append><HelpTip text="Scales the AMIGO seed rule: >1 pushes the seeded gains hotter/faster, <1 backs them off. 1 = unscaled." /></template></v-text-field>
												<v-text-field v-model.number="medianOf" type="number" :min="1" :max="5" label="Captures per decision" dense outlined hide-details style="max-width: 190px" class="mr-3 mb-2"><template #append><HelpTip text="How many captures to median-combine before each decision. Higher rejects one-off glitches better but takes longer to run. 1 is the default; try 3 for a noisy encoder or a Thorough/Refine run." /></template></v-text-field>
												<v-text-field v-if="tuneMethod !== 'sequential'" v-model.number="captureBudget" type="number" :min="10" :max="200" label="Optimise capture budget" dense outlined hide-details style="max-width: 200px" class="mb-2"><template #append><HelpTip text="Maximum captures the joint (package/refine) optimisation pass may spend before stopping with its best result so far. Default 40." /></template></v-text-field>
												<v-text-field :value="dCeiling === null ? '' : dCeiling" @input="dCeiling = $event === '' ? null : Number($event)"
															  type="number" step="0.01" :min="0" :max="D_MAX" label="Max D (optional)" dense outlined hide-details style="max-width: 170px" class="mb-2">
													<template #append><HelpTip text="Manual cap on D during the sequential ramp, below the firmware's own limit. Auto-tune already stops on its own once raising D stops helping (e.g. a persistent, non-loop ripple like a ballscrew) — use this only if you want a firm ceiling regardless. Leave blank for no extra cap." /></template>
												</v-text-field>
												<v-text-field v-model.number="samples" type="number" :min="10" label="Samples" dense outlined hide-details style="max-width: 150px" class="mr-3 mb-2"><template #append><HelpTip text="Samples captured per attempt (M569.5 S parameter) — the same setting used everywhere else in the plugin, including manual captures below. Lower this if the board is truncating captures ('Data lost')." /></template></v-text-field>
												<v-text-field v-model.number="sampleRate" type="number" :min="0" label="Rate (/s, 0=max)" dense outlined hide-details style="max-width: 170px" class="mr-3 mb-2"><template #append><HelpTip text="Capture sample rate. With the Distance above left at 0 (auto, the default), this is only a starting point — the real rate is derived from the move's own duration, then capped to a safe ceiling for the board (lower on some RP2350-based boards). Set an explicit Distance above if you need this rate to apply directly." /></template></v-text-field>
												<v-text-field :value="pid.warn === null ? '' : pid.warn" @input="pid.warn = $event === '' ? null : Number($event)" type="number" label="Warn threshold (E)" dense outlined hide-details style="max-width: 170px" class="mr-3 mb-2" />
												<v-text-field :value="pid.err === null ? '' : pid.err" @input="pid.err = $event === '' ? null : Number($event)" type="number" label="Error threshold (E)" dense outlined hide-details style="max-width: 170px" class="mb-2">
													<template #append><HelpTip :href="DOCS.m569_1" text="M569.1 E<warn>:<err> — position-error thresholds that put the driver into a warning or error state if exceeded. Both must be set (either blank omits E entirely, leaving RRF's own default/config.g value in place). Also editable in the PID parameters card below." /></template>
												</v-text-field>
											</div>
											<div v-if="accelerometers.length > 0" class="d-flex align-center flex-wrap mt-3">
												<v-checkbox v-model="recordVibration" label="Record vibration" dense hide-details class="mr-3 mb-2" />
												<v-select v-if="accelerometers.length > 1" :value="selectedAccelerometerAddress" @input="selectedAccelerometerAddress = $event"
														  :items="accelerometers.map((a) => ({ text: `Board ${a.boardAddress}`, value: a.boardAddress }))"
														  item-text="text" item-value="value" clearable dense outlined hide-details
														  label="Accelerometer" style="max-width: 220px" class="mr-3 mb-2" />
												<HelpTip text="Arms an M956 accelerometer capture alongside every capture this plugin makes — the Record button as well as every tuning move — on whichever board has one, often a different board from the driver being tuned (e.g. mounted on the toolhead). Report-only: never affects any tuning decision. If more than one accelerometer is available, pick which one to use; otherwise the driver's own board is preferred, falling back to the first one found." />
											</div>
											<v-alert v-if="accelDisabledReason" type="warning" dense text class="mt-2 caption">
												Vibration recording stopped: {{ accelDisabledReason }} Untick and re-tick &ldquo;Record vibration&rdquo; to try again.
											</v-alert>
										</v-expansion-panel-content>
									</v-expansion-panel>
								</v-expansion-panels>
								<div v-if="autoLog.length" ref="autoLogEl" class="cl-autolog mt-2">
									<div v-for="(line, idx) in autoLog" :key="idx">{{ line }}</div>
								</div>
								<div v-if="tuneSession && !autoRunning" class="d-flex align-center mt-2">
									<v-btn small outlined class="mr-2" @click="downloadTuningReport"><v-icon left small>mdi-download</v-icon>Download results</v-btn>
									<HelpTip text="Saves the auto-tune session — log, final values, options used and every capture's metrics — as one JSON file (machine host details scrubbed). Full raw CSV is kept for notable (unstable) captures and the last capture of each term; check 'include all raw CSVs' to attach every one instead. Send it over if a result looks wrong and it can be analysed." />
									<v-checkbox v-model="includeAllCsv" label="Include all raw CSVs" dense hide-details class="ml-3 mt-0" />
									<span class="text-caption text--secondary ml-2">{{ tuneSession.captures.length }} captures</span>
								</div>
							</v-card-text>
						</v-card>

						<v-expansion-panels v-if="!autoRunning" v-model="manualPanels" class="mt-2" accordion>
							<v-expansion-panel>
								<v-expansion-panel-header>
									Manual tuning — optional (auto-tune already does this)
									<HelpTip class="ml-1" :href="DOCS.tuning" text="Tune one term at a time by hand: pick a term, run a step, read the recommendation, apply it. Only needed if you want to override the auto-tuner." />
								</v-expansion-panel-header>
								<v-expansion-panel-content>
									<v-row dense>
										<v-col cols="12" md="5">
											<v-card outlined>
												<v-card-text>
													<div class="d-flex align-center mb-2">
														<v-btn small text icon :disabled="wizardIndex === 0" @click="wizardIndex--"><v-icon small>mdi-chevron-left</v-icon></v-btn>
														<div class="flex-grow-1 text-center text-subtitle-2">{{ wizardStep.title }} ({{ wizardIndex + 1 }}/{{ steps.length }})</div>
														<v-btn small text icon :disabled="wizardIndex === steps.length - 1" @click="wizardIndex++"><v-icon small>mdi-chevron-right</v-icon></v-btn>
													</div>
													<div class="text-caption mb-1"><strong>Goal:</strong> {{ wizardStep.goal }}</div>
													<div class="text-caption text--secondary mb-2">{{ wizardStep.instructions }}</div>
													<div class="d-flex align-center mb-2">
														<v-btn small color="info" class="mr-2" :disabled="!selectedDriver || recording || autoRunning" :loading="recording" @click="runWizardCapture">
															<v-icon left small>mdi-record</v-icon> Run step &amp; analyse
														</v-btn>
														<v-btn v-if="wizardStep.term && wizardStep.defaultStart !== undefined" small text class="mr-2"
															   :disabled="!selectedDriver" @click="seedDefault">Set start ({{ wizardStep.defaultStart }})</v-btn>
														<HelpTip :href="DOCS.m569_5" text="Uses a small, auto-sized G1 move by default (fast enough to behave like a step jump). To use your own move instead, set it in Advanced → Manual capture below, then switch Move to Custom — the wizard will use that move too." />
													</div>
													<v-alert v-if="recommendation" :type="verdictType" text dense>
														<div class="d-flex align-center">
															<span>{{ recommendation.message }}</span>
															<template v-if="recommendation.suggested !== undefined">
																<v-spacer />
																<v-btn x-small text @click="applySuggestion">Set {{ wizardStep.term?.toUpperCase() }}={{ recommendation.suggested }}</v-btn>
															</template>
														</div>
													</v-alert>
												</v-card-text>
											</v-card>
										</v-col>

										<v-col cols="12" md="7">
											<v-card outlined>
												<v-card-title class="py-2 text-subtitle-2 d-flex align-center">
													PID parameters
													<HelpTip class="ml-1" :href="DOCS.m569_1" text="M569.1 R=P (proportional), I (integral), D (derivative), V (velocity feed-forward), A (acceleration feed-forward). The wizard's suggestions write into these; Apply sends them to the driver." />
													<v-spacer />
													<v-btn x-small text :disabled="!selectedDriver" @click="loadPid">Reload</v-btn>
												</v-card-title>
												<v-card-text>
													<v-row dense>
														<v-col cols="4"><v-text-field v-model.number="pid.p" type="number" label="P (R)" dense outlined hide-details :class="{ 'cl-active-term': wizardStep.term === 'p' }" /></v-col>
														<v-col cols="4"><v-text-field v-model.number="pid.i" type="number" label="I" dense outlined hide-details :class="{ 'cl-active-term': wizardStep.term === 'i' }" /></v-col>
														<v-col cols="4"><v-text-field v-model.number="pid.d" type="number" label="D" dense outlined hide-details :class="{ 'cl-active-term': wizardStep.term === 'd' }" /></v-col>
														<v-col cols="6"><v-text-field v-model.number="pid.v" type="number" label="V (vel ff)" dense outlined hide-details :class="{ 'cl-active-term': wizardStep.term === 'v' }" /></v-col>
														<v-col cols="6"><v-text-field v-model.number="pid.a" type="number" label="A (accel ff)" dense outlined hide-details :class="{ 'cl-active-term': wizardStep.term === 'a' }" /></v-col>
														<v-col cols="6">
															<v-text-field :value="pid.warn === null ? '' : pid.warn" @input="pid.warn = $event === '' ? null : Number($event)" type="number" label="Warn threshold (E)" dense outlined hide-details />
														</v-col>
														<v-col cols="6">
															<v-text-field :value="pid.err === null ? '' : pid.err" @input="pid.err = $event === '' ? null : Number($event)" type="number" label="Error threshold (E)" dense outlined hide-details>
																<template #append><HelpTip :href="DOCS.m569_1" text="M569.1 E<warn>:<err> — position-error thresholds that put the driver into a warning or error state if exceeded. Both must be set (either blank omits E entirely, leaving RRF's own default/config.g value in place)." /></template>
															</v-text-field>
														</v-col>
													</v-row>
													<div class="d-flex align-center mt-2">
														<v-btn small color="primary" class="mr-2" :disabled="!selectedDriver" :loading="applyingPid" @click="applyPid">Apply (M569.1)</v-btn>
														<span class="text-caption text--secondary text-truncate"><code>{{ pidPreview }}</code></span>
													</div>
												</v-card-text>
											</v-card>
										</v-col>
									</v-row>
								</v-expansion-panel-content>
							</v-expansion-panel>
							<v-expansion-panel>
								<v-expansion-panel-header>
									Advanced: manual capture
									<HelpTip class="ml-1" :href="DOCS.m569_5" text="For power users: record any combination of variables, at a chosen rate, during the step manoeuvre or a custom move. Useful for tuning A/V on a steady-speed G1 move." />
								</v-expansion-panel-header>
								<v-expansion-panel-content>
									<v-row dense>
										<v-col cols="6" sm="3"><v-text-field v-model.number="samples" type="number" label="Samples" dense outlined hide-details /></v-col>
										<v-col cols="6" sm="3"><v-text-field v-model.number="sampleRate" type="number" label="Rate (/s, 0=max)" dense outlined hide-details /></v-col>
										<v-col cols="12" sm="6">
											<v-radio-group v-model="moveMode" row dense hide-details>
												<v-radio label="Step manoeuvre" value="step" />
												<v-radio label="Custom move" value="custom" />
											</v-radio-group>
										</v-col>
									</v-row>
									<v-text-field v-if="moveMode === 'custom'" v-model="customMove" label="Move G-code" dense outlined hide-details class="mb-2" placeholder="G91 G1 H2 X50 F6000 G90">
										<template #append><HelpTip text="Unlike the auto-generated tuning moves, this distance is NOT checked against the axis's travel limits — it's your responsibility. The axis is still centred first if needed." /></template>
									</v-text-field>
									<div v-if="moveMode === 'custom' && axisTravelInfo" class="text-caption text--secondary mb-1">{{ axisTravelInfo }}</div>
									<div class="d-flex flex-wrap mb-1">
										<v-checkbox v-for="v in captureVariables" :key="v.key" v-model="recordKeys" :value="v.key" :label="v.header" dense hide-details class="cl-var" />
									</div>
									<v-btn small color="info" :disabled="!canRecord || recording || autoRunning" :loading="recording" @click="record()"><v-icon left small>mdi-record</v-icon> Record</v-btn>
									<div v-if="selectedDriver" class="text-caption text--secondary mt-1"><code>{{ capturePreview }}</code></div>
									<div class="d-flex align-center mt-2">
										<v-checkbox v-model="deleteCapturesAfterRead" label="Delete capture CSVs from the board after reading them" dense hide-details class="mt-0" />
										<HelpTip class="ml-1" text="Applies to every capture this plugin makes, not just this panel — including auto-tune, which can leave dozens of CSVs in 0:/sys/closed-loop over a run. Only ever deletes the exact file the plugin itself just wrote and already read; never touches anything else in that folder." />
									</div>
								</v-expansion-panel-content>
							</v-expansion-panel>
						</v-expansion-panels>
					</v-card>
				</v-stepper-content>

				<!-- 5. Test & save -->
				<v-stepper-content step="5">
					<v-card flat>
						<div class="text-body-2 mb-3">
							Verify the tuning with a real move, then copy the tuned line into <code>config.g</code> (after your
							<code>M569</code>/<code>M906</code>/microstepping setup) and the mode + calibration lines into your homing file.
							<HelpTip :href="DOCS.tuning" text="RRF programs these registers itself from M569/M906/microstepping, so the M569.1 line must come AFTER that setup. The mode switch and calibration belong in the homing file so they run every power-on." />
						</div>

						<v-alert type="info" text dense class="mb-3">
							<div class="d-flex align-center">
								<span>Run a test move — the <strong>Evaluation</strong> panel (right) grades it automatically and tells you exactly what, if anything, to change. No need to read the graph yourself.</span>
								<HelpTip class="ml-1" :href="DOCS.tuning" text="The evaluation segments the move and measures the position error in each region (rest / accel / steady speed), in motor steps. A good drive holds the error to a small fraction of a step, centred on zero. Click for the wiki's annotated good-vs-bad example plots." />
							</div>
						</v-alert>

						<v-row dense>
							<v-col cols="12" md="6">
								<v-card outlined class="mb-2">
									<v-card-title class="py-2 text-subtitle-2">Test move</v-card-title>
									<v-card-text>
										<v-text-field v-model="customMove" label="Test move G-code" dense outlined hide-details class="mb-2" placeholder="G91 G1 H2 X50 F6000 G90">
											<template #append><HelpTip text="A real G1 move (recorded while it runs). Watch Current Error in the plot — a well-tuned drive keeps it small and centred on zero. This distance isn't checked against the travel limits, so keep it within the range shown below." /></template>
										</v-text-field>
										<div v-if="axisTravelInfo" class="text-caption text--secondary mb-1">{{ axisTravelInfo }}</div>
										<v-btn small color="info" :disabled="!selectedDriver || recording" :loading="recording" @click="runTestMove"><v-icon left small>mdi-record</v-icon> Run test move</v-btn>
									</v-card-text>
								</v-card>
							</v-col>
							<v-col cols="12" md="6">
								<v-card outlined class="mb-2">
									<v-card-title class="py-2 text-subtitle-2 d-flex align-center">
										config.g block
										<v-spacer />
										<v-btn x-small text :disabled="!selectedDriver" @click="copyConfig"><v-icon left x-small>mdi-content-copy</v-icon>Copy</v-btn>
										<v-btn x-small text :disabled="!selectedDriver" class="ml-1" @click="openSaveToConfigG"><v-icon left x-small>mdi-content-save</v-icon>Save to config.g</v-btn>
									</v-card-title>
									<v-card-text>
										<pre class="cl-config">{{ configBlock }}</pre>
									</v-card-text>
								</v-card>
							</v-col>
						</v-row>
					</v-card>
				</v-stepper-content>
			</v-stepper-items>
		</v-stepper>

		<!-- Persistent results: chart + analysis from the most recent capture. align="start" stops
			 Vuetify's default row-stretch from inflating the chart column (which has a fixed, content-sized
			 height) to match the right column's often-taller stack of cards — without it, the chart card's
			 fill-height grows to fill that mismatch as visible blank space below the chart. -->
		<v-row dense class="mt-1" align="start">
			<v-col cols="12" md="9">
				<CaptureChart :capture="capture" :overlay="overlayCapture" :selected-keys="viewKeys" :sample-rate="sampleRate" :raw-text="rawText" />
			</v-col>
			<v-col cols="12" md="3">
				<v-card v-if="evaluation" class="mb-2" :outlined="evaluation.grade === 'unknown'" :color="gradeColor(evaluation.grade)">
					<v-card-text class="py-3">
						<div class="d-flex align-center mb-1">
							<v-icon class="mr-2">{{ gradeIcon }}</v-icon>
							<span class="text-h6 text-capitalize">{{ evaluation.grade }}</span>
							<v-spacer />
							<span v-if="evaluation.grade !== 'unknown'" class="text-h6">{{ evaluation.score }}<span class="text-caption">/100</span></span>
							<HelpTip class="ml-1" text="An automatic verdict on the last capture: the plugin segments the move (rest / accelerating / steady speed), measures the position error in each region in motor steps, and grades it. Each point below names the term to change and which way." />
						</div>
						<div class="text-body-2 cl-on-grade mb-2">{{ evaluation.headline }}</div>
						<v-list dense class="cl-eval-list pa-0" color="transparent">
							<v-list-item v-for="(f, i) in evaluation.findings" :key="i" class="px-0">
								<v-list-item-icon class="mr-2 my-1">
									<v-icon small :color="severityColor(f.severity)">{{ severityIcon(f.severity) }}</v-icon>
								</v-list-item-icon>
								<v-list-item-content class="py-1">
									<v-list-item-title class="text-body-2">{{ f.title }}</v-list-item-title>
									<v-list-item-subtitle class="cl-finding-detail">{{ f.detail }}</v-list-item-subtitle>
									<div v-if="f.fix" class="d-flex align-center mt-1">
										<v-icon x-small>mdi-arrow-right-bold</v-icon>
										<span class="text-caption font-weight-medium ml-1">{{ f.fix }}</span>
										<v-btn v-if="f.term" x-small outlined class="ml-1" @click="goToManualTerm(f.term)">Tune {{ f.term.toUpperCase() }}</v-btn>
									</div>
								</v-list-item-content>
							</v-list-item>
						</v-list>
					</v-card-text>
				</v-card>
				<v-card v-if="tuneSession && tuneSession.envelopeCheck" class="mb-2" :outlined="tuneSession.envelopeCheck.holds" :color="tuneSession.envelopeCheck.holds ? undefined : 'warning'">
					<v-card-text class="py-3">
						<div class="d-flex align-center mb-1">
							<v-icon class="mr-2" :color="tuneSession.envelopeCheck.holds ? 'success' : undefined">{{ tuneSession.envelopeCheck.holds ? "mdi-check-circle" : "mdi-alert" }}</v-icon>
							<span class="text-subtitle-1">{{ tuneSession.envelopeCheck.holds ? "Holds at the machine's configured max" : "Saturates at the machine's configured max" }}</span>
							<v-spacer />
							<HelpTip class="ml-1" text="A validation capture at the axis's own configured M203/M201 (its true speed/acceleration ceiling) — separate from the moderate profile identification itself used, which deliberately stays below saturation so the ramp has something to measure. Report-only: never changes the tuned values, only tells you whether they still hold once the machine is driven to what it's actually configured to do. If your slicer's real print speeds are well below the configured M203/M201, this checks a stricter limit than you'll ever actually reach." />
						</div>
						<div class="text-body-2 cl-on-grade">
							Checked at F{{ tuneSession.envelopeCheck.feedMmPerMin.toFixed(0) }} — {{ (tuneSession.envelopeCheck.satDuty * 100).toFixed(1) }}% saturation duty.
							<template v-if="!tuneSession.envelopeCheck.holds">This tune may need a lower P (or more V/A feed-forward) if the machine is ever driven to its configured M203/M201 limits.</template>
						</div>
					</v-card-text>
				</v-card>
				<v-card v-if="tuneSession && tuneSession.identifiedAtSeed" class="mb-2" color="warning">
					<v-card-text class="py-3">
						<div class="d-flex align-center mb-1">
							<v-icon class="mr-2">mdi-alert</v-icon>
							<span class="text-subtitle-1">Tuning move too aggressive</span>
							<v-spacer />
							<HelpTip class="ml-1" text="Cycle 1's P identification ramps P from a low starting value until the motor's effort hits its limit, then backs off. Here it hit that limit at the very first step, so the final P comes from the starting value rather than a measurement of this axis. The usual cause is a tuning feed too fast for the low starting P to keep up with. Lower the Feed (mm/min) setting above and re-run." />
						</div>
						<div class="text-body-2 cl-on-grade">
							P identification may be unreliable — the P ramp hit its effort limit at the very first step, so the result comes from the starting value rather than a measurement of this axis. Try a lower Feed (mm/min) above and re-run.
						</div>
					</v-card-text>
				</v-card>
				<v-card class="mb-2">
					<v-card-title class="py-2 text-subtitle-1 d-flex align-center">
						Analysis
						<HelpTip class="ml-1" text="Computed automatically from the last step capture: rise time (10–90%), overshoot beyond target, settling time, and the residual steady-state error. The wizard uses these to make its recommendations." />
					</v-card-title>
					<v-card-text>
						<div v-if="!metrics" class="text--secondary text-caption">Run a step to see rise time, overshoot and steady-state error.</div>
						<v-simple-table v-else dense>
							<tbody>
								<tr><td>Step size</td><td>{{ metrics.stepSize.toFixed(2) }} steps</td></tr>
								<tr><td>Rise time</td><td>{{ metrics.riseTime === null ? "—" : (metrics.riseTime * 1000).toFixed(0) + " ms" }}</td></tr>
								<tr><td>Overshoot</td><td>{{ metrics.overshootPct.toFixed(0) }} %</td></tr>
								<tr><td>Settling time</td><td>{{ metrics.settlingTime === null ? "—" : (metrics.settlingTime * 1000).toFixed(0) + " ms" }}</td></tr>
								<tr><td>Steady-state error</td><td>{{ metrics.steadyStateError.toFixed(3) }} steps</td></tr>
								<tr><td>Peak / RMS error</td><td>{{ metrics.peakError.toFixed(3) }} / {{ metrics.rmsError.toFixed(3) }}</td></tr>
							</tbody>
						</v-simple-table>
					</v-card-text>
				</v-card>
				<v-card>
					<v-card-title class="py-2 text-subtitle-1 d-flex align-center">
						Plot
						<HelpTip class="ml-1" text="Choose which recorded variables to draw. Use Overlay to freeze the current trace and compare it against your next capture." />
						<v-spacer />
						<v-btn x-small text :disabled="!capture || !!overlayCapture" @click="pinOverlay">Overlay</v-btn>
						<v-btn v-if="overlayCapture" x-small text @click="overlayCapture = null">Clear</v-btn>
					</v-card-title>
					<v-card-text>
						<div v-if="availableViewVars.length === 0" class="text--secondary text-caption">No capture loaded yet.</div>
						<div class="d-flex flex-wrap">
							<v-checkbox v-for="v in availableViewVars" :key="v.key" v-model="viewKeys" :value="v.key" :label="v.header" dense hide-details class="cl-var" />
						</div>
					</v-card-text>
				</v-card>
			</v-col>
		</v-row>

		<v-row v-if="accelCapture" dense class="mt-1">
			<v-col cols="12" md="9">
				<VibrationChart :capture="accelCapture" :vibration="lastVibration" />
			</v-col>
		</v-row>

		<v-dialog v-model="confirmOpen" max-width="460">
			<v-card>
				<v-card-title>Confirm movement</v-card-title>
				<v-card-text>
					<div style="white-space: pre-line;">{{ confirmMessage }}</div>
					<div class="text-caption text--secondary mt-2"><code>{{ confirmCommand }}</code></div>
				</v-card-text>
				<v-card-actions>
					<v-spacer />
					<v-btn text @click="confirmCancel">Cancel</v-btn>
					<v-btn color="primary" @click="confirmProceed">Proceed</v-btn>
				</v-card-actions>
			</v-card>
		</v-dialog>

		<v-dialog v-model="configWriteConfirmOpen" max-width="520">
			<v-card>
				<v-card-title>Write to config.g?</v-card-title>
				<v-card-text>
					This downloads config.g from the board, saves a timestamped backup, inserts/updates a single
					marked block for driver {{ selectedDriver }}, and uploads the result — nothing outside that
					block is touched. The board needs a restart for the change to take effect.
					<pre class="cl-config mt-2">{{ configBlock }}</pre>
				</v-card-text>
				<v-card-actions>
					<v-spacer />
					<v-btn text @click="configWriteConfirmOpen = false">Cancel</v-btn>
					<v-btn color="primary" :loading="savingConfig" @click="confirmSaveToConfigG">Write config.g</v-btn>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</v-container>
</template>

<script setup lang="ts">
/**
 * Closed Loop Tuning — DuetWebControl 3.6 (Vue 2.7 / Vuetify 2) view.
 *
 * Markup only, mirroring `../ui37/ClosedLoopTuning.vue`: all state and behaviour — including the
 * travel-limit and CoreXY coupling safety gate — comes from `../core/useClosedLoopTuning`, which both
 * pages share verbatim. Only the template differs, because Vuetify 2 and Vuetify 4 are not compatible
 * (translation table: docs/PLAN-dwc36-backport.md §6).
 *
 * The two component imports below are local Vuetify 2 stand-ins: dwc-plugin-runtime's HelpTip and
 * AboutDialog are Vue 3 render functions using `resolveComponent`, which Vue 2.7 does not export.
 */
import { nextTick, ref, watch } from "vue";

import { useClosedLoopTuning } from "../core/useClosedLoopTuning";
import { createHost } from "./host";
import AboutDialog from "./AboutDialog.vue";
import CaptureChart from "./CaptureChart.vue";
import VibrationChart from "./VibrationChart.vue";
import HelpTip from "./HelpTip.vue";

const {
	host,
	DOCS, MODE_LABELS, TUNE_METHODS, IDENTIFY_METHODS, SEED_RULES, STAGE_ORDER,
	steps, stepTitles, captureVariables, encoderTypes, modeList, modeHelp,
	buildModeCommand, buildCalibrationCommand,
	gradeColor, severityColor, severityIcon, gradeIcon, stageColor, stageIcon,
	step, selectedDriver, drivers, currentMode, hasAxisSelected, wizardIndex, wizardStep,
	modeD, setMode, encoderType, encoderGuidance, calibrationMoves, requiredMoveIds, runCalibration,
	pid, pidPreview, pidSummary, applyingPid, applyPid, loadPid,
	recommendation, verdictType, applySuggestion, seedDefault, runWizardCapture, manualPanels,
	autoRunning, autoStatus, autoLog, startAutoTune, abortAutoTune,
	tuneMethod, estimatedMoves, identifyMethod, modelFitBackoff, seedRule, seedLambda,
	medianOf, captureBudget, cycles, avDistance, avFeed, marginMm, axisTravelInfo,
	stageStates, tuneSession, includeAllCsv, downloadTuningReport, dCeiling, D_MAX,
	recordVibration, accelerometers, selectedAccelerometerAddress, accelCapture, accelDisabledReason, lastVibration,
	samples, sampleRate, moveMode, customMove, recordKeys, canRecord, capturePreview, record,
	recording, capture, overlayCapture, rawText, viewKeys, availableViewVars, pinOverlay,
	metrics, evaluation, goToManualTerm, deleteCapturesAfterRead,
	runTestMove, configBlock, copyConfig, openSaveToConfigG,
	configWriteConfirmOpen, savingConfig, confirmSaveToConfigG,
	confirmOpen, confirmCommand, confirmMessage, confirmProceed, confirmCancel,
	updateState, updateBanner, checking, applying, pendingReload, autoCheck,
	applyUpdateNow, dismissCurrentUpdate, reloadPage, onCheckUpdate, onToggleAutoCheck,
	aboutOpen, aboutDescription, aboutExtraActions,
} = useClosedLoopTuning(createHost());

// The auto-tune log's scroll position is a view concern, so it lives here rather than in the shared
// composable (which never touches the DOM). `ref="autoLogEl"` binds to this ref on both Vue
// generations — Vue 2.7's setSetupRef assigns into a <script setup> ref exactly as Vue 3 does.
const autoLogEl = ref<HTMLElement | null>(null);
watch(() => autoLog.value.length, () => {
	void nextTick(() => {
		const el = autoLogEl.value;
		if (el) { el.scrollTop = el.scrollHeight; }
	});
});
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
	background: rgba(128, 128, 128, 0.08);
	padding: 8px;
	border-radius: 4px;
}
:deep(.cl-active-term fieldset) {
	border: 2px solid var(--v-primary-base, #1976d2) !important;
	border-radius: 4px;
}
/* Vuetify 4's `variant="outlined" color="primary"` tints only the border/text; Vuetify 2's `color`
   would fill the card instead (see the note on the auto-tune card), so do the highlight in CSS. */
.cl-card-running {
	border-color: var(--v-primary-base, #1976d2) !important;
	border-width: 2px;
}
.cl-eval-list :deep(.v-list-item) {
	min-height: 0;
	margin-bottom: 4px;
}
.cl-finding-detail {
	white-space: normal !important;
	opacity: 0.92;
	font-size: 0.74rem;
	line-height: 1.3;
}
.cl-on-grade {
	opacity: 0.95;
}
.cl-autolog {
	max-height: 140px;
	overflow-y: auto;
	font-family: monospace;
	font-size: 0.74rem;
	line-height: 1.35;
	background: rgba(128, 128, 128, 0.08);
	padding: 6px 8px;
	border-radius: 4px;
}
</style>
