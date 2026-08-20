<!--
  Vuetify 2 stand-in for dwc-plugin-runtime's HelpTip.

  That package is pinned to Vue 3 (its components call `resolveComponent`, which Vue 2.7 does not
  export), so the DWC 3.6 build needs its own. Same contract as the 3.7 one — a small help icon with
  a hover tooltip and an optional link — so the page template can use it identically apart from the
  slot name the parent text-field uses to place it (`#append` here, `#append-inner` on Vuetify 4).
-->
<template>
	<v-tooltip top max-width="360" open-delay="150">
		<template #activator="{ on, attrs }">
			<a v-if="href" :href="href" target="_blank" rel="noopener" v-bind="attrs" v-on="on" class="clt-helptip-link" @click.stop>
				<v-icon :size="size" class="clt-helptip" tabindex="-1" :aria-label="text">mdi-help-circle-outline</v-icon>
			</a>
			<v-icon v-else :size="size" class="clt-helptip" tabindex="0" :aria-label="text" v-bind="attrs" v-on="on">mdi-help-circle-outline</v-icon>
		</template>
		<span>{{ tooltipText }}</span>
	</v-tooltip>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(defineProps<{ text: string; href?: string; size?: string | number }>(), { size: "x-small" });
const tooltipText = computed(() => (props.href ? `${props.text} (click for docs)` : props.text));
</script>

<style scoped>
.clt-helptip {
	cursor: help;
	opacity: 0.7;
}
.clt-helptip:hover {
	opacity: 1;
}
.clt-helptip-link {
	line-height: 0;
}
</style>
