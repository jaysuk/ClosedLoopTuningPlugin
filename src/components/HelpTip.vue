<!--
	Small inline help affordance: a low-emphasis "?" icon that shows an explanatory tooltip on hover.
	When `href` is given the icon is also a link (opens the relevant Duet documentation in a new tab),
	and the tooltip says so.
-->
<template>
	<v-tooltip :text="tooltipText" location="top" max-width="360" open-delay="150">
		<template #activator="{ props: tip }">
			<a v-if="href" :href="href" target="_blank" rel="noopener" class="cl-help" @click.stop>
				<v-icon v-bind="tip" :size="size" class="cl-help-icon">mdi-help-circle-outline</v-icon>
			</a>
			<v-icon v-else v-bind="tip" :size="size" class="cl-help-icon" tabindex="0">mdi-help-circle-outline</v-icon>
		</template>
	</v-tooltip>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(defineProps<{
	/** Explanation shown in the tooltip box. */
	text: string;
	/** Optional Duet documentation URL; makes the icon a link and notes it in the tooltip. */
	href?: string;
	size?: string | number;
}>(), { size: "x-small" });

const tooltipText = computed(() => (props.href ? `${props.text} (click for Duet docs)` : props.text));
</script>

<style scoped>
.cl-help { text-decoration: none; }
.cl-help-icon {
	opacity: 0.55;
	cursor: help;
	vertical-align: middle;
}
.cl-help-icon:hover,
.cl-help-icon:focus-visible {
	opacity: 1;
}
</style>
