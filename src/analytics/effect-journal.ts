import { createHash } from "node:crypto";
import { z } from "zod";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import type { Database } from "../db/index.ts";
import {
  compareMetricStreamPositions,
  type MetricStreamPosition,
  metricStreamPositionSchema,
} from "../metric-stream/transport-position.ts";
import { loadAnalyticsRunFrontier } from "./analytics-work-store.ts";
import { sourcePlacementSchema } from "./source-placement.ts";

export type AnalyticsStage = "scalar" | "dedup" | "activity";
export interface AnalyticsStream {
  epoch: string;
  topic: string;
  partition: number;
}
export interface JournalDeliveryKey {
  major: string;
  minor: string;
  batch: number;
}
export interface AnalyticsEffectCursor {
  delivery: JournalDeliveryKey;
  effectOrdinal: string;
}
export type SourcePlacement = z.infer<typeof sourcePlacementSchema>;
export type SensorKey = SourcePlacement["key"];
export interface AnalyticsEffect {
  stream: AnalyticsStream;
  position: MetricStreamPosition;
  cursor: AnalyticsEffectCursor;
  stage: AnalyticsStage;
  operationId: string | null;
  sourceId: string;
  sourceVersion: string;
  generation: string;
  before: SourcePlacement | null;
  after: SourcePlacement | null;
}
export interface AnalyticsEffectPage {
  effects: readonly AnalyticsEffect[];
  next: AnalyticsEffectCursor | null;
  exhausted: boolean;
}
export interface AnalyticsJournalClient {
  clickhouse: ClickHouseClient;
  database: Database;
}
const stageSchema = z.enum(["scalar", "dedup", "activity"]);
const stageOrder = { scalar: 1, dedup: 2, activity: 3 } as const;
const streamSchema = z.object({
  epoch: z.string().min(1),
  topic: z.string().min(1),
  partition: z.number().int().min(-1).max(2147483647),
});
const cursorSchema = z.object({
  delivery: metricStreamPositionSchema.shape.delivery,
  effectOrdinal: z.union([z.literal("-1"), sourcePlacementSchema.shape.sourceVersion]),
});
const effectSchema = z.object({
  stream: streamSchema,
  position: metricStreamPositionSchema,
  cursor: cursorSchema.extend({ effectOrdinal: sourcePlacementSchema.shape.sourceVersion }),
  stage: stageSchema,
  operationId: z.uuid().nullable(),
  sourceId: z.uuid(),
  sourceVersion: sourcePlacementSchema.shape.sourceVersion,
  generation: sourcePlacementSchema.shape.generation,
  before: sourcePlacementSchema.nullable(),
  after: sourcePlacementSchema.nullable(),
});
const receiptSchema = z.object({
  serialized_message_id: z.string(),
  effect_count: sourcePlacementSchema.shape.sourceVersion,
  chunk_count: sourcePlacementSchema.shape.sourceVersion,
  effect_digest: z.string().length(64),
  stages: z.array(stageSchema).min(1).max(3),
});
const discoveryReceiptSchema = z.object({
  epoch: z.string(),
  topic: z.string(),
  partition: z.number(),
  major: z.string(),
  minor: z.string(),
  batch: z.number(),
  effect_ordinal: cursorSchema.shape.effectOrdinal,
  stage: stageSchema,
  effect_hash: z.string().length(64),
  is_empty: z.number().int().min(0).max(1),
  user_id: z.uuid().nullable(),
});
type DiscoveryReceipt = z.infer<typeof discoveryReceiptSchema>;
const EMPTY_DIGEST = createHash("sha256").digest("hex");
// Each discovery receipt holds exactly one reference; pages inspect at most 20.
const RECEIPT_PAGE_SIZE = 20;

