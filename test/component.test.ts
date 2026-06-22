import { beforeEach, describe, expect, it } from "vitest";

import { mountInDwc, resetDwc } from "dwc-plugin-test-kit";

import ClosedLoopTuning from "../src/components/ClosedLoopTuning.vue";

describe("ClosedLoopTuning", () => {
	beforeEach(() => resetDwc());

	it("mounts without throwing", () => {
		const wrapper = mountInDwc(ClosedLoopTuning);
		expect(wrapper.exists()).toBe(true);
	});

	it("shows the no-driver warning when the model has no closed-loop drivers", async () => {
		const wrapper = mountInDwc(ClosedLoopTuning);
		await wrapper.vm.$nextTick();
		expect(wrapper.text()).toContain("No closed-loop drivers found");
	});
});
