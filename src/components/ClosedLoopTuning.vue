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
			No closed-loop drivers found. Connect a board with closed-loop support (a Duet 3 1HCL / M23CL, or any
			other RRF board reporting closed-loop driver telemetry) configured for an axis or extruder.
		</v-alert>

		<v-alert type="warning" variant="tonal" density="compact" class="mb-3" icon="mdi-axis-arrow">
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
			<v-chip v-if="selectedDriver" size="small" variant="tonal" class="mr-2">Driver {{ selectedDriver }}</v-chip>
			<v-chip v-if="currentMode" size="small" :color="currentMode === 'open' ? 'grey' : 'success'" variant="flat">{{ MODE_LABELS[currentMode] }}</v-chip>
			<v-tooltip text="About, updates & diagnostics" location="bottom">
				<template #activator="{ props: tip }">
					<v-btn v-bind="tip" icon="mdi-information-outline" variant="text" size="small" class="ml-1" @click="aboutOpen = true" />
				</template>
			</v-tooltip>
		</div>

		<AboutDialog v-model="aboutOpen" plugin-id="ClosedLoopTuning" title="Closed Loop Tuning"
					 :description="aboutDescription" :model="machineStore.model"
					 repo="https://github.com/jaysuk/ClosedLoopTuningPlugin"
					 :docs-url="DOCS.tuning" docs-label="Duet closed-loop tuning guide"
					 :update-available="updateState?.updateAvailable ?? false" :latest-version="updateState?.latestVersion"
					 :checking="checking" :applying="applying" :pending-reload="pendingReload" :auto-check="autoCheck"
					 :extra-actions="aboutExtraActions"
					 @check-update="onCheckUpdate" @apply-update="applyUpdateNow" @toggle-auto-check="onToggleAutoCheck" />

		<v-stepper v-model="step" :items="stepTitles" editable flat>
			<!-- 1. Driver -->
			<template #item.1>
				<v-card flat>
					<div class="text-body-2 mb-3">
						Pick the closed-loop driver you want to tune. Tuning moves only this driver, so re-home the axis afterwards.
						<HelpTip text="The list shows every axis/extruder driver on a board that reports closed-loop support — a Duet3D closed-loop board (1HCL / M23CL) or any other RRF board exposing closed-loop driver telemetry. Only one driver can be tuned at a time." />
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
						Calibrate the encoder (Step 3), set the motor current to its final value, and uncouple the
						motor (see the note above). Then run <strong>Auto-tune</strong>: on an axis it tunes
						P → A → V → D → I (the Duet-documented order) from repeated trapezoid-move captures, refining
						every term together over the chosen number of cycles. Extruders (no axis) tune P → D → I from
						step jumps instead — A/V need an axis. Manual term-by-term tuning is available below.
						<HelpTip :href="DOCS.tuning" text="Auto-tune ensures closed loop, then on an axis cycles P (tracking error) → A (accel feed-forward) → V (velocity feed-forward) → D (overshoot) → I (steady-state error) from a trapezoid move. It captures after every change, converges when the response stops improving, refines every term again each cycle, and backs off on oscillation. It does NOT calibrate — do that in Step 3 first." />
					</div>

					<!-- Auto-tune -->
					<v-card variant="outlined" class="mb-3" :color="autoRunning ? 'primary' : undefined">
						<v-card-text>
							<div class="d-flex align-center flex-wrap ga-2">
								<v-btn color="primary" :disabled="!selectedDriver || autoRunning || recording" :loading="autoRunning" prepend-icon="mdi-auto-fix" @click="startAutoTune">
									Auto-tune ({{ hasAxisSelected ? "P → A → V → D → I" : "P → D → I" }})
								</v-btn>
								<v-btn v-if="autoRunning" color="error" variant="tonal" prepend-icon="mdi-stop" @click="abortAutoTune">Abort</v-btn>
								<HelpTip :href="DOCS.tuning" text="Fully automatic and bounded. On an axis, every term is tuned (and later refined) from the same trapezoid-move capture; extruders (no axis) use step jumps for P/D/I only — A/V are skipped. Keep an emergency stop handy the first time." />
								<v-spacer />
								<span class="text-caption text-medium-emphasis">{{ autoStatus }}</span>
							</div>
							<div class="d-flex align-center flex-wrap ga-3 mt-2">
								<span class="text-caption text-medium-emphasis">Tuning method:</span>
								<v-btn-toggle v-model="tuneMethod" mandatory density="compact" color="primary" divided :disabled="!hasAxisSelected">
									<v-btn v-for="m in TUNE_METHODS" :key="m.value" :value="m.value" size="small">{{ m.label }}</v-btn>
								</v-btn-toggle>
								<span class="text-caption text-medium-emphasis">≈ {{ estimatedMoves }} moves</span>
								<HelpTip text="Standard tunes each term in Duet's order, then refines every term again each cycle. Thorough adds a joint (all-terms-at-once) optimisation pass judged on the whole capture, not one term's own metric — closer to how the original tuner's author recommends tuning as a complete package, at the cost of more moves. Refine skips straight to that joint pass from whatever's on the driver now. Extruders (no axis) always use the standard P→D→I ramp." />
							</div>
							<div v-if="hasAxisSelected && tuneMethod !== 'sequential'" class="text-caption text-medium-emphasis mt-1">
								{{ tuneMethod === "refine" ? "Cycles is ignored — this runs a single joint-optimisation pass." : "Cycles only affects the initial ramp's refinement; the joint-optimisation pass always runs once." }}
							</div>
							<div v-if="autoRunning || tuneSession" class="d-flex flex-wrap ga-1 mt-2">
								<v-chip v-for="s in STAGE_ORDER" :key="s.id" size="small"
										:color="stageColor(stageStates[s.id])"
										:variant="stageStates[s.id] === 'pending' ? 'outlined' : 'flat'"
										:prepend-icon="stageIcon(stageStates[s.id])">{{ s.label }}</v-chip>
							</div>
							<div class="d-flex flex-wrap ga-1 mt-2">
								<v-chip v-for="t in pidSummary" :key="t.term" size="small"
										:color="autoRunning && wizardStep.term === t.term ? 'primary' : undefined"
										:variant="autoRunning && wizardStep.term === t.term ? 'flat' : 'tonal'">{{ t.term.toUpperCase() }} = {{ t.value }}</v-chip>
							</div>
							<div class="d-flex align-center flex-wrap ga-3 mt-2">
								<v-text-field v-model.number="cycles" type="number" :min="1" :max="10" label="Cycles" density="compact" variant="outlined" hide-details style="max-width: 120px"><template #append-inner><HelpTip text="How many times to iterate the P→A→V→D→I tuning. Cycle 1 tunes every term from scratch; each cycle after that refines every term again (up or down) against the whole capture. 3 is a good default." /></template></v-text-field>
								<span class="text-caption text-medium-emphasis">A/V test move:</span>
								<v-text-field v-model.number="avDistance" type="number" :min="0" label="Distance (mm) — 0 = auto" density="compact" variant="outlined" hide-details style="max-width: 170px"><template #append-inner><HelpTip text="Length of the tuning move, centred on the middle of the axis's travel. 0 (default) uses the longest reasonable move that fits — longer moves give a longer cruise section and tune more reliably. Set a specific value to override." /></template></v-text-field>
								<v-text-field v-model.number="avFeed" type="number" label="Feed (mm/min)" density="compact" variant="outlined" hide-details style="max-width: 160px"><template #append-inner><HelpTip text="Speed of the A/V test move. Higher exercises the feed-forward terms more. Default 6000 mm/min (100 mm/s)." /></template></v-text-field>
								<v-text-field v-model.number="marginMm" type="number" :min="0" label="Safety margin (mm)" density="compact" variant="outlined" hide-details style="max-width: 170px"><template #append-inner><HelpTip text="Kept clear of the axis's min/max limits. Tuning moves are auto-clamped inside this margin, and (if needed) the axis is centred in its travel before tuning starts. Only enforced on a homed axis." /></template></v-text-field>
							</div>
							<div v-if="axisTravelInfo" class="text-caption text-medium-emphasis mt-1">{{ axisTravelInfo }}</div>
							<v-expansion-panels class="mt-2" variant="accordion">
								<v-expansion-panel>
									<v-expansion-panel-title>Advanced tuning options</v-expansion-panel-title>
									<v-expansion-panel-text>
										<div class="d-flex align-center flex-wrap ga-3">
											<span class="text-caption text-medium-emphasis">Identification method:</span>
											<v-btn-toggle v-model="identifyMethod" mandatory density="compact" color="primary" divided :disabled="!hasAxisSelected">
												<v-btn v-for="m in IDENTIFY_METHODS" :key="m.value" :value="m.value" size="small">{{ m.label }}</v-btn>
											</v-btn-toggle>
											<HelpTip text="Model fit (default): ramps P toward the actuator's own effort rail (not toward an oscillation — some axes are too well-damped to ever produce one below saturation) and backs off a fixed fraction, then solves A and V directly from two captures each. Continuous cycling (classic Ziegler–Nichols): ramp P until a clean sustained oscillation appears — can fail outright on a well-damped axis. Relay feedback (Åström–Hägglund): jump straight to a fixed high P so the P-term saturates like a bounded on/off relay, then read Ku/Tu off that limit cycle directly." />
										</div>
										<div class="d-flex align-center flex-wrap ga-3 mt-3">
											<v-text-field v-if="identifyMethod === 'model-fit'" v-model.number="modelFitBackoff" type="number" step="0.05" :min="0.3" :max="0.9" label="P backoff fraction" density="compact" variant="outlined" hide-details style="max-width: 170px"><template #append-inner><HelpTip text="Fraction of the effort-rail-onset P used as the final P. Lower is quieter/safer, higher is faster/more aggressive. Default 0.65." /></template></v-text-field>
											<v-select v-if="identifyMethod !== 'model-fit'" v-model="seedRule" :items="SEED_RULES" item-title="title" item-value="value"
													  :disabled="!hasAxisSelected" density="compact" variant="outlined" hide-details
													  label="Ku/Tu seed rule" style="max-width: 280px">
												<template #append-inner><HelpTip text="Classical rule used to turn the identified Ku/Tu into starting P/I/D at the start of cycle 1 (axis drivers only). Tyreus–Luyben is the conservative default; zn-classic is Ziegler-Nichols' own gain formula." /></template>
											</v-select>
											<v-text-field v-if="identifyMethod !== 'model-fit' && seedRule === 'amigo'" v-model.number="seedLambda" type="number" step="0.1" label="λ (aggressiveness)" density="compact" variant="outlined" hide-details style="max-width: 160px"><template #append-inner><HelpTip text="Scales the AMIGO seed rule: >1 pushes the seeded gains hotter/faster, <1 backs them off. 1 = unscaled." /></template></v-text-field>
											<v-text-field v-model.number="medianOf" type="number" :min="1" :max="5" label="Captures per decision" density="compact" variant="outlined" hide-details style="max-width: 190px"><template #append-inner><HelpTip text="How many captures to median-combine before each decision. Higher rejects one-off glitches better but takes longer to run. 1 is the default; try 3 for a noisy encoder or a Thorough/Refine run." /></template></v-text-field>
											<v-text-field v-if="tuneMethod !== 'sequential'" v-model.number="captureBudget" type="number" :min="10" :max="200" label="Optimise capture budget" density="compact" variant="outlined" hide-details style="max-width: 200px"><template #append-inner><HelpTip text="Maximum captures the joint (package/refine) optimisation pass may spend before stopping with its best result so far. Default 40." /></template></v-text-field>
										</div>
									</v-expansion-panel-text>
								</v-expansion-panel>
							</v-expansion-panels>
							<div v-if="autoLog.length" ref="autoLogEl" class="cl-autolog mt-2">
								<div v-for="(line, idx) in autoLog" :key="idx">{{ line }}</div>
							</div>
							<div v-if="tuneSession && !autoRunning" class="d-flex align-center ga-2 mt-2">
								<v-btn size="small" variant="tonal" prepend-icon="mdi-download" @click="downloadTuningReport">Download results</v-btn>
								<HelpTip text="Saves the auto-tune session — log, final values, options used and every capture's metrics — as one JSON file (machine host details scrubbed). Full raw CSV is kept for notable (unstable) captures and the last capture of each term; check 'include all raw CSVs' to attach every one instead. Send it over if a result looks wrong and it can be analysed." />
								<v-checkbox v-model="includeAllCsv" label="Include all raw CSVs" density="compact" hide-details />
								<span class="text-caption text-medium-emphasis">{{ tuneSession.captures.length }} captures</span>
							</div>
						</v-card-text>
					</v-card>

					<v-expansion-panels v-if="!autoRunning" v-model="manualPanels" class="mt-2" variant="accordion">
						<v-expansion-panel>
							<v-expansion-panel-title>
								Manual tuning — optional (auto-tune already does this)
								<HelpTip class="ml-1" :href="DOCS.tuning" text="Tune one term at a time by hand: pick a term, run a step, read the recommendation, apply it. Only needed if you want to override the auto-tuner." />
							</v-expansion-panel-title>
							<v-expansion-panel-text>
								<v-row dense>
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
					</v-expansion-panel-text>
				</v-expansion-panel>
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
								<v-text-field v-if="moveMode === 'custom'" v-model="customMove" label="Move G-code" density="compact" variant="outlined" hide-details class="mb-2" placeholder="G91 G1 H2 X50 F6000 G90">
									<template #append-inner><HelpTip text="Unlike the auto-generated tuning moves, this distance is NOT checked against the axis's travel limits — it's your responsibility. The axis is still centred first if needed." /></template>
								</v-text-field>
								<div v-if="moveMode === 'custom' && axisTravelInfo" class="text-caption text-medium-emphasis mb-1">{{ axisTravelInfo }}</div>
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
						Run a test move — the <strong>Evaluation</strong> panel (right) grades it automatically and tells you exactly what, if anything, to change. No need to read the graph yourself.
						<HelpTip class="ml-1" :href="DOCS.tuning" text="The evaluation segments the move and measures the position error in each region (rest / accel / steady speed), in motor steps. A good drive holds the error to a small fraction of a step, centred on zero. Click for the wiki's annotated good-vs-bad example plots." />
					</v-alert>

					<v-row dense>
						<v-col cols="12" md="6">
							<v-card variant="outlined" class="mb-2">
								<v-card-title class="py-2 text-subtitle-2">Test move</v-card-title>
								<v-card-text>
									<v-text-field v-model="customMove" label="Test move G-code" density="compact" variant="outlined" hide-details class="mb-2" placeholder="G91 G1 H2 X50 F6000 G90">
										<template #append-inner><HelpTip text="A real G1 move (recorded while it runs). Watch Current Error in the plot — a well-tuned drive keeps it small and centred on zero. This distance isn't checked against the travel limits, so keep it within the range shown below." /></template>
									</v-text-field>
									<div v-if="axisTravelInfo" class="text-caption text-medium-emphasis mb-1">{{ axisTravelInfo }}</div>
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
									<v-btn size="x-small" variant="text" prepend-icon="mdi-content-save" :disabled="!selectedDriver" class="ml-1" @click="openSaveToConfigG">Save to config.g</v-btn>
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
				<v-card v-if="evaluation" class="mb-2" :variant="evaluation.grade === 'unknown' ? 'tonal' : 'flat'" :color="gradeColor(evaluation.grade)">
					<v-card-text class="py-3">
						<div class="d-flex align-center mb-1">
							<v-icon class="mr-2">{{ gradeIcon }}</v-icon>
							<span class="text-h6 text-capitalize">{{ evaluation.grade }}</span>
							<v-spacer />
							<span v-if="evaluation.grade !== 'unknown'" class="text-h6">{{ evaluation.score }}<span class="text-caption">/100</span></span>
							<HelpTip class="ml-1" text="An automatic verdict on the last capture: the plugin segments the move (rest / accelerating / steady speed), measures the position error in each region in motor steps, and grades it. Each point below names the term to change and which way." />
						</div>
						<div class="text-body-2 cl-on-grade mb-2">{{ evaluation.headline }}</div>
						<v-list density="compact" class="cl-eval-list pa-0" bg-color="transparent">
							<v-list-item v-for="(f, i) in evaluation.findings" :key="i" class="px-0">
								<template #prepend>
									<v-icon size="small" :color="severityColor(f.severity)" class="mr-2">{{ severityIcon(f.severity) }}</v-icon>
								</template>
								<v-list-item-title class="text-body-2">{{ f.title }}</v-list-item-title>
								<v-list-item-subtitle class="cl-finding-detail">{{ f.detail }}</v-list-item-subtitle>
								<div v-if="f.fix" class="d-flex align-center ga-1 mt-1">
									<v-icon size="x-small">mdi-arrow-right-bold</v-icon>
									<span class="text-caption font-weight-medium">{{ f.fix }}</span>
									<v-btn v-if="f.term" size="x-small" variant="tonal" class="ml-1" @click="goToManualTerm(f.term)">Tune {{ f.term.toUpperCase() }}</v-btn>
								</div>
							</v-list-item>
						</v-list>
					</v-card-text>
				</v-card>
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
					<div style="white-space: pre-line;">{{ confirmMessage }}</div>
					<div class="text-caption text-medium-emphasis mt-2"><code>{{ confirmCommand }}</code></div>
				</v-card-text>
				<v-card-actions>
					<v-spacer />
					<v-btn variant="text" @click="confirmCancel">Cancel</v-btn>
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
					<v-btn variant="text" @click="configWriteConfirmOpen = false">Cancel</v-btn>
					<v-btn color="primary" :loading="savingConfig" @click="confirmSaveToConfigG">Write config.g</v-btn>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</v-container>
