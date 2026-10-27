import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POSTHOG_API_KEY, POSTHOG_CAPTURE_URL, POSTHOG_LOGS_URL } from "./posthog-config.ts";

describe("zepp posthog client", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function loadClient() {
    return import("./posthog-client.ts");
  }

  it("buffers telemetry events for later flush when network calls fail", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const client = await loadClient();
    client.enqueueTelemetryException(new Error("watch failed"), { source: "zepp-watch" });
    client.enqueueTelemetryLog("ERROR", "imu", "sample failed", { attempt: 1 });

    expect(client.serializeBufferedTelemetryEvents()).toContain('"kind":"exception"');
    expect(client.serializeBufferedTelemetryEvents()).toContain("sample failed");

    client.restoreBufferedTelemetryEvents(client.serializeBufferedTelemetryEvents());
    await client.flushTelemetryEvents();

    expect(fetchMock).toHaveBeenCalled();
  });

  it("captures exceptions with PostHog event payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);

    const client = await loadClient();
    const error = new Error("sync failed");
    error.stack = "Error: sync failed\n    at watch.ts:1:1";

    await client.captureException(error, {
      distinctId: "user-42",
      source: "zepp-watch",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: POSTHOG_CAPTURE_URL,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[0]?.body));
    expect(body).toEqual({
      api_key: POSTHOG_API_KEY,
      event: "$exception",
      distinct_id: "user-42",
      properties: expect.objectContaining({
        source: "zepp-watch",
        $exception_type: "Error",
        $exception_message: "sync failed",
        $exception_stack_trace_raw: error.stack,
        platform: "zepp",
      }),
    });
  });

  it("normalizes non-error values and falls back to queued exceptions", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    const client = await loadClient();
    await client.captureException("token expired", { distinctId: "  " });

    expect(client.serializeBufferedTelemetryEvents()).toContain("token expired");
    const restored = JSON.parse(client.serializeBufferedTelemetryEvents());
    expect(restored[0]).toEqual(
      expect.objectContaining({
        kind: "exception",
        payload: expect.objectContaining({
          error: { message: "token expired", name: "Error" },
          context: { distinctId: "  " },
        }),
      }),
    );
  });

  it("emits structured OTEL logs with primitive attributes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const client = await loadClient();
    await client.emitLog("warn", "imu", "retrying sample", {
      attempt: 2,
      ready: true,
      ignored: { nested: true },
      label: "zepp",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: POSTHOG_LOGS_URL,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${POSTHOG_API_KEY}`,
        },
      }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[0]?.body));
    expect(body.resourceLogs[0].resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "dofek-zepp" } },
    ]);
    expect(body.resourceLogs[0].scopeLogs[0].logRecords[0]).toEqual(
      expect.objectContaining({
        timeUnixNano: "1700000000000000000",
        severityText: "WARN",
        body: { stringValue: "[imu] retrying sample" },
        attributes: [
          { key: "category", value: { stringValue: "imu" } },
          { key: "platform", value: { stringValue: "zepp" } },
          { key: "attempt", value: { stringValue: "2" } },
          { key: "ready", value: { stringValue: "true" } },
          { key: "label", value: { stringValue: "zepp" } },
        ],
      }),
    );
  });

  it("queues failed log emissions and flushes buffered exceptions and logs", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("capture failed"))
      .mockRejectedValueOnce(new Error("log failed"))
      .mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);

    const client = await loadClient();
    await client.captureException(new Error("first failure"));
    await client.emitLog("info", "sync", "queued log", { step: "flush" });

    client.restoreBufferedTelemetryEvents(client.serializeBufferedTelemetryEvents());
    await client.flushTelemetryEvents();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(client.serializeBufferedTelemetryEvents()).toBe("[]");
  });

  it("routes logger helpers through emitLog and restores buffered telemetry safely", async () => {
    const fetchMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);

    const client = await loadClient();
    client.clearBufferedTelemetryEvents();
    client.logger.info("watch", "started");
    client.logger.warn("watch", "retrying");
    client.logger.error("watch", "failed", { code: 500 });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchMock.mock.calls[2]?.[0]?.body ?? "{}").resourceLogs).toBeDefined();

    client.restoreBufferedTelemetryEvents("not-json");
    client.restoreBufferedTelemetryEvents("null");
    client.restoreBufferedTelemetryEvents(
      JSON.stringify([{ kind: "invalid" }, { kind: "log", payload: {} }]),
    );
    client.enqueueTelemetryLog("INFO", "buffer", "queued");

    for (let index = 0; index < 25; index += 1) {
      client.enqueueTelemetryLog("INFO", "buffer", `event-${index}`);
    }

    const restoredEvents = JSON.parse(client.serializeBufferedTelemetryEvents());
    expect(restoredEvents).toHaveLength(20);
    expect(restoredEvents.at(-1)?.payload?.message).toBe("event-24");
  });

  it("uses default distinct ids and normalized error payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);

    const client = await loadClient();
    const error = new Error("no stack");
    delete error.stack;

    await client.captureException(error);
    await client.captureException({ message: "already normalized", name: "ProviderError" });

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[0]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[0]?.body));

    expect(firstBody.distinct_id).toBe("zepp-unknown");
    expect(firstBody.properties.$exception_stack_trace_raw).toBeUndefined();
    expect(secondBody.properties).toEqual(
      expect.objectContaining({
        $exception_type: "ProviderError",
        $exception_message: "already normalized",
        platform: "zepp",
      }),
    );
  });

  it("flushes buffered events with malformed payloads and ignores invalid restore input", async () => {
    const fetchMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);

    const client = await loadClient();
    client.clearBufferedTelemetryEvents();
    client.restoreBufferedTelemetryEvents("");
    client.restoreBufferedTelemetryEvents("{not-json");
    client.restoreBufferedTelemetryEvents(JSON.stringify("not-an-array"));
    client.restoreBufferedTelemetryEvents(
      JSON.stringify([
        { kind: "invalid" },
        {
          kind: "log",
          payload: { level: 123, category: null, message: undefined },
        },
        {
          kind: "exception",
          payload: {
            error: { message: "boom", name: "Error" },
            context: "not-a-record",
          },
        },
      ]),
    );

    await client.flushTelemetryEvents();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const logBody = JSON.parse(String(fetchMock.mock.calls[0]?.[0]?.body));
    expect(logBody.resourceLogs[0].scopeLogs[0].logRecords[0]).toEqual(
      expect.objectContaining({
        severityText: "INFO",
        body: { stringValue: "[zepp] " },
      }),
    );
    const exceptionBody = JSON.parse(String(fetchMock.mock.calls[1]?.[0]?.body));
    expect(exceptionBody).toEqual(
      expect.objectContaining({
        event: "$exception",
        distinct_id: "zepp-unknown",
        properties: expect.objectContaining({
          $exception_message: "boom",
          platform: "zepp",
        }),
      }),
    );
    expect(client.serializeBufferedTelemetryEvents()).toBe("[]");
  });

  it("queues exceptions when capture fails and trims the buffer to the max size", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    const client = await loadClient();
    client.clearBufferedTelemetryEvents();

    for (let index = 0; index < 25; index += 1) {
      client.enqueueTelemetryException(`failure-${index}`);
    }

    const buffered = JSON.parse(client.serializeBufferedTelemetryEvents());
    expect(buffered).toHaveLength(20);
    expect(buffered[0].payload.error.message).toBe("failure-5");
    expect(buffered.at(-1).payload.error.message).toBe("failure-24");
  });
});
