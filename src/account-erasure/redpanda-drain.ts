import kafkaJs, { type Admin } from "kafkajs";
import { z } from "zod";
import {
  assertQuarantineTopicConfiguration,
  type KafkaQuarantineConfigAdmin,
  metricStreamQuarantineTopic,
} from "../metric-stream/redpanda-quarantine.ts";

export const ACCOUNT_ERASURE_CONSUMER_GROUPS = [
  "metric-stream-clickhouse-sink",
  "metric-stream-r2-archive",
] as const;

const offsetSchema = z.string().regex(/^\d+$/);
const highWatermarkSchema = z.object({
  low: offsetSchema,
  offset: offsetSchema,
  partition: z.number().int().nonnegative(),
});
const topicOffsetSchema = highWatermarkSchema.extend({
  high: offsetSchema,
});
export type AccountErasureHighWatermark = z.infer<typeof highWatermarkSchema>;

export const accountErasureRouteHighWatermarkSchema = highWatermarkSchema.extend({
  topic: z.string().min(1).max(249),
  clusterId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{22}$/)
    .optional(),
  topicId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{22}$/)
    .optional(),
});
export type AccountErasureRouteHighWatermark = z.infer<
  typeof accountErasureRouteHighWatermarkSchema
>;

/** Durable ingest_fence checkpoint written by the Kafka phase runner. */
export const accountErasureIngestFenceCheckpointSchema = z.object({
  highWatermarks: z.array(accountErasureRouteHighWatermarkSchema).min(1).max(3),
});

interface KafkaOffsetAdmin {
  fetchOffsets(options: { groupId: string; topics: string[] }): Promise<
    Array<{
      partitions: Array<{ offset: string; partition: number }>;
      topic: string;
    }>
  >;
  fetchTopicOffsets(
    topic: string,
  ): Promise<Array<{ high: string; low: string; offset: string; partition: number }>>;
}

export interface RedpandaAdmin extends KafkaOffsetAdmin, KafkaQuarantineConfigAdmin {}

export async function captureAccountErasureHighWatermarks(
  admin: Pick<KafkaOffsetAdmin, "fetchTopicOffsets">,
  topic: string,
): Promise<AccountErasureHighWatermark[]> {
  return z
    .array(topicOffsetSchema)
    .parse(await admin.fetchTopicOffsets(topic))
    .map((entry) => ({
      low: entry.low,
      offset: entry.high,
      partition: entry.partition,
    }))
    .sort((left, right) => left.partition - right.partition);
}

export async function captureAccountErasureQuarantineHighWatermarks(
  admin: RedpandaAdmin,
  sourceTopic: string,
): Promise<AccountErasureHighWatermark[]> {
  const quarantineTopic = metricStreamQuarantineTopic(sourceTopic);
  await assertQuarantineTopicConfiguration(admin, quarantineTopic);
  return captureAccountErasureHighWatermarks(admin, quarantineTopic);
}

export async function assertAccountErasureConsumersDrained(
  admin: Pick<KafkaOffsetAdmin, "fetchOffsets">,
  topic: string,
  highWatermarks: readonly AccountErasureHighWatermark[],
  consumerGroups: readonly string[] = ACCOUNT_ERASURE_CONSUMER_GROUPS,
): Promise<void> {
  const targets = new Map(
    z
      .array(highWatermarkSchema)
      .parse(highWatermarks)
      .map((entry) => [entry.partition, { high: BigInt(entry.offset), low: BigInt(entry.low) }]),
  );
  for (const groupId of consumerGroups) {
    const topics = await admin.fetchOffsets({ groupId, topics: [topic] });
    const committed = new Map(
      (topics.find((entry) => entry.topic === topic)?.partitions ?? []).map((entry) => [
        entry.partition,
        entry.offset === "-1" ? -1n : BigInt(offsetSchema.parse(entry.offset)),
      ]),
    );
    const laggingPartitions = [...targets.entries()]
      .filter(([partition, target]) => {
        const offset = committed.get(partition) ?? -1n;
        if (offset === -1n && target.high === target.low) return false;
        return offset < target.high;
      })
      .map(([partition]) => partition);
    if (laggingPartitions.length > 0) {
      throw new Error(
        `Account erasure is waiting for ${groupId} partition(s): ${laggingPartitions.join(", ")}`,
      );
    }
  }
}

export async function assertAccountErasureReplayExpired(
  admin: Pick<KafkaOffsetAdmin, "fetchTopicOffsets">,
  topic: string,
  highWatermarks: readonly AccountErasureHighWatermark[],
): Promise<void> {
  const captured = new Map(
    z
      .array(highWatermarkSchema)
      .parse(highWatermarks)
      .map((entry) => [entry.partition, BigInt(entry.offset)]),
  );
  const current = new Map(
    z
      .array(topicOffsetSchema)
      .parse(await admin.fetchTopicOffsets(topic))
      .map((entry) => [entry.partition, BigInt(entry.low)]),
  );
  const retainedPartitions = [...captured]
    .filter(([partition, capturedNextOffset]) => {
      const currentLow = current.get(partition);
      return currentLow === undefined || currentLow < capturedNextOffset;
    })
    .map(([partition]) => partition);
  if (retainedPartitions.length > 0) {
    throw new Error(
      `Account erasure replay data remains in partition(s): ${retainedPartitions.join(", ")}`,
    );
  }
}

export async function assertAccountErasureQuarantineExpired(
  admin: RedpandaAdmin,
  sourceTopic: string,
  highWatermarks: readonly AccountErasureHighWatermark[],
): Promise<void> {
  const quarantineTopic = metricStreamQuarantineTopic(sourceTopic);
  await assertQuarantineTopicConfiguration(admin, quarantineTopic);
  try {
    await assertAccountErasureReplayExpired(admin, quarantineTopic, highWatermarks);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replace("replay data", "quarantine data"), {
      cause: error,
    });
  }
}

export interface AccountErasureRedpandaAdmin {
  admin: RedpandaAdmin & Pick<Admin, "describeCluster" | "fetchTopicMetadata">;
  close(): Promise<void>;
  connect(): Promise<void>;
  routes: Array<{ topic: string; consumerGroups: readonly string[] }>;
}

export function createAccountErasureRedpandaAdminFromEnv(
  env: Record<string, string | undefined> = process.env,
): AccountErasureRedpandaAdmin {
  const routes = (["LEGACY", "LIVE", "HISTORY"] as const).map((route) => {
    const key = `METRIC_STREAM_${route}_TOPIC`;
    const topic = env[key]?.trim();
    if (!topic) throw new Error(`${key} is required for account erasure`);
    const prefix = route === "LEGACY" ? "metric-stream" : `metric-stream-${route.toLowerCase()}`;
    return { topic, consumerGroups: [`${prefix}-clickhouse-sink`, `${prefix}-r2-archive`] };
  });
  const brokers = env.REDPANDA_BROKERS?.split(",")
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);
  if (!brokers || brokers.length === 0) {
    throw new Error("REDPANDA_BROKERS is required for account erasure");
  }
  const admin = new kafkaJs.Kafka({
    brokers,
    clientId: "dofek-account-erasure",
  }).admin();
  return {
    admin,
    close: () => admin.disconnect(),
    connect: () => admin.connect(),
    routes,
  };
}
