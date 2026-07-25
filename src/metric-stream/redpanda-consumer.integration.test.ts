import { randomUUID } from "node:crypto";
import { type Admin, ConfigResourceTypes, Kafka, logLevel, type Producer } from "kafkajs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMetricStreamEvent } from "./events.ts";
import {
  type MetricStreamConsumerLike,
  runMetricStreamEventConsumer,
} from "./redpanda-consumer.ts";
import {
  KafkaMetricStreamQuarantineWriter,
  type MetricStreamQuarantineWriter,
} from "./redpanda-quarantine.ts";

const operationRevision = "1000000000000000";
const sourceTopic = `metric-stream-quarantine-integration-${randomUUID()}`;
const quarantineTopic = `${sourceTopic}.quarantine.v1`;
const groupId = `metric-stream-quarantine-group-${randomUUID()}`;
const createdTopics = [sourceTopic, quarantineTopic];

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolver: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolver = resolve;
  });
  if (!resolver) {
    throw new Error("deferred promise resolver was not initialized");
  }
  return {
    promise,
    resolve: resolver,
  };
}

function readBrokers(): string[] {
  const value = process.env.REDPANDA_BROKERS;
  if (!value) {
    throw new Error("REDPANDA_BROKERS is required for metric-stream integration tests");
  }
  return value
    .split(",")
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);
}

function adaptConsumer(consumer: ReturnType<Kafka["consumer"]>): MetricStreamConsumerLike {
  return {
    connect: () => consumer.connect(),
    run: (options) => consumer.run(options),
    subscribe: (options) => consumer.subscribe(options),
  };
}

async function waitForCommittedOffset(
  admin: Admin,
  expectedOffset: string,
  timeoutMilliseconds = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const offsets = await admin.fetchOffsets({ groupId, topics: [sourceTopic] });
    const offset = offsets
      .find((topic) => topic.topic === sourceTopic)
      ?.partitions.find((partition) => partition.partition === 0)?.offset;
    if (offset === expectedOffset) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`consumer group did not commit source offset ${expectedOffset}`);
}

async function readQuarantineRecord(kafka: Kafka): Promise<{
  headers: Record<string, string>;
  key: string;
  value: Buffer;
}> {
  const consumer = kafka.consumer({
    groupId: `metric-stream-quarantine-reader-${randomUUID()}`,
  });
  const record = createDeferred<{
    headers: Record<string, string>;
    key: string;
    value: Buffer;
  }>();
  await consumer.connect();
  await consumer.subscribe({ topic: quarantineTopic, fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ message }) => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(message.headers ?? {})) {
        if (!value || (Array.isArray(value) && value.length === 0)) {
          throw new Error(`quarantine header ${name} has no value`);
        }
        headers[name] = Array.isArray(value)
          ? value.map((entry) => entry.toString("utf8")).join(",")
          : value.toString("utf8");
      }
      if (!message.key || !message.value) {
        throw new Error("quarantine record is missing its key or payload");
      }
      record.resolve({
        headers,
        key: message.key.toString("utf8"),
        value: message.value,
      });
    },
  });
  const result = await Promise.race([
    record.promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("quarantine record was not readable")), 10_000);
    }),
  ]);
  await consumer.stop();
  await consumer.disconnect();
  return result;
}

