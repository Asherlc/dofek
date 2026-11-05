import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ createProducer: vi.fn(), close: vi.fn(), construct: vi.fn() }));
vi.mock("pulsar-client", () => ({
  default: {
    Client: vi.fn(function DomainPublisherClient(config) {
      sdk.construct(config);
      return { createProducer: sdk.createProducer, close: sdk.close };
    }),
  },
}));
vi.mock("../lib/error-reporting.ts", () => ({ captureException: vi.fn() }));
const env = {
  PULSAR_SERVICE_URL: "pulsar://broker:6650",
  METRIC_STREAM_LIVE_TOPIC: "persistent://public/default/live",
  METRIC_STREAM_HISTORY_TOPIC: "persistent://public/default/history",
};
const row = {
  recordedAt: "2026-06-06T12:00:00Z",
  userId: "00000000-0000-4000-8000-000000000001",
  providerId: "fixture",
  externalId: "fixture-row",
  sourceType: "api",
  channel: "heart_rate",
  scalar: 72,
};

describe("application metric-stream publisher factory", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    sdk.close.mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllEnvs());
  it("publishes through the default live domain entrypoint", async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const send = vi.fn(async () => undefined),
      close = vi.fn(async () => undefined);
    sdk.createProducer.mockResolvedValue({ send, close });
    const { getDefaultMetricStreamEventPublisher } = await import("./publisher-factory.ts");
    const publisher = await getDefaultMetricStreamEventPublisher();
    const events = await publisher.publishRows([row], { operationRevision: "10" });
    expect(events).toHaveLength(1);
    expect(sdk.createProducer).toHaveBeenCalledWith(
      expect.objectContaining({ topic: env.METRIC_STREAM_LIVE_TOPIC }),
    );
    expect(send).toHaveBeenCalledWith({
      data: Buffer.from(JSON.stringify(events[0])),
      partitionKey: events[0]?.id,
    });
  });
  it("publishes a routed replacement through the domain contract", async () => {
    sdk.createProducer.mockResolvedValue({
      send: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    });
    const { createMetricStreamEventPublisherForRoute } = await import("./publisher-factory.ts");
    const publisher = await createMetricStreamEventPublisherForRoute("history", env);
    if (!publisher.replaceRows)
      throw new Error("Configured publisher requires replacement support");
    const result = await publisher.replaceRows({ userId: row.userId }, [row], "10");
    expect(result.rows).toHaveLength(1);
    expect(result.deleted).toMatchObject({
      scope: { userId: row.userId },
      operationRevision: "10",
    });
    expect(sdk.createProducer).toHaveBeenCalledWith(
      expect.objectContaining({ topic: env.METRIC_STREAM_HISTORY_TOPIC }),
    );
  });
  it("closes the configured transport and rejects later application admission", async () => {
    const close = vi.fn(async () => undefined);
    sdk.createProducer.mockResolvedValue({ send: vi.fn(async () => undefined), close });
    const { createMetricStreamEventPublisherForRoute, closeAllMetricStreamEventPublishers } =
      await import("./publisher-factory.ts");
    await createMetricStreamEventPublisherForRoute("live", env);
    await closeAllMetricStreamEventPublishers();
    expect(close).toHaveBeenCalledOnce();
    expect(sdk.close).toHaveBeenCalledOnce();
    await expect(createMetricStreamEventPublisherForRoute("history", env)).rejects.toThrow(
      /shutting down/,
    );
  });
});
