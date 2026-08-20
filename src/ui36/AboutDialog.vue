<!--
  Vuetify 2 stand-in for dwc-plugin-runtime's AboutDialog (that package is Vue 3 only — its render
  functions call resolveComponent, which Vue 2.7 does not export — see ../updateCheck / ./HelpTip).
  Same props/events and the same content as the 3.7 component (identity, updates, diagnostics +
  plugin extra actions, "more plugins by this author", links) so the page template is unchanged; the
  data/report logic itself (buildReport/copyReport/downloadReport, the family registry) is imported
  straight from dwc-plugin-runtime's framework-agnostic subpaths rather than reimplemented here.
-->
<template>
	<v-dialog :value="value" max-width="580" scrollable @input="$emit('input', $event)">
		<v-card>
			<v-card-title class="d-flex align-center">
				<v-icon class="mr-2">mdi-information-outline</v-icon>
				<span>About {{ title }}</span>
				<v-spacer />
				<v-btn icon small @click="$emit('input', false)"><v-icon small>mdi-close</v-icon></v-btn>
			</v-card-title>
			<v-card-text>
				<p v-if="description" class="body-2 mb-2">{{ description }}</p>

				<v-simple-table dense>
					<tbody>
						<tr><td>Version</td><td>{{ installedVersion }}</td></tr>
						<tr><td>DWC</td><td>{{ installedDwcVersion }}</td></tr>
						<tr><td>Firmware</td><td>{{ firmware }}</td></tr>
					</tbody>
				</v-simple-table>

				<template v-if="showUpdates">
					<div class="text-subtitle-2 mt-4 mb-1">Updates</div>
					<v-alert v-if="updateAvailable" type="info" text dense class="mb-2">
						Version {{ latestVersion }} is available.
						<template #append>
							<v-btn v-if="pendingReload" text small @click="reload">Reload</v-btn>
							<v-btn v-else text small :loading="applying" @click="$emit('apply-update')">Update</v-btn>
						</template>
					</v-alert>
					<v-alert v-else type="success" text dense class="mb-2">You're on the latest version.</v-alert>
					<div class="d-flex align-center flex-wrap">
						<v-btn small outlined :loading="checking" class="mr-3 mb-2" @click="$emit('check-update')">
							<v-icon left small>mdi-refresh</v-icon>Check now
						</v-btn>
						<v-switch :input-value="autoCheck" label="Check automatically" color="primary" dense hide-details class="mb-2"
								  @change="$emit('toggle-auto-check', $event)" />
					</div>
				</template>

				<div class="text-subtitle-2 mt-4 mb-1">Diagnostics &amp; support</div>
				<v-btn small outlined block class="mb-2" @click="downloadDiagnostics"><v-icon left small>mdi-bug-outline</v-icon>Download diagnostic report</v-btn>
				<v-btn small outlined block class="mb-2" :color="copyStatus === 'failed' ? 'error' : undefined" @click="copyDiagnostics">
					<v-icon left small>{{ copyIcon }}</v-icon>{{ copyLabel }}
				</v-btn>
				<v-btn v-for="(a, i) in extraActions" :key="i" small outlined block class="mb-2" :color="a.color" :disabled="a.disabled" @click="a.onClick">
					<v-icon v-if="a.icon" left small>{{ a.icon }}</v-icon>{{ a.label }}
				</v-btn>

				<template v-if="showFamily && others.length">
					<div class="text-subtitle-2 mt-4 mb-1">More plugins by jaysuk</div>
					<div class="clt-about-famlist">
						<div v-for="p in others" :key="p.id" class="clt-about-fam">
							<div class="d-flex align-center">
								<span class="text-body-2 font-weight-medium">{{ p.name }}</span>
								<v-chip v-if="isInstalled(p.id)" x-small color="success" class="ml-2">installed</v-chip>
								<v-spacer />
								<a :href="p.repo" target="_blank" rel="noopener" class="clt-about-link">GitHub</a>
							</div>
							<div class="text-caption text--secondary">{{ p.description }}</div>
						</div>
					</div>
				</template>

				<template v-if="linkItems.length">
					<div class="text-subtitle-2 mt-4 mb-1">Links</div>
					<div class="d-flex flex-column">
						<a v-for="l in linkItems" :key="l.href" :href="l.href" target="_blank" rel="noopener" class="clt-about-link mb-1">{{ l.label }}</a>
					</div>
				</template>
			</v-card-text>
		</v-card>
	</v-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { buildReport, copyReport, downloadReport } from "dwc-plugin-runtime/diagnostics";
