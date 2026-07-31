import { describe, expect, it, vi } from "vitest";
import {
  enqueueTelemetryException,
  enqueueTelemetryLog,
  flushTelemetryEvents,
  restoreBufferedTelemetryEvents,
  serializeBufferedTelemetryEvents,
} from "./posthog-client.ts";

describe("zepp posthog client", () => {
  it("buffers telemetry events for later flush", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    enqueueTelemetryException(new Error("watch failed"), { source: "zepp-watch" });
    enqueueTelemetryLog("ERROR", "imu", "sample failed", { attempt: 1 });

    expect(serializeBufferedTelemetryEvents()).toContain('"kind":"exception"');
    expect(serializeBufferedTelemetryEvents()).toContain("sample failed");

    restoreBufferedTelemetryEvents(serializeBufferedTelemetryEvents());
    await flushTelemetryEvents();

    expect(fetchMock).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
