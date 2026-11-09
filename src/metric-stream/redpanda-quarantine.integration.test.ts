import { randomUUID } from "node:crypto";
import { ConfigResourceTypes, Kafka, logLevel } from "kafkajs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KafkaMetricStreamQuarantineWriter } from "./redpanda-quarantine.ts";

const brokers = process.env.REDPANDA_BROKERS;
if (!brokers) throw new Error("REDPANDA_BROKERS is required for quarantine integration tests");

describe("quarantine startup configuration (integration)", () => {
  const kafka = new Kafka({
    brokers: brokers.split(","),
    clientId: `quarantine-config-${randomUUID()}`,
    logLevel: logLevel.NOTHING,
  });
  const admin = kafka.admin();
  const topics: string[] = [];

  beforeAll(() => admin.connect());
  afterAll(async () => {
    if (topics.length > 0) await admin.deleteTopics({ topics });
    await admin.disconnect();
  });

  async function createTopic(overrides: Record<string, string> = {}): Promise<string> {
    const sourceTopic = `quarantine-config-${randomUUID()}`;
    const topic = `${sourceTopic}.quarantine.v1`;
    topics.push(topic);
    await admin.createTopics({
      waitForLeaders: true,
      topics: [
        {
          topic,
          numPartitions: 1,
          replicationFactor: 1,
          configEntries: Object.entries({
            "cleanup.policy": "delete",
            "retention.ms": "604800000",
            "retention.bytes": "1073741824",
            "segment.bytes": "134217728",
            "compression.type": "lz4",
            "remote.storage.enable": "false",
            ...overrides,
          }).map(([name, value]) => ({ name, value })),
        },
      ],
    });
    return sourceTopic;
  }

  async function configuration(topic: string) {
    const result = await admin.describeConfigs({
      includeSynonyms: false,
      resources: [
        {
          type: ConfigResourceTypes.TOPIC,
          name: topic,
          configNames: [
            "cleanup.policy",
            "retention.ms",
            "retention.bytes",
            "segment.bytes",
            "compression.type",
            "remote.storage.enable",
          ],
        },
      ],
    });
    const resource = result.resources[0];
    expect(resource?.errorCode).toBe(0);
    return resource?.configEntries;
  }

  it("preserves operator-owned segment and remote overrides on connect and reconnect", async () => {
    const sourceTopic = await createTopic();
    const topic = `${sourceTopic}.quarantine.v1`;
    const before = await configuration(topic);
    expect(before).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          configName: "segment.bytes",
          configValue: "134217728",
          isDefault: false,
        }),
        expect.objectContaining({
          configName: "compression.type",
          configValue: "lz4",
          isDefault: false,
        }),
      ]),
    );
    // Kafka exposes this override; the Redpanda CI fixture ignores this Kafka-only key.
    const remoteStorage = before?.find((entry) => entry.configName === "remote.storage.enable");
    if (remoteStorage) {
      expect(remoteStorage).toMatchObject({ configValue: "false", isDefault: false });
    }
    const producer = kafka.producer();
    const writerAdmin = kafka.admin();
    const writer = new KafkaMetricStreamQuarantineWriter({
      admin: writerAdmin,
      producer,
      sourceTopic,
    });
    try {
      await writer.connect();
      expect(await configuration(topic)).toEqual(before);
      await producer.disconnect();
      await writer.connect();
      expect(await configuration(topic)).toEqual(before);
    } finally {
      await Promise.all([writerAdmin.disconnect(), producer.disconnect()]);
    }
  });

  it.each([
    ["cleanup.policy", "compact,delete"],
    ["retention.ms", "86400000"],
    ["retention.bytes", "2147483648"],
  ])("rejects an existing topic with incorrect %s without changing it", async (name, value) => {
    const sourceTopic = await createTopic({ [name]: value });
    const topic = `${sourceTopic}.quarantine.v1`;
    const before = await configuration(topic);
    const producer = kafka.producer();
    const writerAdmin = kafka.admin();
    const writer = new KafkaMetricStreamQuarantineWriter({
      admin: writerAdmin,
      producer,
      sourceTopic,
    });
    try {
      await expect(writer.connect()).rejects.toThrow(name);
      expect(await configuration(topic)).toEqual(before);
    } finally {
      await Promise.all([writerAdmin.disconnect(), producer.disconnect()]);
    }
  });

  it("creates a missing quarantine topic with the required bounded-retention policy", async () => {
    const sourceTopic = `quarantine-create-${randomUUID()}`;
    const topic = `${sourceTopic}.quarantine.v1`;
    topics.push(topic);
    const producer = kafka.producer();
    const writerAdmin = kafka.admin();
    const writer = new KafkaMetricStreamQuarantineWriter({
      admin: writerAdmin,
      producer,
      sourceTopic,
    });
    try {
      await writer.connect();
      expect(await configuration(topic)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ configName: "cleanup.policy", configValue: "delete" }),
          expect.objectContaining({ configName: "retention.ms", configValue: "604800000" }),
          expect.objectContaining({ configName: "retention.bytes", configValue: "1073741824" }),
        ]),
      );
    } finally {
      await Promise.all([writerAdmin.disconnect(), producer.disconnect()]);
    }
  });
});
