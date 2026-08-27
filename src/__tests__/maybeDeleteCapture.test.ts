import { describe, expect, it, vi } from "vitest";

import { maybeDeleteCapture } from "../core/useClosedLoopTuning";
import type { HostAdapter } from "../core/host";

describe("maybeDeleteCapture", () => {
	it("does nothing when disabled — deleteFile is never called", async () => {
		const deleteFile = vi.fn(async () => {});
		await maybeDeleteCapture({ deleteFile }, "0:/sys/closed-loop/x.csv", false);
		expect(deleteFile).not.toHaveBeenCalled();
	});

	it("calls deleteFile with exactly the path given, when enabled", async () => {
		const deleteFile = vi.fn(async () => {});
		await maybeDeleteCapture({ deleteFile }, "0:/sys/closed-loop/x.csv", true);
		expect(deleteFile).toHaveBeenCalledExactlyOnceWith("0:/sys/closed-loop/x.csv");
	});

	it("a rejected deleteFile does not throw — the caller (a tuning run) must never abort over this", async () => {
		const deleteFile = vi.fn(async () => { throw new Error("permission denied"); });
		await expect(maybeDeleteCapture({ deleteFile }, "0:/sys/closed-loop/x.csv", true)).resolves.toBeUndefined();
	});

	it("logs a warning (not silence) when the delete fails, naming the path", async () => {
		const deleteFile = vi.fn(async () => { throw new Error("permission denied"); });
		const warn = vi.fn();
		await maybeDeleteCapture({ deleteFile }, "0:/sys/closed-loop/x.csv", true, warn);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0].join(" ")).toContain("0:/sys/closed-loop/x.csv");
	});

	it("never calls a mock host's OTHER methods — only deleteFile, satisfying the HostAdapter contract narrowly", async () => {
		const host: Pick<HostAdapter, "deleteFile"> = { deleteFile: vi.fn(async () => {}) };
		await maybeDeleteCapture(host, "path.csv", true);
		expect(host.deleteFile).toHaveBeenCalledOnce();
	});
});