</template>

<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";

import { useMachineStore } from "@/stores/machine";
import { LogLevel, useUiStore } from "@/stores/ui";

import { HelpTip, buildReport, downloadReport, AboutDialog, type AboutExtraAction } from "dwc-plugin-runtime";

import CaptureChart from "./CaptureChart.vue";
import { evaluateTune, gradeColor, severityColor, severityIcon, type Term, type TuneEvaluation } from "../model/evaluate";
import { CAPTURE_DIR, CONFIG_FILE, DOCS, LS_STATE, PLUGIN_ID } from "../model/constants";
import { upsertTuneBlock } from "../model/config";
import { stepJumpDistanceMm, stepJumpFeedMmPerMin } from "../model/scale";
import {
	buildCalibrationCommand, buildCaptureCommand, buildModeCommand, buildPidCommand,
	CALIBRATION_MOVES, CAPTURE_VARIABLES, DEFAULT_MODE_D, ENCODER_TYPES, MODE_LABELS,
	parsePidReply, type CalibrationMove, type EncoderType, type LoopMode, type PidConfig,
} from "../model/m569";
import { parseCapture, type ParsedCapture } from "../model/csv";
import { analyzeCapture, type StepMetrics } from "../model/analysis";
import {
	CENTER_TOLERANCE_MM, CENTERING_FEED_MM_MIN, DEFAULT_MARGIN_MM,
	getAxisLimits, midpoint, planCaptureProfile, planCoupledSymmetricMove, type CoupledAxisLimits,
} from "../model/limits";
import { resolveMotionCoupling } from "../model/kinematics";
import { WIZARD_STEPS, type Recommendation } from "../model/wizard";
import { computeTuneSignal, type TuneSignal } from "../model/signal";
import {
	runAutoTune as runAutoTuneCore,
	type AutoRunOptions, type AutoRunResult, type IdentifyMethod, type SeedRule, type StageId, type StageState,
	type TuneEffects, type TuneMethod,
} from "../model/autorun";
import { downsampleCapture, shapeCapturesForDownload, slimModelForReport, type ReportCapture } from "../model/report";
import { applying, applyUpdateNow, checking, dismissCurrentUpdate, pendingReload, runUpdateCheck, setUpdateChecksEnabled, updateChecksEnabled, updateState } from "../model/updateCheck";

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
	recordKeys?: Array<string>; viewKeys?: Array<string>; avFeed?: number; cycles?: number;
	marginMm?: number;
	/** Tuning move distance, mm; 0/undefined = auto (longest reasonable). New key (not `avDistance`) so
	 * an existing session's persisted 50 mm default doesn't silently keep overriding the new auto mode. */
	tuneDistanceMm?: number;
	tuneMethod?: TuneMethod; identifyMethod?: IdentifyMethod; modelFitBackoff?: number;
	seedRule?: SeedRule; seedLambda?: number; medianOf?: number; captureBudget?: number;
	includeAllCsv?: boolean;
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
				tuneDistanceMm: avDistance.value, avFeed: avFeed.value, cycles: cycles.value, marginMm: marginMm.value,
				tuneMethod: tuneMethod.value, identifyMethod: identifyMethod.value, modelFitBackoff: modelFitBackoff.value,
				seedRule: seedRule.value, seedLambda: seedLambda.value, medianOf: medianOf.value,
				captureBudget: captureBudget.value, includeAllCsv: includeAllCsv.value,
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

