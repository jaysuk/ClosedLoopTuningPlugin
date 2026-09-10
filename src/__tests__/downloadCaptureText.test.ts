import { describe, expect, it, vi } from "vitest";

import { downloadCaptureText } from "../core/useClosedLoopTuning";

/**
 * docs/PLAN-v2.7-feedback.md §4 — a completed M569.5 capture must not be lost to a transient
 * rr_download 503. The retry loop retries the DOWNLOAD only, never anything upstream (the caller has
 * already confirmed the capture ran via the closed-loop run counter).
 */
const noSleep = async () => {};
const quiet = () => {};

describe("downloadCaptureText", () => {
	it("returns the text on the first try when the download succeeds", async () => {
		const download = vi.fn(async () => "csv-body");
		const text = await downloadCaptureText({ download }, "0:/sys/closed-loop/x.csv", 3, quiet, noSleep);
		expect(text).toBe("csv-body");
		expect(download).toHaveBeenCalledTimes(1);
	});

	it("retries the download only, and succeeds once a later attempt works — no re-run of anything", async () => {
		let n = 0;
		const download = vi.fn(async () => { n++; if (n < 3) { throw new Error("503 Service Unavailable"); } return "late-body"; });
		const log = vi.fn();
		const text = await downloadCaptureText({ download }, "0:/sys/closed-loop/x.csv", 3, log, noSleep);
		expect(text).toBe("late-body");
		expect(download).toHaveBeenCalledTimes(3);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("retrying the download"));
	});

	it("returns null (never throws) when every attempt fails", async () => {
		const download = vi.fn(async () => { throw new Error("503"); });
		const warn = vi.fn();
		const text = await downloadCaptureText({ download }, "0:/sys/closed-loop/x.csv", 2, quiet, noSleep, warn);
		expect(text).toBeNull();
		expect(download).toHaveBeenCalledTimes(3); // initial + 2 retries
		expect(warn).toHaveBeenCalled();
	});

	it("waits an escalating backoff between attempts", async () => {
		const download = vi.fn(async () => { throw new Error("503"); });
		const sleeps: Array<number> = [];
		await downloadCaptureText({ download }, "x", 2, quiet, async (ms) => { sleeps.push(ms); }, () => {});
		expect(sleeps).toEqual([400, 800]); // 400*(attempt+1) for attempt 0 and 1; none after the last
	});
});
