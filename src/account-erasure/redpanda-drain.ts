import { ConfigResourceTypes, Kafka } from "kafkajs";
import { z } from "zod";
import {
  METRIC_STREAM_QUARANTINE_TOPIC_CONFIG,
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
const describedTopicConfigSchema = z.object({
  resources: z.array(
    z.object({
      configEntries: z.array(
        z.object({
          configName: z.string(),
          configValue: z.string(),
        }),
      ),
      errorCode: z.number().int(),
      errorMessage: z.string().nullable(),
      resourceName: z.string(),
      resourceType: z.number().int(),
    }),
  ),
});

export type AccountErasureHighWatermark = z.infer<typeof highWatermarkSchema>;

interface RedpandaOffsetAdmin {
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

export interface RedpandaAdmin extends RedpandaOffsetAdmin {
  describeConfigs(options: {
    includeSynonyms: boolean;
    resources: Array<{
      configNames: string[];
      name: string;
      type: ConfigResourceTypes;
    }>;
  }): Promise<unknown>;
}

async function assertQuarantineTopicConfiguration(
  admin: RedpandaAdmin,
  sourceTopic: string,
): Promise<string> {
  const quarantineTopic = metricStreamQuarantineTopic(sourceTopic);
  const expectedConfig = new Map(
    METRIC_STREAM_QUARANTINE_TOPIC_CONFIG.map((entry) => [entry.name, entry.value]),
  );
  const response = describedTopicConfigSchema.parse(
    await admin.describeConfigs({
      includeSynonyms: false,
      resources: [
        {
          configNames: [...expectedConfig.keys()],
          name: quarantineTopic,
          type: ConfigResourceTypes.TOPIC,
        },
      ],
    }),
  );
  const resource = response.resources.find(
    (entry) =>
      entry.resourceName === quarantineTopic && entry.resourceType === ConfigResourceTypes.TOPIC,
  );
  if (!resource) {
    throw new Error(`Account erasure could not verify quarantine topic ${quarantineTopic}`);
  }
  if (resource.errorCode !== 0) {
    throw new Error(
      `Account erasure could not verify quarantine topic ${quarantineTopic}: ${resource.errorMessage ?? `broker error ${resource.errorCode}`}`,
    );
  }
  const actualConfig = new Map(
    resource.configEntries.map((entry) => [entry.configName, entry.configValue]),
  );
  for (const [name, expectedValue] of expectedConfig) {
    const actualValue = actualConfig.get(name);
    if (actualValue !== expectedValue) {
      throw new Error(
        `Account erasure quarantine topic ${name} must be ${expectedValue}; found ${actualValue ?? "missing"}`,
      );
    }
  }
  return quarantineTopic;
}

export async function captureAccountErasureHighWatermarks(
  admin: Pick<RedpandaOffsetAdmin, "fetchTopicOffsets">,
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
  const quarantineTopic = await assertQuarantineTopicConfiguration(admin, sourceTopic);
  return captureAccountErasureHighWatermarks(admin, quarantineTopic);
}

export async function assertAccountErasureConsumersDrained(
  admin: Pick<RedpandaOffsetAdmin, "fetchOffsets">,
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
  admin: Pick<RedpandaOffsetAdmin, "fetchTopicOffsets">,
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
  const quarantineTopic = await assertQuarantineTopicConfiguration(admin, sourceTopic);
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
  admin: RedpandaAdmin;
  close(): Promise<void>;
  connect(): Promise<void>;
  topic: string;
}

export function createAccountErasureRedpandaAdminFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AccountErasureRedpandaAdmin {
  const topic = env.METRIC_STREAM_TOPIC;
  if (!topic) throw new Error("METRIC_STREAM_TOPIC is required for account erasure");
  const brokers = env.REDPANDA_BROKERS?.split(",")
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);
  if (!brokers || brokers.length === 0) {
    throw new Error("REDPANDA_BROKERS is required for account erasure");
  }
  const admin = new Kafka({
    brokers,
    clientId: "dofek-account-erasure",
  }).admin();
  return {
    admin,
    close: () => admin.disconnect(),
    connect: () => admin.connect(),
    topic,
  };
}