function validateEffect(input: AnalyticsEffect): AnalyticsEffect {
  const effect = effectSchema.parse(input);
  compareMetricStreamPositions(effect.position, { ...effect.position, ...effect.stream });
  if (
    compareMetricStreamPositions(effect.position, {
      ...effect.position,
      delivery: effect.cursor.delivery,
    }) !== 0
  )
    throw new Error("Effect cursor must identify its native delivery");
  const placements = [effect.before, effect.after].filter((placement) => placement !== null);
  const owner = placements[0]?.userId;
  if (
    !owner ||
    placements.some(
      (placement) => placement.sourceId !== effect.sourceId || placement.userId !== owner,
    )
  )
    throw new Error("Analytics source identity and account ownership must match all placements");
  if (
    effect.after &&
    (effect.after.sourceVersion !== effect.sourceVersion ||
      effect.after.generation !== effect.generation)
  )
    throw new Error("Analytics effect source version must match its new placement");
  return effect;
}
function validateEffectBatch(effects: readonly AnalyticsEffect[]): AnalyticsEffect[] {
  const validated = effects.map(validateEffect);
  const identities = new Set<string>();
  for (const effect of validated) {
    const identity = JSON.stringify([
      effect.stream.epoch,
      effect.stream.topic,
      effect.stream.partition,
      effect.cursor.delivery.major,
      effect.cursor.delivery.minor,
      effect.cursor.delivery.batch,
      effect.cursor.effectOrdinal,
      effect.stage,
    ]);
    // Exact duplicates are also invalid within a batch; replay uses separate calls.
    if (identities.has(identity))
      throw new Error("Analytics effect batch contains duplicate effect identities");
    identities.add(identity);
  }
  return validated;
}
function effectHash(effect: AnalyticsEffect) {
  return createHash("sha256").update(JSON.stringify(effect)).digest("hex");
}
function deliveryParams(position: MetricStreamPosition) {
  return { ...position, ...position.delivery };
}
function receiptValues(position: MetricStreamPosition) {
  return {
    epoch: position.epoch,
    topic: position.topic,
    partition: position.partition,
    ...position.delivery,
  };
}
const deliveryWhere =
  "epoch={epoch:String} AND topic={topic:String} AND partition={partition:Int32} AND major={major:UInt64} AND minor={minor:UInt64} AND batch={batch:Int32}";