// Stage-status timeline: preflight → P → A → V → D → I → [optimize] → verify (P–I repeat every cycle;
// "optimize" only fires for the package/refine methods, so it's only shown then).
const STAGE_ORDER = computed<Array<{ id: StageId; label: string }>>(() => {
	const order: Array<{ id: StageId; label: string }> = [
		{ id: "preflight", label: "Preflight" }, { id: "p", label: "P" }, { id: "a", label: "A" },
		{ id: "v", label: "V" }, { id: "d", label: "D" }, { id: "i", label: "I" },
	];
	if (tuneMethod.value !== "sequential") { order.push({ id: "optimize", label: "Optimise" }); }
	order.push({ id: "verify", label: "Verify" });
	return order;
});
const stageStates = reactive<Record<StageId, StageState>>({ preflight: "pending", p: "pending", d: "pending", i: "pending", a: "pending", v: "pending", optimize: "pending", verify: "pending" });
function resetStageStates(): void { for (const id of Object.keys(stageStates) as Array<StageId>) { stageStates[id] = "pending"; } }
function stageColor(state: StageState): string | undefined {
	switch (state) {
		case "running": return "primary";
		case "done": return "success";
		case "failed": return "error";
		default: return undefined;
	}
}
function stageIcon(state: StageState): string {
	switch (state) {
		case "running": return "mdi-progress-clock";
		case "done": return "mdi-check-circle";
		case "failed": return "mdi-close-circle";
		default: return "mdi-circle-outline";
	}
}
const avDistance = ref(saved.tuneDistanceMm ?? 0); // mm — tuning move length; 0 = auto (longest reasonable)
const avFeed = ref(saved.avFeed ?? 6000);          // mm/min — A/V test move feedrate
const cycles = ref(saved.cycles ?? 3);             // how many times to iterate P→A→V→D→I
const marginMm = ref(saved.marginMm ?? DEFAULT_MARGIN_MM); // mm — kept clear of each travel limit