describe("metric-stream durable quarantine", () => {
  let admin: Admin;
  let kafka: Kafka;
  let producer: Producer;

  beforeAll(async () => {
    kafka = new Kafka({
      brokers: readBrokers(),
      clientId: `dofek-quarantine-integration-${randomUUID()}`,
      logLevel: logLevel.NOTHING,
    });
    admin = kafka.admin();
    producer = kafka.producer();
    await admin.connect();
    await admin.createTopics({
      topics: [{ numPartitions: 1, replicationFactor: 1, topic: sourceTopic }],
      waitForLeaders: true,
    });
    await admin.setOffsets({
      groupId,
      partitions: [{ offset: "0", partition: 0 }],
      topic: sourceTopic,
    });
    await producer.connect();
  });

  afterAll(async () => {
    await producer.disconnect();
    await admin.deleteTopics({ topics: createdTopics });
    await admin.disconnect();
  });

  it("replays a failed quarantine, then durably records full context before commit", async () => {
    const firstAttempt = createDeferred<void>();
    const firstConsumer = kafka.consumer({ groupId });
    const firstHandler = vi.fn(async () => undefined);
    const failingQuarantine: MetricStreamQuarantineWriter = {
      connect: async () => undefined,
      write: async () => {
        firstAttempt.resolve(undefined);
        throw new Error("quarantine unavailable");
      },
    };

    await runMetricStreamEventConsumer({
      consumer: adaptConsumer(firstConsumer),
      handleEvents: firstHandler,
      quarantine: failingQuarantine,
      topic: sourceTopic,
    });

    const validEvent = createMetricStreamEvent(
      {
        channel: "heart_rate",
        deviceId: "Apple Watch",
        externalId: "hk:heart-rate-1",
        id: "10000000-0000-4000-8000-000000000001",
        providerId: "apple_health",
        recordedAt: "2026-06-06T19:00:00.000Z",
        scalar: 72,
        sourceType: "api",
        userId: "00000000-0000-0000-0000-000000000001",
      },
      operationRevision,
    );
    await producer.send({
      acks: -1,
      messages: [
        { key: "malformed", partition: 0, value: "{not-json" },
        { key: validEvent.id, partition: 0, value: JSON.stringify(validEvent) },
      ],
      topic: sourceTopic,
    });

    await firstAttempt.promise;
    await firstConsumer.stop();
    await firstConsumer.disconnect();

    expect(firstHandler).not.toHaveBeenCalled();
    const uncommittedOffsets = await admin.fetchOffsets({ groupId, topics: [sourceTopic] });
    expect(uncommittedOffsets[0]?.partitions[0]?.offset).toBe("0");

    const quarantineAdmin = kafka.admin();
    const quarantineProducer = kafka.producer();
    const durableWriter = new KafkaMetricStreamQuarantineWriter({
      admin: quarantineAdmin,
      producer: quarantineProducer,
      sourceTopic,
    });
    let quarantineCompleted = false;
    const trackingWriter: MetricStreamQuarantineWriter = {
      connect: () => durableWriter.connect(),
      write: async (input) => {
        await durableWriter.write(input);
        quarantineCompleted = true;
      },
    };
    const replayed = createDeferred<void>();
    const replayConsumer = kafka.consumer({ groupId });

    await runMetricStreamEventConsumer({
      consumer: adaptConsumer(replayConsumer),
      handleEvents: async (events) => {
        expect(quarantineCompleted).toBe(true);
        expect(events).toEqual([validEvent]);
        replayed.resolve(undefined);
      },
      quarantine: trackingWriter,
      topic: sourceTopic,
    });
    await replayed.promise;
    await waitForCommittedOffset(admin, "2");
    await replayConsumer.stop();
    await replayConsumer.disconnect();

    const quarantined = await readQuarantineRecord(kafka);
    expect(quarantined.key).toBe(`${sourceTopic}:0:0`);
    expect(quarantined.value).toEqual(Buffer.from("{not-json"));
    expect(quarantined.headers).toMatchObject({
      "dofek-error-message": expect.stringContaining("JSON"),
      "dofek-error-name": "SyntaxError",
      "dofek-quarantine-version": "1",
      "dofek-source-offset": "0",
      "dofek-source-partition": "0",
      "dofek-source-topic": sourceTopic,
    });

    const topicConfiguration = await admin.describeConfigs({
      includeSynonyms: false,
      resources: [
        {
          configNames: ["cleanup.policy", "retention.ms", "retention.bytes"],
          name: quarantineTopic,
          type: ConfigResourceTypes.TOPIC,
        },
      ],
    });
    const config = new Map(
      topicConfiguration.resources[0]?.configEntries.map((entry) => [
        entry.configName,
        entry.configValue,
      ]),
    );
    expect(config).toEqual(
      new Map([
        ["cleanup.policy", "delete"],
        ["retention.bytes", "1073741824"],
        ["retention.ms", "604800000"],
      ]),
    );
    await quarantineProducer.disconnect();
  });
});
