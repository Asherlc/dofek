import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import Pulsar from "pulsar-client";
import { analyticsWorkSchemaStatements } from "../db/analytics-work-schema.ts";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { setupTestDatabase } from "../db/test-helpers.ts";
import {
  type MetricStreamPosition,
  metricStreamPosition,
  type PulsarMetricStreamPosition,
} from "../metric-stream/transport-position.ts";
import { createProcessingOperation } from "../processing/processing-event-store.ts";
import { claimAnalyticsStream, sealAnalyticsRun } from "./analytics-work-store.ts";
import type { AnalyticsEffect, AnalyticsStream } from "./effect-journal.ts";
import { journalDeliveryKey, journalPositionColumns } from "./journal-position.ts";

export function analyticsPosition(
  stream: AnalyticsStream,
  entry: bigint,
): PulsarMetricStreamPosition {
  const bytes = [8, 10, 16];
  let remaining = entry;
  while (remaining >= 128n) {
    bytes.push(Number(remaining & 127n) | 128);
    remaining >>= 7n;
  }
  bytes.push(Number(remaining));
  if (stream.partition >= 0) {
    bytes.push(24);
    remaining = BigInt(stream.partition);
    while (remaining >= 128n) {
      bytes.push(Number(remaining & 127n) | 128);
      remaining >>= 7n;
    }
    bytes.push(Number(remaining));
  }
  return metricStreamPosition(stream, MessageId.deserialize(Buffer.from(bytes)));
}

export function analyticsEffect(
  position: PulsarMetricStreamPosition,
  ordinal: bigint,
  userId: string,
): AnalyticsEffect & {
  position: PulsarMetricStreamPosition;
  cursor: { delivery: PulsarMetricStreamPosition["delivery"]; effectOrdinal: string };
} {
  const sourceId = randomUUID();
  return {
    stream: {
      transport: position.transport,
      epoch: position.epoch,
      topic: position.topic,
      partition: position.partition,
    },
    position,
    cursor: { delivery: position.delivery, effectOrdinal: String(ordinal) },
    stage: "scalar",
    operationId: null,
    sourceId,
    sourceVersion: "9007199254740993",
    generation: "0",
    before: null,
    after: {
      sourceId,
      userId,
      providerId: "test",
      sourceVersion: "9007199254740993",
      generation: "0",
      key: { userId, channel: "heart_rate", recordedAt: "2026-11-03T00:00:00.123456789Z" },
      activityId: null,
      deleted: false,
    },
  };
}

export async function createAnalyticsTestContext() {
  const postgres = await setupTestDatabase();
  const userId = randomUUID();
  await postgres.db.execute(
    sql`INSERT INTO fitness.user_profile (id,name) VALUES (${userId},'Analytics fixture')`,
  );
  const operation = await createProcessingOperation(postgres.db, {
    userId,
    providerId: "test",
    kind: "provider_sync",
    datasetKeys: ["activity"],
  });
  const namespace = `analytics_work_${randomUUID().replaceAll("-", "")}`;
  const real = createClickHouseClientFromEnv();
  const rewrite = (query: string) => query.replaceAll("analytics.", `${namespace}.`);
  function makeClient(): ClickHouseClient {
    const connection = createClickHouseClientFromEnv();
    if (!connection.insert) throw new Error("Analytics fixture requires ClickHouse insert");
    const insert = connection.insert.bind(connection);
    return {
      command: (options) => connection.command({ ...options, query: rewrite(options.query) }),
      query: (options) => connection.query({ ...options, query: rewrite(options.query) }),
      insert: (options) => insert({ ...options, table: rewrite(options.table) }),
      close: () => connection.close?.() ?? Promise.resolve(),
    };
  }
  await real.command({ query: `CREATE DATABASE ${namespace}` });
  const clickhouse = makeClient();
  for (const query of analyticsWorkSchemaStatements()) await clickhouse.command({ query });
  const stream = {
    transport: "pulsar" as const,
    epoch: randomUUID(),
    topic: `persistent://public/default/fixture-${randomUUID()}`,
    partition: -1,
  };
  return {
    connectionString: postgres.connectionString,
    namespace,
    database: postgres.db,
    clickhouse,
    makeClient,
    userId,
    operation,
    stream,
    async cleanup() {
      await clickhouse.close?.();
      await real.command({ query: `DROP DATABASE ${namespace} SYNC` });
      await real.close?.();
      await postgres.cleanup();
    },
  };
}

