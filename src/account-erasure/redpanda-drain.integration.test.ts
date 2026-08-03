import { randomUUID } from "node:crypto";
import { Kafka, logLevel } from "kafkajs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KafkaMetricStreamQuarantineWriter } from "../metric-stream/redpanda-quarantine.ts";
import {
  assertAccountErasureQuarantineExpired,
  captureAccountErasureQuarantineHighWatermarks,
} from "./redpanda-drain.ts";

const sourceTopic = `account-erasure-drain-${randomUUID()}`;
const quarantineTopic = `${sourceTopic}.quarantine.v1`;

function readBrokers(): string[] {
  const value = process.env.REDPANDA_BROKERS;
  if (!value) {
    throw new Error("REDPANDA_BROKERS is required for account-erasure integration tests");
  }
  return value
    .split(",")
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);
}

describe("account erasure Redpanda quarantine proof (integration)", () => {
  const kafka = new Kafka({
    brokers: readBrokers(),
    clientId: `account-erasure-drain-${randomUUID()}`,
    logLevel: logLevel.NOTHING,
  });
  const admin = kafka.admin();
  const quarantineAdmin = kafka.admin();
  const producer = kafka.producer();

  beforeAll(async () => {
    const writer = new KafkaMetricStreamQuarantineWriter({
      admin: quarantineAdmin,
      producer,
      sourceTopic,
    });
    await writer.connect();
    await writer.write({
      error: new Error("invalid user payload"),
      offset: "14",
      partition: 0,
      payload: Buffer.from('{"email":"person@example.test"}'),
      topic: sourceTopic,
    });
    await admin.connect();
  }, 30_000);

  afterAll(async () => {
    await admin.deleteTopics({ topics: [quarantineTopic] });
    await Promise.all([admin.disconnect(), producer.disconnect()]);
  });

  it("blocks until the persisted quarantine boundary is physically absent", async () => {
    const boundary = await captureAccountErasureQuarantineHighWatermarks(admin, sourceTopic);
    expect(boundary).toEqual([{ low: "0", offset: "1", partition: 0 }]);

    await expect(
      assertAccountErasureQuarantineExpired(admin, sourceTopic, boundary),
    ).rejects.toThrow("quarantine data remains in partition(s): 0");

    await admin.deleteTopicRecords({
      partitions: [{ offset: "1", partition: 0 }],
      topic: quarantineTopic,
    });
    await expect
      .poll(
        async () => {
          const offsets = await admin.fetchTopicOffsets(quarantineTopic);
          return offsets[0]?.low;
        },
        { interval: 50, timeout: 10_000 },
      )
      .toBe("1");

    await expect(
      assertAccountErasureQuarantineExpired(admin, sourceTopic, boundary),
    ).resolves.toBeUndefined();
  });
});
