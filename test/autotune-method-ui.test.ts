import { beforeEach, describe, expect, it } from "vitest";

import { clickByText, mountInDwc, resetDwc } from "dwc-plugin-test-kit";

import ClosedLoopTuning from "../src/ui37/ClosedLoopTuning.vue";

describe("ClosedLoopTuning — auto-tune method UI (Phase 4)", () => {
	beforeEach(() => resetDwc());

	it("renders the tuning-method selector, estimate, and advanced options on the Tune PID step", async () => {
		const wrapper = mountInDwc(ClosedLoopTuning);
		await wrapper.vm.$nextTick();
		await clickByText(wrapper, "4. Tune PID");
		await wrapper.vm.$nextTick();
		const text = wrapper.text();
		expect(text).toContain("Tuning method");
		expect(text).toContain("Standard");
		expect(text).toContain("Thorough");
		expect(text).toContain("Refine");
		expect(text).toContain("Advanced tuning options");
		expect(text).toContain("moves"); // the estimated-move-count caption

		// The identification method (Model fit / Continuous cycling / Relay feedback) lives inside the
		// collapsed "Advanced tuning options" panel — expand it to check its content actually renders.
		await clickByText(wrapper, "Advanced tuning options");
		await wrapper.vm.$nextTick();
		const expandedText = wrapper.text();
		expect(expandedText).toContain("Identification method");
		expect(expandedText).toContain("Model fit");
		expect(expandedText).toContain("Continuous cycling");
		expect(expandedText).toContain("Relay feedback");
	});
});