const { MessageId } = Pulsar;

/** Current final-state fixture; bulk writes avoid replaying thousands of intake calls. */
export async function seedAnalyticsKeysetFixture(
  context: Awaited<ReturnType<typeof createAnalyticsTestContext>>,
  shape: "one-delivery" | "many-deliveries",
  transport: "pulsar" | "kafka" = "pulsar",
) {
  const stream = {
    ...context.stream,
    epoch: randomUUID(),
    transport,
    partition: transport === "kafka" ? 0 : context.stream.partition,
  };
  const makePosition = (offset: bigint): MetricStreamPosition =>
    transport === "pulsar"
      ? analyticsPosition(stream, offset)
      : { ...stream, transport: "kafka", offset: String(offset) };
  const position = makePosition(50000n);
  const base = analyticsEffect(
    analyticsPosition({ ...stream, transport: "pulsar" }, 50000n),
    0n,
    context.userId,
  );
  const count = 40000;
  const effects = Array.from({ length: count }, (_, index) => {
    const current = shape === "one-delivery" ? position : makePosition(BigInt(index));
    return {
      ...base,
      stream,
      position: current,
      cursor: {
        delivery: journalDeliveryKey(current),
        effectOrdinal: shape === "one-delivery" ? String(index) : "0",
      },
    };
  });
  const hashes = effects.map((effect) =>
    createHash("sha256").update(JSON.stringify(effect)).digest("hex"),
  );
  const journal = effects.map((effect, index) => ({
    ...journalPositionColumns(effect.position),
    effect_ordinal: effect.cursor.effectOrdinal,
    stage: effect.stage,
    serialized_message_id:
      effect.position.transport === "pulsar" ? effect.position.serializedMessageId : "",
    operation_id: effect.operationId,
    user_id: context.userId,
    source_id: effect.sourceId,
    source_version: effect.sourceVersion,
    generation: effect.generation,
    before: null,
    after: JSON.stringify(effect.after),
    effect_hash: hashes[index],
  }));
  const references = effects.map((effect, index) => ({
    ...journalPositionColumns(effect.position),
    effect_ordinal: effect.cursor.effectOrdinal,
    stage: effect.stage,
    effect_hash: hashes[index],
    user_id: context.userId,
    is_empty: 0,
  }));
  if (!context.clickhouse.insert) throw new Error("Fixture requires insert");
  await context.clickhouse.insert({
    table: "analytics.effect_journal",
    format: "JSONEachRow",
    values: journal,
  });
  await context.clickhouse.insert({
    table: "analytics.effect_receipt",
    format: "JSONEachRow",
    values: references,
  });
  const aggregate = createHash("sha256");
  for (const hash of hashes) aggregate.update(hash);
  const final = effects.at(-1)?.position;
  if (!final) throw new Error("Missing fixture frontier");
  const deliveries =
    shape === "one-delivery"
      ? [
          {
            ...journalPositionColumns(final),
            serialized_message_id: final.transport === "pulsar" ? final.serializedMessageId : "",
            effect_count: String(count),
            chunk_count: String(count),
            effect_digest: aggregate.digest("hex"),
            stages: ["scalar"],
          },
        ]
      : effects.map((effect, index) => ({
          ...journalPositionColumns(effect.position),
          serialized_message_id:
            effect.position.transport === "pulsar" ? effect.position.serializedMessageId : "",
          effect_count: "1",
          chunk_count: "1",
          effect_digest: createHash("sha256")
            .update(hashes[index] ?? "")
            .digest("hex"),
          stages: ["scalar"],
        }));
  await context.clickhouse.insert({
    table: "analytics.delivery_receipt",
    format: "JSONEachRow",
    values: deliveries,
  });
  const ownerId = randomUUID();
  await claimAnalyticsStream(context.database, { stream, ownerId, expectedOwnerId: null });
  await context.database.execute(
    sql`UPDATE fitness.analytics_stream_state SET processed=${JSON.stringify(final)}::jsonb WHERE epoch=${stream.epoch} AND topic=${stream.topic} AND partition=${stream.partition}`,
  );
  const runId = randomUUID();
  await sealAnalyticsRun(context.database, {
    runId,
    frontiers: [
      { operationId: context.operation.id, datasetKey: "activity", stream, position: final },
    ],
  });
  const after = effects[count - 21]?.cursor;
  if (!after) throw new Error("Missing fixture cursor");
  return { stream, runId, after, expected: effects.slice(-20), total: count };
}