// Tuning method (axis drivers only — extruders always use "sequential") + its advanced options.
const TUNE_METHODS: Array<{ value: TuneMethod; label: string; subtitle: string }> = [
	{ value: "sequential", label: "Standard", subtitle: "Duet order (P→A→V→D→I), then refine every term each cycle." },
	{ value: "package", label: "Thorough", subtitle: "Standard first pass, then jointly optimise every term together under a capture budget." },
	{ value: "refine", label: "Refine", subtitle: "Jointly optimise from whatever's on the driver now — no reset, no from-scratch ramp." },
];
const tuneMethod = ref<TuneMethod>(saved.tuneMethod ?? "sequential");
const IDENTIFY_METHODS: Array<{ value: IdentifyMethod; label: string }> = [
	{ value: "model-fit", label: "Model fit" },
	{ value: "continuous-cycling", label: "Continuous cycling" },
	{ value: "relay", label: "Relay feedback" },
];
const identifyMethod = ref<IdentifyMethod>(saved.identifyMethod ?? "model-fit");
const modelFitBackoff = ref(saved.modelFitBackoff ?? 0.65); // fraction of the effort-rail-onset P used as P*
const SEED_RULES: Array<{ value: SeedRule; title: string }> = [
	{ value: "tyreus-luyben", title: "Tyreus–Luyben (conservative, default)" },
	{ value: "zn-classic", title: "Ziegler–Nichols (classic)" },
	{ value: "amigo", title: "AMIGO-scaled (λ below)" },
];
const seedRule = ref<SeedRule>(saved.seedRule ?? "tyreus-luyben");
const seedLambda = ref(saved.seedLambda ?? 1);       // aggressiveness for the "amigo" seed rule
const medianOf = ref(saved.medianOf ?? 1);           // captures per decision, median-combined
const captureBudget = ref(saved.captureBudget ?? 40); // extra captures for the package/refine joint optimiser
const includeAllCsv = ref(saved.includeAllCsv ?? false); // download every capture's raw CSV, not just the notable/last-per-phase ones
watch([avDistance, avFeed, cycles, marginMm, tuneMethod, identifyMethod, modelFitBackoff, seedRule, seedLambda, medianOf, captureBudget, includeAllCsv], persistState);

/** Rough move-count estimate shown next to the method select, so the cost of "Thorough" is visible upfront. */
const estimatedMoves = computed(() => {
	const perRampCycle = 5 * 6;   // 5 terms × ~6 captures (ramp + verify) for a from-scratch cycle
	const perRefineCycle = 5 * 3; // 5 terms × ~3 captures (up/down probe + verify) for a refinement cycle
	switch (tuneMethod.value) {
		case "refine": return captureBudget.value;
		case "package": return perRampCycle + captureBudget.value;
		default: return perRampCycle + Math.max(0, cycles.value - 1) * perRefineCycle;
	}
});

const confirmOpen = ref(false);
const confirmCommand = ref("");
const confirmMessage = ref("");
const DEFAULT_CONFIRM_MESSAGE = "This will move the selected driver. On an axis with known travel limits it "
	+ "will first centre the axis and then keep moves within the configured margin of min/max — but that only "
	+ "works once the axis is homed. Extruders, or axes the object model hasn't reported a position for yet, "
	+ "aren't checked at all, so make sure there's room to move.";
let confirmAction: (() => Promise<void>) | null = null;
let confirmResolve: ((ok: boolean) => void) | null = null;

// --- About dialog + manual-panel control + live evaluation ---
const aboutOpen = ref(false);
const manualPanels = ref<number | undefined>(undefined);
const autoLogEl = ref<HTMLElement | null>(null);

/** Automatic plain-language verdict on the most recent capture (see model/evaluate.ts). */
const evaluation = computed<TuneEvaluation | null>(() => capture.value ? evaluateTune(capture.value, sampleRate.value) : null);
const gradeIcon = computed(() => {
	switch (evaluation.value?.grade) {
		case "excellent": return "mdi-star-circle";
		case "good": return "mdi-check-circle";
		case "fair": return "mdi-alert-circle";
		case "poor": return "mdi-close-circle";
		default: return "mdi-help-circle";
	}
});
/** Jump to a term in the manual tuner (expands the panel) when the user clicks a fix suggestion. */
function goToManualTerm(term: Term): void {
	const idx = WIZARD_STEPS.findIndex((s) => s.term === term);
	if (idx >= 0) { wizardIndex.value = idx; }
	manualPanels.value = 0;
	step.value = 4;
}

// Keep the auto-tune log scrolled to the newest line.
watch(() => autoLog.value.length, () => { void nextTick(() => { const el = autoLogEl.value; if (el) { el.scrollTop = el.scrollHeight; } }); });