import { getInstalledPlugin, isPluginInstalled, otherFamilyPlugins, type FamilyPlugin } from "dwc-plugin-runtime/pluginFamily";

interface AboutExtraAction { label: string; icon?: string; color?: string; disabled?: boolean; onClick: () => void }

// `value`/`input` rather than Vue 3's `modelValue`: `v-model` on a Vue 2 component still means
// exactly that, so the page's `v-model="aboutOpen"` binds to this without any change.
const props = withDefaults(defineProps<{
	value: boolean;
	pluginId: string;
	title: string;
	description?: string;
	model?: unknown;
	repo?: string;
	docsUrl?: string;
	docsLabel?: string;
	supportUrl?: string;
	updateAvailable?: boolean;
	latestVersion?: string | null;
	checking?: boolean;
	applying?: boolean;
	pendingReload?: boolean;
	autoCheck?: boolean;
	extraActions?: Array<AboutExtraAction>;
	showFamily?: boolean;
	showUpdates?: boolean;
}>(), {
	description: "", docsLabel: "Documentation", updateAvailable: false, checking: false, applying: false,
	pendingReload: false, autoCheck: true, extraActions: () => [], showFamily: true, showUpdates: true,
});

defineEmits<{
	(e: "input", value: boolean): void;
	(e: "check-update"): void;
	(e: "apply-update"): void;
	(e: "toggle-auto-check", value: boolean): void;
}>();

const installed = computed(() => getInstalledPlugin(props.model, props.pluginId));
const installedVersion = computed(() => installed.value?.version ?? "unknown");
const installedDwcVersion = computed(() => installed.value?.dwcVersion ?? "—");
const firmware = computed(() => {
	const board = (props.model as { boards?: Array<{ firmwareName?: string; firmwareVersion?: string }> } | undefined)?.boards?.[0];
	return board ? `${board.firmwareName ?? "?"} ${board.firmwareVersion ?? ""}`.trim() : "—";
});
const others = computed<ReadonlyArray<FamilyPlugin>>(() => otherFamilyPlugins(props.pluginId));
function isInstalled(id: string): boolean { return isPluginInstalled(props.model, id); }

const linkItems = computed(() => {
	const items: Array<{ href: string; label: string }> = [];
	if (props.docsUrl) { items.push({ href: props.docsUrl, label: props.docsLabel ?? "Documentation" }); }
	if (props.repo) { items.push({ href: props.repo, label: "Source & issues on GitHub" }); }
	if (props.supportUrl) { items.push({ href: props.supportUrl, label: "Support this plugin" }); }
	return items;
});

function reload(): void { window.location.reload(); }

const copyStatus = ref<"idle" | "copied" | "failed">("idle");
let copyTimer: ReturnType<typeof setTimeout> | undefined;
const copyLabel = computed(() => copyStatus.value === "copied" ? "Copied!" : copyStatus.value === "failed" ? "Copy failed — try Download instead" : "Copy diagnostic report");
const copyIcon = computed(() => copyStatus.value === "copied" ? "mdi-check" : copyStatus.value === "failed" ? "mdi-alert" : "mdi-content-copy");

function diagnosticReport() {
	return buildReport({ pluginId: props.pluginId, pluginVersion: installedVersion.value, model: props.model, note: `${props.title} diagnostic report` });
}
function downloadDiagnostics(): void { downloadReport(diagnosticReport()); }
function copyDiagnostics(): void {
	void copyReport(diagnosticReport()).then((ok) => {
		copyStatus.value = ok ? "copied" : "failed";
		if (copyTimer !== undefined) { clearTimeout(copyTimer); }
		copyTimer = setTimeout(() => { copyStatus.value = "idle"; }, 1800);
	});
}
</script>

<style scoped>
.clt-about-link { font-size: .85rem; }
.clt-about-famlist { max-height: 208px; overflow-y: auto; margin-top: 2px; }
.clt-about-fam { padding: 5px 0; border-bottom: 1px solid rgba(127, 127, 127, .18); }
.clt-about-fam:last-child { border-bottom: none; }
</style>
