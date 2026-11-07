import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const kafkaProducerConnect = vi.hoisted(() => vi.fn(async () => undefined));
const kafkaProducerDisconnect = vi.hoisted(() => vi.fn(async () => undefined));
const kafkaProducerSend = vi.hoisted(() => vi.fn(async () => undefined));
const kafkaProducerFactory = vi.hoisted(() =>
  vi.fn(() => ({
    connect: kafkaProducerConnect,
    disconnect: kafkaProducerDisconnect,
    send: kafkaProducerSend,
  })),
);
const kafkaConstructor = vi.hoisted(() =>
  vi.fn(function Kafka() {
    return { producer: kafkaProducerFactory };
  }),
);

vi.mock("kafkajs", () => ({
  Kafka: kafkaConstructor,
}));
vi.mock("../lib/error-reporting.ts", () => ({ captureException: vi.fn() }));

const env = {
  KAFKA_BROKERS: "kafka:9092",
  METRIC_STREAM_LIVE_TOPIC: "metric-stream-live-v2",
  METRIC_STREAM_HISTORY_TOPIC: "metric-stream-history-v2",
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
    kafkaProducerConnect.mockResolvedValue(undefined);
    kafkaProducerDisconnect.mockResolvedValue(undefined);
    kafkaProducerSend.mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("publishes through the default live domain entrypoint", async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const { getDefaultMetricStreamEventPublisher } = await import("./publisher-factory.ts");
    const publisher = await getDefaultMetricStreamEventPublisher();
    const events = await publisher.publishRows([row], { operationRevision: "10" });
    expect(events).toHaveLength(1);
    expect(kafkaProducerSend).toHaveBeenCalledWith(
      expect.objectContaining({ topic: env.METRIC_STREAM_LIVE_TOPIC }),
    );
  });

  it("publishes a routed replacement through the domain contract", async () => {
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
    expect(kafkaProducerSend).toHaveBeenCalledWith(
      expect.objectContaining({ topic: env.METRIC_STREAM_HISTORY_TOPIC }),
    );
  });

  it("closes cached Kafka producers through the domain entrypoint", async () => {
    const { createMetricStreamEventPublisherForRoute, closeAllMetricStreamEventPublishers } =
      await import("./publisher-factory.ts");
    await createMetricStreamEventPublisherForRoute("live", env);
    await closeAllMetricStreamEventPublishers();
    expect(kafkaProducerDisconnect).toHaveBeenCalledOnce();
  });
});