// --- Auto-tune session capture (for the downloadable results report) ---
// A run makes 30-60+ captures; storing the full raw CSV for every one of them made the report several
// MB. Each capture now always carries a compact downsampled error series + its metrics, and only keeps
// its full CSV when `shapeCapturesForDownload` decides it's worth it (see report.ts) — the raw text is
// still HELD in memory for the whole session so "include all raw CSVs" can restore it on demand.
interface SessionCapture extends ReportCapture { /* seq/phase/value/metrics/series/csv/notable — see report.ts */ }
interface StageEvent { stage: StageId; state: StageState; at: string }
interface TuneSession {
	startedAt: string; finishedAt?: string; driver: string | null; mode: LoopMode | null;
	encoderType: EncoderType; cycles: number; finalPid?: PidConfig; log: Array<string>;
	captures: Array<SessionCapture>; evaluation?: TuneEvaluation | null;
	/** Ultimate gain/period found during Ku/Tu seeding, when it succeeded. */
	ku?: number; tu?: number;
	/** Calibration moves (M569.6 V-ids) actually run during preflight. */
	preflightActions?: Array<string>;
	/** True if the run failed/was cancelled and the pre-run PID snapshot was restored. */
	restored?: boolean;
	/** Tuning method actually used ("sequential" always, for extruders regardless of the UI selection). */
	method?: TuneMethod;
	/** The full option set the run was started with — method, order, medianOf, budget, seed rule. */
	optionsUsed?: AutoRunOptions;
	/** Stage transitions with timestamps, for reconstructing the run's timeline from the report alone. */
	stageTimeline: Array<StageEvent>;
	reportVersion: number;
}
const REPORT_VERSION = 2;
const tuneSession = ref<TuneSession | null>(null);
/** Instability threshold shared with signal.ts's SAT_DUTY_LIMIT — both TuneSignal and StepMetrics carry this field. */
const REPORT_NOTABLE_SAT_DUTY = 0.12;
let sessionSeq = 0;
/** Uncapped session log (the report's own copy) — `autoLog` stays capped at 40 lines for display only. */
let sessionLog: Array<string> = [];
function recordSessionCapture(phase: string, value: number | undefined, metrics: unknown): void {
	if (!tuneSession.value || !rawText.value) { return; }
	const series = capture.value ? (downsampleCapture(capture.value, sampleRate.value) ?? undefined) : undefined;
	const m = metrics as { pTermSatDuty?: number } | null;
	const notable = !!(m && typeof m.pTermSatDuty === "number" && m.pTermSatDuty >= REPORT_NOTABLE_SAT_DUTY);
	tuneSession.value.captures.push({ seq: sessionSeq++, phase, value, metrics, series, csv: rawText.value, notable });
}
function downloadTuningReport(): void {
	if (!tuneSession.value) { return; }
	const version = ((machineStore.model as any)?.plugins?.get?.("ClosedLoopTuning")?.version) ?? "unknown";
	const axisObj = axisForDriver();
	const model = slimModelForReport(
		selectedBoard.value ? { firmwareName: selectedBoard.value.firmwareName, firmwareVersion: selectedBoard.value.firmwareVersion, canAddress: selectedBoard.value.canAddress, closedLoop: selectedBoard.value.closedLoop } : null,
		(machineStore.model as any).move?.kinematics?.name,
		axisObj ? { letter: axisObj.letter, min: axisObj.min, max: axisObj.max, stepsPerMm: axisObj.stepsPerMm, microstepping: axisObj.microstepping, homed: axisObj.homed } : null,
	);
	const state: TuneSession = { ...tuneSession.value, captures: shapeCapturesForDownload(tuneSession.value.captures, includeAllCsv.value) };
	const report = buildReport({ pluginId: PLUGIN_ID, pluginVersion: version, model, state, note: "Closed Loop auto-tune session (log + capture summaries; full CSV kept for notable/final captures unless \"include all\" was checked)" });
	downloadReport(report, `closed-loop-tuning-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
}

// About dialog (standardised runtime AboutDialog) wiring.
const aboutDescription = "Tunes Duet 3 closed-loop drivers: loop mode, encoder calibration, and automatic PID + feed-forward tuning with capture analysis.";
const autoCheck = ref(updateChecksEnabled());
const aboutExtraActions = computed<Array<AboutExtraAction>>(() => [
	{ label: tuneSession.value ? "Download tuning report" : "Download tuning report (run auto-tune first)", icon: "mdi-download", color: "primary", disabled: !tuneSession.value, onClick: downloadTuningReport },
]);
function onCheckUpdate(): void { void runUpdateCheck({ force: true, notify: true }); }
function onToggleAutoCheck(v: boolean): void { autoCheck.value = v; setUpdateChecksEnabled(v); }

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
	// Closed-loop support shows up in the object model two different ways (@duet3d/objectmodel):
	//  - `board.closedLoop` ({ points, runs }) — an aggregate Duet3D's own 1HCL/M23CL firmware populates,
	//    and the same field this plugin's capture-completion detection watches (see `record()`/`waitForRuns`).
	//  - `board.drivers[i].closedLoop` ({ currentFraction, positionError }) — generic per-driver closed-
	//    loop telemetry that ANY RRF board running closed-loop control populates, Duet or third-party.
	// A third-party closed-loop toolboard may report the second without the first, so a driver counts as
	// closed-loop-capable if EITHER is present — checking only the board-level aggregate (as before)
	// hid every non-Duet3D closed-loop driver from the list entirely.
	const hasCl = (boardAddr: string, driverIndex: number) => {
		const board = boards.find((b: any) => b && b.canAddress === parseInt(boardAddr));
		if (!board) { return false; }
		if (board.closedLoop != null) { return true; }
		return board.drivers?.[driverIndex]?.closedLoop != null;
	};
	const out: Array<DriverEntry> = [];
	for (const axis of model.move?.axes ?? []) {
		for (const drv of axis.drivers ?? []) {
			const id = `${drv.board}.${drv.driver}`;
			if (hasCl(String(drv.board), drv.driver)) { out.push({ name: `${axis.letter} axis (driver ${id})`, value: id }); }
		}
	}
	(model.move?.extruders ?? []).forEach((ex: any, idx: number) => {
		const drv = ex?.driver;
		if (!drv) { return; }
		const id = `${drv.board}.${drv.driver}`;
		if (hasCl(String(drv.board), drv.driver)) { out.push({ name: `Extruder ${idx} (driver ${id})`, value: id }); }
	});
	return out;
});

const selectedBoard = computed<any>(() => {
	if (!selectedDriver.value) { return null; }
	const addr = parseInt(selectedDriver.value.split(".")[0]);
	return (machineStore.model as any).boards?.find((b: any) => b && b.canAddress === addr) ?? null;
});

/** The axis object the selected driver belongs to (null for extruders / unknown). */
function axisForDriver(): any {
	if (!selectedDriver.value) { return null; }
	return (machineStore.model as any).move?.axes?.find((a: any) => (a.drivers ?? []).some((d: any) => `${d.board}.${d.driver}` === selectedDriver.value)) ?? null;
}
/** Index of the selected driver's axis into move.axes[] — the column kinematics.ts needs to resolve
 * which OTHER axes a G1 H2 move on this driver's own motor also displaces (see coupledAxesForDriver). */
function axisIndexForDriver(): number | null {
	if (!selectedDriver.value) { return null; }
	const axes = (machineStore.model as any).move?.axes ?? [];
	const idx = axes.findIndex((a: any) => (a.drivers ?? []).some((d: any) => `${d.board}.${d.driver}` === selectedDriver.value));
	return idx >= 0 ? idx : null;
}
/** True once a driver with an axis is selected — reactive, so template usage doesn't call a plain function on every render. */
const hasAxisSelected = computed(() => !!axisForDriver()?.letter);

let loggedCouplingFor: string | null = null;

/**
 * Every axis a G1 H2 move on the selected driver actually displaces, with travel limits AND the
 * kinematics-derived perUnit (see kinematics.ts) — `[]` for extruders (no axis to couple). Returns an
 * error (never a silent Cartesian guess) when the kinematics can't be resolved, a coupled axis's limits
 * aren't available, or a coupled axis isn't homed — an unhomed coupled axis means its position is
 * unknown, so the move can't be proven safe even if the TUNED axis itself is homed.
 */
function coupledAxesForDriver(): Array<CoupledAxisLimits> | { error: string } {
	const axisObj = axisForDriver();
	if (!axisObj) { return []; }
	const index = axisIndexForDriver();
	if (index === null) { return { error: "Could not resolve the selected driver's axis index." }; }
	const axes = (machineStore.model as any).move?.axes ?? [];
	const kinematics = (machineStore.model as any).move?.kinematics;
	const coupling = resolveMotionCoupling(kinematics, axes, index);
	if ("error" in coupling) { return coupling; }
	const out: Array<CoupledAxisLimits> = [];
	for (const effect of coupling.effects) {
		const limits = getAxisLimits(axes[effect.index]);
		if (!limits) { return { error: `${effect.letter}: axis limits/position not available.` }; }
		if (!limits.homed) {
			return { error: `${effect.letter} is not homed — home it first. This axis is coupled to ${coupling.letter}'s motor `
				+ `(${coupling.kinematicsName} kinematics), so its position must be known before tuning ${coupling.letter}.` };
		}
		out.push({ ...limits, perUnit: effect.perUnit });
	}
	if (coupling.effects.length > 1 && loggedCouplingFor !== selectedDriver.value) {
		loggedCouplingFor = selectedDriver.value;
		const parts = coupling.effects.map((e) => `${e.letter} by ${e.perUnit >= 0 ? "+" : ""}${e.perUnit.toFixed(3)} mm`).join(" and ");
		log(`Kinematics: ${coupling.kinematicsName} — tuning ${coupling.letter} moves ${parts} per mm of motor travel.`);
	}
	return out;
}

/** Human-readable summary of the driver's axis travel/position, shown next to the safety margin setting. */
const axisTravelInfo = computed(() => {
	const limits = getAxisLimits(axisForDriver());
	if (!limits) { return ""; }
	const homedNote = limits.homed ? "" : " — NOT HOMED, moves will be refused";
	return `${limits.letter}: travel ${limits.min}–${limits.max} mm, currently ${limits.position.toFixed(1)} mm, `
		+ `${marginMm.value} mm margin${homedNote}`;
});

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
		case 3: return "Duet3D magnetic encoder: run Magnetic encoder calibration (V2) once. It's stored in the board's flash and survives power cycles.";
		case 1: return "Linear composite encoder: run Magnetic encoder calibration (V2) then Polarity & zeroing (V1) once. Stored in flash.";
		default: return "No encoder selected. Set the encoder type in config.g with M569.1 T (T1/T2/T3) and pick it here.";
	}
});
function runCalibration(c: CalibrationMove): void {
	if (!selectedDriver.value) { return; }
	askConfirm(buildCalibrationCommand(selectedDriver.value, c.id), async () => { await send(buildCalibrationCommand(selectedDriver.value!, c.id)); });
}