const integerSettings = { output_format_json_quote_64bit_integers: 1 };
async function readReceipt(client: ClickHouseClient, position: MetricStreamPosition) {
  const result = await client.query({
    query: `SELECT serialized_message_id,effect_count,chunk_count,effect_digest,stages FROM analytics.delivery_receipt FINAL WHERE ${deliveryWhere} LIMIT 2`,
    query_params: deliveryParams(position),
    format: "JSONEachRow",
    clickhouse_settings: integerSettings,
  });
  const rows = z.array(receiptSchema).parse(await result.json());
  if (rows.length > 1) throw new Error("Conflicting analytics delivery receipts");
  return rows[0];
}
export async function appendAnalyticsEffects(
  client: ClickHouseClient,
  effects: readonly AnalyticsEffect[],
): Promise<void> {
  if (!client.insert)
    throw new Error("Analytics journal requires a ClickHouse insert-capable client");
  const validated = validateEffectBatch(effects);
  const rows: object[] = [];
  const receipts: object[] = [];
  for (const effect of validated) {
    const hash = effectHash(effect);
    const receipt = await readReceipt(client, effect.position);
    const params = {
      ...deliveryParams(effect.position),
      ordinal: effect.cursor.effectOrdinal,
      stage: effect.stage,
    };
    const expectedResult = await client.query({
      query: `SELECT effect_hash FROM analytics.effect_receipt FINAL WHERE ${deliveryWhere} AND effect_ordinal={ordinal:Int128} AND stage={stage:String} LIMIT 2`,
      query_params: params,
      format: "JSONEachRow",
    });
    const expected = z
      .array(z.object({ effect_hash: z.string() }))
      .parse(await expectedResult.json());
    if (receipt?.stages.includes(effect.stage) && !expected.some((row) => row.effect_hash === hash))
      throw new Error(
        "Analytics delivery receipt forbids adding or changing effects in a closed stage",
      );
    if (expected.some((row) => row.effect_hash !== hash))
      throw new Error("Replay changed an existing analytics effect receipt identity");
    const prior = await client.query({
      query: `SELECT effect_hash FROM analytics.effect_journal FINAL WHERE ${deliveryWhere} AND effect_ordinal={ordinal:UInt64} AND stage={stage:String} LIMIT 2`,
      query_params: params,
      format: "JSONEachRow",
    });
    for (const row of z.array(z.object({ effect_hash: z.string() })).parse(await prior.json()))
      if (row.effect_hash !== hash)
        throw new Error("Replay changed an existing analytics effect identity");
    const owner = effect.after?.userId ?? effect.before?.userId;
    if (!owner) throw new Error("Analytics effect account ownership is missing");
    rows.push({
      ...receiptValues(effect.position),
      effect_ordinal: effect.cursor.effectOrdinal,
      stage: effect.stage,
      serialized_message_id: effect.position.serializedMessageId,
      operation_id: effect.operationId,
      user_id: owner,
      source_id: effect.sourceId,
      source_version: effect.sourceVersion,
      generation: effect.generation,
      before: effect.before === null ? null : JSON.stringify(effect.before),
      after: effect.after === null ? null : JSON.stringify(effect.after),
      effect_hash: hash,
    });
    receipts.push({
      ...receiptValues(effect.position),
      effect_ordinal: effect.cursor.effectOrdinal,
      stage: effect.stage,
      effect_hash: hash,
      is_empty: 0,
      user_id: owner,
    });
  }
  if (rows.length) {
    await client.insert({
      table: "analytics.effect_journal",
      format: "JSONEachRow",
      values: rows,
      clickhouse_settings: { async_insert: 0 },
    });
    await client.insert({
      table: "analytics.effect_receipt",
      format: "JSONEachRow",
      values: receipts,
      clickhouse_settings: { async_insert: 0 },
    });
  }
}
export async function appendAnalyticsDelivery(
  client: ClickHouseClient,
  input: { position: MetricStreamPosition; effects: readonly AnalyticsEffect[] },
): Promise<void> {
  metricStreamPositionSchema.parse(input.position);
  if (!client.insert)
    throw new Error("Analytics receipt requires a ClickHouse insert-capable client");
  const effects = validateEffectBatch(input.effects).sort((left, right) => {
    const leftOrdinal = BigInt(left.cursor.effectOrdinal),
      rightOrdinal = BigInt(right.cursor.effectOrdinal);
    return leftOrdinal === rightOrdinal
      ? stageOrder[left.stage] - stageOrder[right.stage]
      : leftOrdinal < rightOrdinal
        ? -1
        : 1;
  });
  for (const effect of effects)
    if (
      compareMetricStreamPositions(effect.position, input.position) !== 0 ||
      effect.position.serializedMessageId !== input.position.serializedMessageId
    )
      throw new Error("Delivery receipt contains effects from another native message");
  const digest = createHash("sha256");
  for (const effect of effects) digest.update(effectHash(effect));
  const fingerprint = digest.digest("hex");
  const previous = await readReceipt(client, input.position);
  if (
    previous &&
    (previous.serialized_message_id !== input.position.serializedMessageId ||
      previous.effect_count !== String(effects.length) ||
      previous.effect_digest !== fingerprint)
  )
    throw new Error("Analytics delivery receipt does not match replayed effects");
  await appendAnalyticsEffects(client, effects);
  if (!effects.length)
    await client.insert({
      table: "analytics.effect_receipt",
      format: "JSONEachRow",
      values: [
        {
          ...receiptValues(input.position),
          effect_ordinal: "-1",
          stage: "scalar",
          effect_hash: EMPTY_DIGEST,
          is_empty: 1,
          user_id: null,
        },
      ],
      clickhouse_settings: { async_insert: 0 },
    });
  await client.insert({
    table: "analytics.delivery_receipt",
    format: "JSONEachRow",
    values: [
      {
        ...receiptValues(input.position),
        serialized_message_id: input.position.serializedMessageId,
        effect_count: String(effects.length),
        chunk_count: String(Math.max(1, effects.length)),
        effect_digest: fingerprint,
        stages: effects.length ? [...new Set(effects.map((effect) => effect.stage))] : ["scalar"],
      },
    ],
    clickhouse_settings: { async_insert: 0 },
  });
}
const journalRowSchema = z.object({
  epoch: z.string(),
  topic: z.string(),
  partition: z.number(),
  major: z.string(),
  minor: z.string(),
  batch: z.number(),
  effect_ordinal: z.string(),
  stage: stageSchema,
  serialized_message_id: z.string(),
  operation_id: z.string().nullable(),
  user_id: z.string(),
  source_id: z.string(),
  source_version: z.string(),
  generation: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  effect_hash: z.string(),
});
async function readReferencedEffect(
  client: ClickHouseClient,
  receipt: DiscoveryReceipt,
): Promise<AnalyticsEffect | null> {
  if (receipt.is_empty) {
    if (receipt.effect_ordinal !== "-1" || receipt.effect_hash !== EMPTY_DIGEST)
      throw new Error("Malformed empty analytics discovery receipt");
    return null;
  }
  if (receipt.effect_ordinal === "-1")
    throw new Error("Negative ordinal cannot identify an analytics effect");
  const result = await client.query({
    query: `SELECT * FROM analytics.effect_journal FINAL WHERE ${deliveryWhere} AND effect_ordinal={ordinal:UInt64} AND stage={stage:String} LIMIT 2`,
    query_params: { ...receipt, ordinal: receipt.effect_ordinal },
    format: "JSONEachRow",
    clickhouse_settings: integerSettings,
  });
  const rows = z.array(journalRowSchema).parse(await result.json());
  const row = rows[0];
  if (rows.length !== 1 || !row)
    throw new Error(
      `Missing analytics journal effect referenced by receipt ${receipt.topic}/${receipt.partition}/${receipt.major}:${receipt.minor}:${receipt.batch}/${receipt.effect_ordinal}/${receipt.stage}; replay the input delivery`,
    );
  const stream = { epoch: row.epoch, topic: row.topic, partition: row.partition };
  const delivery = { major: row.major, minor: row.minor, batch: row.batch };
  const effect = validateEffect({
    stream,
    position: { ...stream, delivery, serializedMessageId: row.serialized_message_id },
    cursor: { delivery, effectOrdinal: row.effect_ordinal },
    stage: row.stage,
    operationId: row.operation_id,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    generation: row.generation,
    before: row.before === null ? null : sourcePlacementSchema.parse(JSON.parse(row.before)),
    after: row.after === null ? null : sourcePlacementSchema.parse(JSON.parse(row.after)),
  });
  if (
    (effect.after?.userId ?? effect.before?.userId) !== row.user_id ||
    receipt.user_id !== row.user_id ||
    effectHash(effect) !== row.effect_hash ||
    row.effect_hash !== receipt.effect_hash
  )
    throw new Error("Analytics journal ownership or receipt effect identity is corrupt");
  return effect;
}
export async function verifyAnalyticsDeliveryReceipt(
  client: ClickHouseClient,
  position: MetricStreamPosition,
): Promise<void> {
  const receipt = await readReceipt(client, position);
  if (!receipt || receipt.serialized_message_id !== position.serializedMessageId)
    throw new Error("Durable analytics delivery receipt is missing or mismatched");
  const digest = createHash("sha256");
  let effectCount = 0n,
    chunkCount = 0n;
  let afterOrdinal = "-2",
    afterStage = 0;
  for (;;) {
    const result = await client.query({
      query: `SELECT * FROM analytics.effect_receipt FINAL WHERE ${deliveryWhere} AND stage IN {stages:Array(String)} AND (effect_ordinal>{afterOrdinal:Int128} OR (effect_ordinal={afterOrdinal:Int128} AND toInt8(stage)>{afterStage:Int8})) ORDER BY effect_ordinal,stage LIMIT {limit:UInt32}`,
      query_params: {
        ...deliveryParams(position),
        stages: receipt.stages,
        afterOrdinal,
        afterStage,
        limit: RECEIPT_PAGE_SIZE,
      },
      format: "JSONEachRow",
      clickhouse_settings: integerSettings,
    });
    const refs = z.array(discoveryReceiptSchema).parse(await result.json());
    if (!refs.length) break;
    for (const reference of refs) {
      chunkCount++;
      if (chunkCount > BigInt(receipt.chunk_count))
        throw new Error("Analytics delivery receipt has unexpected effect references");
      const effect = await readReferencedEffect(client, reference);
      if (effect) {
        effectCount++;
        digest.update(effectHash(effect));
      }
      afterOrdinal = reference.effect_ordinal;
      afterStage = stageOrder[reference.stage];
    }
  }
  if (
    effectCount !== BigInt(receipt.effect_count) ||
    chunkCount !== BigInt(receipt.chunk_count) ||
    digest.digest("hex") !== receipt.effect_digest
  )
    throw new Error(
      "Analytics delivery receipt is incomplete: durable effect identities do not match",
    );
}
export async function readAnalyticsEffectPage(
  client: AnalyticsJournalClient,
  input: {
    runId: string;
    stage: AnalyticsStage;
    stream: AnalyticsStream;
    after: AnalyticsEffectCursor | null;
    limit: number;
  },
): Promise<AnalyticsEffectPage> {
  z.number().int().min(1).max(RECEIPT_PAGE_SIZE).parse(input.limit);
  stageSchema.parse(input.stage);
  if (input.after) cursorSchema.parse(input.after);
  const frontier = await loadAnalyticsRunFrontier(client.database, input);
  if (
    input.after &&
    compareMetricStreamPositions({ ...frontier, delivery: input.after.delivery }, frontier) > 0
  )
    throw new Error("Analytics page cursor exceeds its sealed frontier");
  const after = input.after;
  const result = await client.clickhouse.query({
    query: `SELECT * FROM analytics.effect_receipt FINAL
 PREWHERE epoch={epoch:String} AND topic={topic:String} AND partition={partition:Int32}
 WHERE stage={stage:String} AND (major<{major:UInt64} OR (major={major:UInt64} AND minor<{minor:UInt64}) OR (major={major:UInt64} AND minor={minor:UInt64} AND batch<={batch:Int32}))
 ${after ? "AND (major>{afterMajor:UInt64} OR (major={afterMajor:UInt64} AND minor>{afterMinor:UInt64}) OR (major={afterMajor:UInt64} AND minor={afterMinor:UInt64} AND batch>{afterBatch:Int32}) OR (major={afterMajor:UInt64} AND minor={afterMinor:UInt64} AND batch={afterBatch:Int32} AND effect_ordinal>{afterOrdinal:Int128}))" : ""}
 ORDER BY major,minor,batch,effect_ordinal LIMIT {limit:UInt32}`,
    query_params: {
      ...deliveryParams(frontier),
      stage: input.stage,
      limit: input.limit + 1,
      afterMajor: after?.delivery.major,
      afterMinor: after?.delivery.minor,
      afterBatch: after?.delivery.batch,
      afterOrdinal: after?.effectOrdinal,
    },
    format: "JSONEachRow",
    clickhouse_settings: integerSettings,
  });
  const receipts = z.array(discoveryReceiptSchema).parse(await result.json());
  const selected = receipts.slice(0, input.limit);
  const effects: AnalyticsEffect[] = [];
  for (const receipt of selected) {
    const effect = await readReferencedEffect(client.clickhouse, receipt);
    if (effect) effects.push(effect);
  }
  const last = selected.at(-1);
  return {
    effects,
    next: last
      ? {
          delivery: { major: last.major, minor: last.minor, batch: last.batch },
          effectOrdinal: last.effect_ordinal,
        }
      : input.after,
    exhausted: receipts.length <= input.limit,
  };
}