/** Non-interactive calibration for auto-tune's preflight — already covered by the upfront consent dialog. */
async function runCalibrationSilent(moveId: number): Promise<string> {
	if (!selectedDriver.value) { return "No driver selected."; }
	try {
		return await machineStore.sendCode(buildCalibrationCommand(selectedDriver.value, moveId), false, false);
	} catch (e) { console.warn("[ClosedLoopTuning] runCalibrationSilent failed", e); return `Error: ${e instanceof Error ? e.message : String(e)}`; }
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
	// Centre first if needed — this doesn't bounds-check a custom move's distance (it's arbitrary
	// G-code), only makes sure every axis this driver's motor can move is starting from its own midpoint.
	const coupledForRecord = coupledAxesForDriver();
	if ("error" in coupledForRecord) { uiStore.makeNotification(LogLevel.error, "Closed Loop Tuning", coupledForRecord.error); return; }
	if (!(await ensureAxisReady(coupledForRecord))) { return; }
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
	// Use the same G1-move step capture as auto-tune (the V64 manoeuvre doesn't move on all setups).
	recording.value = true;
	try { await captureStep(); } finally { recording.value = false; }
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

/** Every recordable variable — used for the auto-generated captures (wizard step, auto-tune's own
 * decision captures, the step-5 test move) so as much diagnostic overlay data as possible is available
 * on the shared chart afterward, without the user having to run a separate manual "Advanced capture"
 * to get it. `viewKeys`/`recordKeys` defaults still start with only a few lines selected — this only
 * controls what's AVAILABLE to tick on, not what's shown by default. If firmware can't buffer this many
 * columns at the requested sample count, `runCapture` already surfaces that as a clear "Firmware
 * rejected the capture" error rather than failing silently. */
const ALL_CAPTURE_KEYS = CAPTURE_VARIABLES.map((v) => v.key);

/** Seeds a sensible starting chart selection only when there isn't one yet (nothing ticked) — never
 * overwrites a selection the user already made. Without this, every capture (including each of auto-
 * tune's own internal decision captures) used to stomp the checkboxes back to a hardcoded default,
 * resetting whatever the user had just ticked to look at. */
function ensureViewKeys(defaults: Array<string>): void {
	if (viewKeys.value.length === 0) { viewKeys.value = defaults; }
}

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

const MIN_STEP_DISTANCE_FRACTION = 0.5; // require at least half the intended step-jump distance to bother capturing

/**
 * Gate before any axis-moving capture. Tuning moves use G1's H2 (individual motor) mode, which drives
 * one axis's own motor directly and bypasses RRF's kinematics — so M208 soft limits never apply to
 * them. On coupled kinematics (CoreXY etc.) that single motor can displace MORE than one Cartesian axis
 * (see kinematics.ts) — `axes` must already be the full coupled set from `coupledAxesForDriver()`,
 * every one of them homed (that function's own job), or this can't prove the move is safe.
 *
 * If any coupled axis isn't already near the middle of its own travel, warns the user and moves ALL of
 * them there together via one normal (kinematics-respecting) multi-axis G1 move, so the tuning move has
 * room on every side it can actually reach. No-op when `axes` is empty (extruder — no axis to couple).
 *
 * `centerToMid: false` skips the move-to-mid leg entirely — for a caller that's about to reposition to
 * its own precisely-planned, already-safety-clamped start positions regardless (see `captureRaw`),
 * routing through the midpoint first is just an extra physical round trip.
 */
async function ensureAxisReady(axes: Array<CoupledAxisLimits>, opts: { centerToMid?: boolean } = {}): Promise<boolean> {
	if (axes.length === 0) { return true; }
	if (opts.centerToMid === false) { return true; }
	const targets = axes.filter((a) => Math.abs(midpoint(a) - a.position) >= CENTER_TOLERANCE_MM);
	if (targets.length === 0) { return true; }
	const letters = targets.map((a) => a.letter).join(", ");
	const move = `G90 G1 ${targets.map((a) => `${a.letter}${midpoint(a).toFixed(3)}`).join(" ")} F${CENTERING_FEED_MM_MIN}`;
	if (autoRunning.value) {
		// Auto-tune's upfront consent dialog already covers centering moves — no per-move prompt mid-run.
		log(`Centering ${letters} to ${targets.length > 1 ? "their" : "its"} travel midpoint — consented to upfront.`);
	} else {
		const message = `Before tuning, ${letters} will move to the middle of ${targets.length > 1 ? "their" : "its"} travel `
			+ `so there's room to move safely in every direction this driver's motor affects. `
			+ `Make sure the axes are clear, then proceed.`;
		if (!(await confirmAsync(message, move))) { return false; }
	}
	await send(move);
	await send("M400"); // block until the centering move finishes
	await delay(400);    // let the object model catch up before we read the new position back
	return true;
}

/**
 * Step-response capture (for P/D/I). Uses a small, fast G1 move (~16 full steps) which behaves like a
 * step jump — the firmware V64 manoeuvre doesn't reliably move on all setups, whereas a real
 * closed-loop G1 move does (it's also what the official plugin/wiki tune from). The outward move is
 * captured, then the axis is returned to its start. Falls back to V64 for drivers with no axis (extruders).
 * The direction and distance are chosen to stay within the configured margin of the axis's travel limits.
 */
async function captureStep(): Promise<StepMetrics | null> {
	const ax = axisForDriver();
	const coupled = coupledAxesForDriver();
	if ("error" in coupled) { log(`Step capture: ${coupled.error}`); uiStore.makeNotification(LogLevel.error, "Closed Loop Tuning", coupled.error); return null; }
	if (!(await ensureAxisReady(coupled))) { return null; }
	const freshCoupled = coupledAxesForDriver(); // re-read: ensureAxisReady may have moved the axes
	if ("error" in freshCoupled) { log(`Step capture: ${freshCoupled.error}`); uiStore.makeNotification(LogLevel.error, "Closed Loop Tuning", freshCoupled.error); return null; }
	const stepVars = varIds(ALL_CAPTURE_KEYS);
	let c: ParsedCapture | null;
	if (ax?.letter) {
		const desired = stepJumpDistanceMm({ stepsPerMm: Number(ax.stepsPerMm), microstepping: Number(ax.microstepping?.value) });
		let dist = desired;
		let sign: 1 | -1 = 1;
		if (freshCoupled.length > 0) {
			const plan = planCoupledSymmetricMove(freshCoupled, desired, marginMm.value, desired * MIN_STEP_DISTANCE_FRACTION);
			if ("error" in plan) { log(`Step capture: ${plan.error}`); uiStore.makeNotification(LogLevel.error, "Closed Loop Tuning", plan.error); return null; }
			dist = plan.distance; sign = plan.sign;
		}
		const signedDist = sign * dist;
		const feed = stepJumpFeedMmPerMin(dist).toFixed(0);
		const move = `G91 G1 H2 ${ax.letter}${signedDist.toFixed(3)} F${feed} G90`;
		c = await runCapture({ driver: selectedDriver.value ?? "", samples: samples.value, activate: 1, rate: sampleRate.value, variables: stepVars, manoeuvre: 0, move });
		try { await machineStore.sendCode(`G91 G1 H2 ${ax.letter}${(-signedDist).toFixed(3)} F${feed} G90`, false, false); } catch { /* return move */ }
	} else {
		c = await runCapture({ driver: selectedDriver.value ?? "", samples: samples.value, activate: 0, rate: sampleRate.value, variables: stepVars, manoeuvre: 64 });
	}
	if (!c) { return null; }
	metrics.value = analyzeCapture(c, sampleRate.value);
	return metrics.value;
}

/**
 * Single trapezoid-move capture for the unified P/D/I/A/V tuning signal. One G1 H2 move sized (via
 * `planCaptureProfile`) so the capture window holds both a real accel/cruise/decel section AND a
 * meaningful at-rest tail — the same capture serves every term's decision instead of a separate
 * "step" move and "A/V" move judged by different (and, for step, wrong) metrics.
 *
 * The move is CENTRED on every coupled axis's own midpoint (not just started from it): `planCaptureProfile`
 * derives each `startPositions` entry (mid − perUnit·d/2) from that axis's own min/max alone, so this
 * pre-positions straight there in one hop (no intermediate stop at mid) before the H2 move — using the
 * full clear travel on every axis the tuned motor actually displaces (see limits.ts / kinematics.ts),
 * not just the nominal one. Distance defaults to "auto" (0 = longest reasonable motor-space move, up to
 * `AUTO_MOVE_CAP_MM`), which also derives the sample rate from the move's own duration; the returned
 * `rateHz` is what was actually used, for the caller to pass to analysis so it matches what the
 * firmware was told to capture at.
 */
interface RawCaptureResult {
	capture: ParsedCapture;
	rateHz: number;
}

/**
 * The unified trapezoid-move capture, shared by `captureSignal` (tuning decisions → TuneSignal) and
 * `evaluateCapture` (final-verification grading → TuneEvaluation) so both analyse the exact same kind
 * of move instead of duplicating the move-planning/execution logic.
 */
async function captureRaw(): Promise<RawCaptureResult | null> {
	const axisObj = axisForDriver();
	const axis = axisObj?.letter ?? null;
	if (!axis) { uiStore.makeNotification(LogLevel.warning, "Closed Loop Tuning", "Signal-based tuning needs the driver's axis — skipped."); return null; }
	const coupled = coupledAxesForDriver();
	if ("error" in coupled) { log(`Tuning capture: ${coupled.error}`); uiStore.makeNotification(LogLevel.error, "Closed Loop Tuning", coupled.error); return null; }
	// No move-to-mid here: planCaptureProfile below computes each start position from every coupled
	// axis's own min/max alone (never from current position), so centering to mid first would just be
	// an extra round trip before the explicit reposition a few lines down. Only the homed check applies.
	if (!(await ensureAxisReady(coupled, { centerToMid: false }))) { return null; }
	const freshCoupled = coupledAxesForDriver();
	if ("error" in freshCoupled) { log(`Tuning capture: ${freshCoupled.error}`); uiStore.makeNotification(LogLevel.error, "Closed Loop Tuning", freshCoupled.error); return null; }
	const profile = planCaptureProfile(freshCoupled, avFeed.value, samples.value, sampleRate.value, marginMm.value, { maxDistanceMm: avDistance.value });
	if ("error" in profile) { log(`Tuning capture: ${profile.error}`); uiStore.makeNotification(LogLevel.error, "Closed Loop Tuning", profile.error); return null; }

	// Centre the MOVE on every coupled axis's own midpoint, not just the nominal one: pre-position ALL
	// of them via one normal, soft-limit-respecting multi-axis G1 before the H2 tuning move — this is
	// what unlocks the full clear travel on every axis the tuned motor actually displaces, instead of
	// only the half reachable by moving one-way from the midpoint (or, on coupled kinematics, checking
	// only the nominal axis while another one the same motor moves goes completely unchecked).
	const needsReposition = profile.startPositions.some((sp) => {
		const current = freshCoupled.find((a) => a.letter === sp.letter);
		return !current || Math.abs(sp.position - current.position) > CENTER_TOLERANCE_MM;
	});
	if (needsReposition) {
		const letters = profile.startPositions.map((sp) => sp.letter).join(", ");
		const move = `G90 G1 ${profile.startPositions.map((sp) => `${sp.letter}${sp.position.toFixed(3)}`).join(" ")} F${CENTERING_FEED_MM_MIN}`;
		const limitNote = profile.limitedBy ? `, limited by ${profile.limitedBy}` : "";
		log(`Positioning ${letters} for a ${profile.distance.toFixed(0)} mm centred tuning move${limitNote}.`);
		await send(move);
		await send("M400");
		await delay(400);
	}

	const signedDist = profile.sign * profile.distance;
	ensureViewKeys(["measuredMotorSteps", "targetMotorSteps", "pidPTerm"]);
	const c = await runCapture({
		driver: selectedDriver.value ?? "", samples: samples.value, activate: 1, rate: profile.sampleRateHz,
		variables: varIds(ALL_CAPTURE_KEYS), manoeuvre: 0,
		move: `G91 G1 H2 ${axis}${signedDist.toFixed(3)} F${avFeed.value} G90`,
	});
	try { await machineStore.sendCode(`G91 G1 H2 ${axis}${(-signedDist).toFixed(3)} F${avFeed.value} G90`, false, false); } catch { /* ignore return-move error */ }
	return c ? { capture: c, rateHz: profile.sampleRateHz } : null;
}

async function captureSignal(): Promise<TuneSignal | null> {
	const result = await captureRaw();
	return result ? computeTuneSignal(result.capture, result.rateHz) : null;
}

/** Final-verification grading: a fresh capture judged the same way the Step-5 evaluation panel does. */
async function evaluateCapture(): Promise<TuneEvaluation | null> {
	const result = await captureRaw();
	return result ? evaluateTune(result.capture, result.rateHz) : null;
}

function log(line: string): void {
	sessionLog.push(line); // uncapped — this is what the downloadable report uses
	autoLog.value = [...autoLog.value, line]; // uncapped — display keeps the full run so it can be copied out
}

/**
 * Read the driver's current PID back from the firmware (a fresh snapshot, independent of the `pid`
 * reactive) — this is what auto-tune restores to if the run is cancelled or fails partway through.
 */
async function readPidSnapshot(): Promise<PidConfig | null> {
	if (!selectedDriver.value) { return null; }
	try {
		const reply = await machineStore.sendCode(`M569.1 P${selectedDriver.value}`, false, false);
		return parsePidReply(reply);
	} catch (e) { console.warn("[ClosedLoopTuning] readPidSnapshot failed", e); return null; }
}

/** Wire the orchestrator in src/model/autorun.ts to this component's G-code/UI side effects. */
function buildTuneEffects(): TuneEffects {
	return {
		applyPid: async (p) => { Object.assign(pid, p); await applyPid(); },
		readPid: readPidSnapshot,
		captureSignal,
		captureStep,
		runCalibration: runCalibrationSilent,
		evaluateCapture,
		ensureReady: async () => {
			// The step/signal captures only move in closed/assisted loop, and the board can come up in
			// open loop after a reboot/reload. Uses the corrected mode command (D only — never S, which
			// is direction). This does NOT calibrate; that's the user's job (Step 3).
			const mode: LoopMode = currentMode.value === "assisted" ? "assisted" : "closed";
			log(`Ensuring ${MODE_LABELS[mode]} — ${buildModeCommand(selectedDriver.value ?? "", mode, modeD)}`);
			await send(buildModeCommand(selectedDriver.value ?? "", mode, modeD));
			currentMode.value = mode;
			await delay(600);
			return true; // per-capture axis centering/homing checks happen inside captureSignal/captureStep
		},
		log,
		status: (s) => { autoStatus.value = s; },
		onAttempt: (term, value, metric) => {
			wizardIndex.value = WIZARD_STEPS.findIndex((s) => s.term === term);
			recordSessionCapture(term, value, metric);
		},
		onStage: (stage, state) => {
			stageStates[stage] = state;
			if (tuneSession.value) { tuneSession.value.stageTimeline.push({ stage, state, at: new Date().toISOString() }); }
		},
		isCancelled: () => autoCancel.value,
		delay,
	};
}

const METHOD_CONSENT_TEXT: Record<TuneMethod, string> = {
	sequential: "tuning P → A → V → D → I from the same trapezoid move each time (starting with a brief search for a good starting point), then refining every term again each cycle",
	package: "tuning P → A → V → D → I once to get a good starting point, then jointly optimising every term together against a single whole-loop score",
	refine: "jointly optimising every term together, starting from the PID values already on the driver — no reset, no from-scratch ramp",
};

function startAutoTune(): void {
	if (!selectedDriver.value) { return; }
	const hasAxis = hasAxisSelected.value;
	const msg = hasAxis
		? "Auto-tune will run everything below without asking again — make sure the axis is clear and you've calibrated (Step 3) and homed it:\n"
			+ "• Switch to closed/assisted loop.\n"
			+ "• Check the driver is tracking a move; if not, run calibration automatically (this can include a full rotation of the motor) and check again.\n"
			+ "• Move the axis to the middle of its travel if it isn't already there.\n"
			+ `• Repeatedly move it back and forth, ${METHOD_CONSENT_TEXT[tuneMethod.value]}, keeping every move inside the configured safety margin.\n`
			+ "• Grade the result and, if needed, make one bounded correction pass.\n"
			+ "Review the evaluation afterwards, then save to config.g yourself."
		: "Auto-tune will switch to closed loop, then repeatedly move the driver with step jumps to tune P/D/I (A/V need an axis and will be skipped). Make sure you've calibrated (Step 3) first.";
	askConfirm(msg, runAutoTune);
}

async function runAutoTune(): Promise<void> {
	autoRunning.value = true;
	autoCancel.value = false;
	autoLog.value = [];
	sessionLog = [];
	sessionSeq = 0;
	// The coupling line is logged once per driver; this run just cleared the log it was written to, so
	// re-arm it or the 2nd+ run on a driver produces a report with no kinematics context at all.
	loggedCouplingFor = null;
	resetStageStates();
	ensureViewKeys(["measuredMotorSteps", "targetMotorSteps", "currentError"]);
	const totalCycles = Math.max(1, Math.round(cycles.value || 1));
	const hasAxis = hasAxisSelected.value;
	const runOptions: AutoRunOptions = {
		cycles: totalCycles, hasAxis, calibrationMoveIds: requiredMoveIds.value,
		method: tuneMethod.value, identifyMethod: identifyMethod.value, modelFitBackoff: modelFitBackoff.value,
		seedRule: seedRule.value, seedLambda: seedLambda.value, medianOf: medianOf.value, captureBudget: captureBudget.value,
	};
	tuneSession.value = {
		startedAt: new Date().toISOString(), driver: selectedDriver.value, mode: currentMode.value,
		encoderType: encoderType.value, cycles: totalCycles, log: [], captures: [],
		method: hasAxis ? tuneMethod.value : "sequential", optionsUsed: runOptions,
		stageTimeline: [], reportVersion: REPORT_VERSION,
	};
	let result: AutoRunResult | undefined;
	try {
		result = await runAutoTuneCore(buildTuneEffects(), { ...pid }, runOptions);
		Object.assign(pid, result.pid);
		if (result.ok) {
			const gradeNote = result.evaluation ? ` Final grade: ${result.evaluation.grade} (${result.evaluation.score}/100).` : "";
			autoStatus.value = `Auto-tune complete — P=${pid.p} D=${pid.d} I=${pid.i} A=${pid.a} V=${pid.v}.${gradeNote}`;
			uiStore.makeNotification(LogLevel.success, "Closed Loop Tuning", autoStatus.value + " Review the evaluation, then save to config.g.");
		} else {
			autoStatus.value = result.restored
				? `Auto-tune stopped (${result.reason ?? "see log"}) — PID restored to its values from before this run.`
				: `Auto-tune stopped: ${result.reason ?? "see log"}.`;
		}
	} catch (e) {
		console.warn("[ClosedLoopTuning] auto-tune failed", e);
		autoStatus.value = "Auto-tune stopped (see console).";
	} finally {
		autoRunning.value = false;
		if (tuneSession.value) {
			tuneSession.value.finishedAt = new Date().toISOString();
			tuneSession.value.finalPid = { ...pid };
			tuneSession.value.log = [...sessionLog];
			tuneSession.value.evaluation = result?.evaluation ?? evaluation.value;
			tuneSession.value.ku = result?.ku;
			tuneSession.value.tu = result?.tu;
			tuneSession.value.preflightActions = result?.preflightActions;
			tuneSession.value.restored = result?.restored;
		}
	}
}

function abortAutoTune(): void { autoCancel.value = true; autoStatus.value = "Stopping after this capture…"; }

// --- Test & save ---
async function runTestMove(): Promise<void> {
	moveMode.value = "custom";
	recordKeys.value = ALL_CAPTURE_KEYS;
	ensureViewKeys(["measuredMotorSteps", "targetMotorSteps", "currentError"]);
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

// --- Automated config.g write (opt-in, explicit confirm) ---
const configWriteConfirmOpen = ref(false);
const savingConfig = ref(false);
function openSaveToConfigG(): void { if (selectedDriver.value) { configWriteConfirmOpen.value = true; } }
async function confirmSaveToConfigG(): Promise<void> {
	savingConfig.value = true;
	try { await saveToConfigG(); } finally { savingConfig.value = false; configWriteConfirmOpen.value = false; }
}
async function saveToConfigG(): Promise<void> {
	if (!selectedDriver.value) { return; }
	try {
		const currentText = await (machineStore as any).download({ filename: CONFIG_FILE, type: "text" }, false, false, false) as string;
		const result = upsertTuneBlock(currentText, {
			driver: selectedDriver.value,
			pid,
			mode: currentMode.value === "assisted" ? "assisted" : "closed",
			modeD,
			calibrationMoveIds: requiredMoveIds.value,
		});
		if (!result.changed) {
			uiStore.makeNotification(LogLevel.info, "Closed Loop Tuning", "config.g already has these values — nothing to write.");
			return;
		}
		// Belt-and-suspenders backup of our own, on top of whatever DWC does automatically for config.g uploads.
		const backupName = `${CONFIG_FILE}.clt-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
		await (machineStore as any).upload({ filename: backupName, content: currentText }, false, false, false);
		await (machineStore as any).upload({ filename: CONFIG_FILE, content: result.text }, false, true, true);
		uiStore.makeNotification(LogLevel.success, "Closed Loop Tuning", `config.g ${result.replaced ? "updated" : "written"} (backup: ${backupName.split("/").pop()}). Restart the board to apply it.`);
	} catch (e) {
		console.warn("[ClosedLoopTuning] saveToConfigG failed", e);
		uiStore.makeNotification(LogLevel.error, "Closed Loop Tuning", `Couldn't write config.g: ${e instanceof Error ? e.message : String(e)}`);
	}
}

// --- Shared confirm + send ---
function askConfirm(command: string, action: () => Promise<void>, message = DEFAULT_CONFIRM_MESSAGE): void {
	confirmCommand.value = command;
	confirmMessage.value = message;
	confirmAction = action;
	confirmResolve = null;
	confirmOpen.value = true;
}
/** Promise-based confirm for gating a step inside an async flow (e.g. centering before a move). */
function confirmAsync(message: string, command: string): Promise<boolean> {
	return new Promise((resolve) => {
		confirmCommand.value = command;
		confirmMessage.value = message;
		confirmAction = null;
		confirmResolve = resolve;
		confirmOpen.value = true;
	});
}
async function confirmProceed(): Promise<void> {
	confirmOpen.value = false;
	const action = confirmAction;
	const resolve = confirmResolve;
	confirmAction = null;
	confirmResolve = null;
	if (action) { await action(); }
	if (resolve) { resolve(true); }
}
function confirmCancel(): void {
	confirmOpen.value = false;
	const resolve = confirmResolve;
	confirmAction = null;
	confirmResolve = null;
	if (resolve) { resolve(false); }
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
	background: rgba(var(--v-theme-on-surface), 0.05);
	padding: 6px 8px;
	border-radius: 4px;
}
</style>
