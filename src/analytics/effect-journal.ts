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
import {
  type JournalDeliveryKey,
  journalDeliveryKey,
  journalDeliveryKeySchema,
  journalPositionColumns,
  metricStreamPositionIdentity,
  positionAtJournalKey,
} from "./journal-position.ts";
import { type SourcePlacement, sourcePlacementSchema } from "./source-placement.ts";

export type { SourcePlacement } from "./source-placement.ts";

export type AnalyticsStage = "scalar" | "dedup" | "activity";
export interface AnalyticsStream {
  transport: MetricStreamPosition["transport"];
  epoch: string;
  topic: string;
  partition: number;
}
export interface AnalyticsEffectCursor {
  delivery: JournalDeliveryKey;
  effectOrdinal: string;
}
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
  transport: z.enum(["pulsar", "kafka"]),
  epoch: z.string().min(1),
  topic: z.string().min(1),
  partition: z.number().int().min(-1).max(2147483647),
});
const cursorSchema = z.object({
  delivery: journalDeliveryKeySchema,
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
  transport: z.enum(["pulsar", "kafka"]),
  kafka_offset: z.string(),
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
  if (effect.position.transport !== effect.stream.transport)
    throw new Error("Analytics effect transport must match its stream");
  compareMetricStreamPositions(effect.position, {
    ...effect.position,
    epoch: effect.stream.epoch,
    topic: effect.stream.topic,
    partition: effect.stream.partition,
  });
  if (
    compareMetricStreamPositions(
      effect.position,
      positionAtJournalKey(effect.position, effect.cursor.delivery),
    ) !== 0
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
      effect.stream.transport,
      effect.stream.topic,
      effect.stream.partition,
      journalDeliveryKey(effect.position),
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
  return journalPositionColumns(position);
}
function receiptValues(position: MetricStreamPosition) {
  return journalPositionColumns(position);
}
const deliveryWhere =
  "epoch={epoch:String} AND topic={topic:String} AND partition={partition:Int32} AND transport={transport:String} AND kafka_offset={kafka_offset:UInt64} AND major={major:UInt64} AND minor={minor:UInt64} AND batch={batch:Int32}";
const integerSettings = { output_format_json_quote_64bit_integers: 1 };
async function readReceipt(
  client: Pick<ClickHouseClient, "query">,
  position: MetricStreamPosition,
  status: "prepared" | "committed" = "committed",
) {
  const result = await client.query({
    query: `SELECT serialized_message_id,effect_count,chunk_count,effect_digest,stages FROM analytics.delivery_receipt FINAL WHERE ${deliveryWhere} AND status={status:String} LIMIT 2`,
    query_params: { ...deliveryParams(position), status },
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
  return persistAnalyticsEffectPage(client, effects, "append");
}
async function persistAnalyticsEffectPage(
  client: ClickHouseClient,
  effects: readonly AnalyticsEffect[],
  phase: "prepare" | "commit" | "append",
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
      serialized_message_id:
        effect.position.transport === "pulsar" ? effect.position.serializedMessageId : "",
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
    if (phase !== "commit")
      await client.insert({
        table: "analytics.effect_journal",
        format: "JSONEachRow",
        values: rows,
        clickhouse_settings: { async_insert: 0 },
      });
    if (phase !== "prepare")
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
      metricStreamPositionIdentity(effect.position) !== metricStreamPositionIdentity(input.position)
    )
      throw new Error("Delivery receipt contains effects from another native message");
  const digest = createHash("sha256");
  for (const effect of effects) digest.update(effectHash(effect));
  const fingerprint = digest.digest("hex");
  const previous = await readReceipt(client, input.position);
  if (
    previous &&
    (previous.serialized_message_id !==
      (input.position.transport === "pulsar" ? input.position.serializedMessageId : "") ||
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
        serialized_message_id:
          input.position.transport === "pulsar" ? input.position.serializedMessageId : "",
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
  transport: z.enum(["pulsar", "kafka"]),
  kafka_offset: z.string(),
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
function decodeJournalRow(row: z.infer<typeof journalRowSchema>): AnalyticsEffect {
  const stream = {
    transport: row.transport,
    epoch: row.epoch,
    topic: row.topic,
    partition: row.partition,
  };
  const position: MetricStreamPosition =
    row.transport === "kafka"
      ? { ...stream, transport: "kafka", offset: row.kafka_offset }
      : {
          ...stream,
          transport: "pulsar",
          delivery: { major: row.major, minor: row.minor, batch: row.batch },
          serializedMessageId: row.serialized_message_id,
        };
  const effect = validateEffect({
    stream,
    position,
    cursor: { delivery: journalDeliveryKey(position), effectOrdinal: row.effect_ordinal },
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
    effectHash(effect) !== row.effect_hash
  )
    throw new Error("Analytics journal ownership or effect identity is corrupt");
  return effect;
}

async function* readSourceIntentPages(client: ClickHouseClient, position: MetricStreamPosition) {
  let afterOrdinal = "-1";
  for (;;) {
    const result = await client.query({
      query: `SELECT * FROM analytics.effect_journal FINAL WHERE ${deliveryWhere}
        AND stage='scalar' AND effect_ordinal>{afterOrdinal:Int128}
        ORDER BY effect_ordinal LIMIT {limit:UInt32}`,
      query_params: { ...deliveryParams(position), afterOrdinal, limit: RECEIPT_PAGE_SIZE },
      format: "JSONEachRow",
      clickhouse_settings: integerSettings,
    });
    const rows = z.array(journalRowSchema).parse(await result.json());
    if (!rows.length) return;
    const effects = rows.map(decodeJournalRow);
    for (const effect of effects) {
      if (metricStreamPositionIdentity(effect.position) !== metricStreamPositionIdentity(position))
        throw new Error("Prepared intent native message identity changed");
      if (BigInt(effect.cursor.effectOrdinal) !== BigInt(afterOrdinal) + 1n)
        throw new Error("Prepared intent contains a missing or duplicate ordinal");
      afterOrdinal = effect.cursor.effectOrdinal;
    }
    yield effects;
  }
}

async function sourceIntentFingerprint(client: ClickHouseClient, position: MetricStreamPosition) {
  const digest = createHash("sha256");
  let count = 0n;
  for await (const page of readSourceIntentPages(client, position)) {
    for (const effect of page) {
      digest.update(effectHash(effect));
      count++;
    }
  }
  return { effect_count: String(count), effect_digest: digest.digest("hex") };
}

async function verifyPreparation(client: ClickHouseClient, position: MetricStreamPosition) {
  const receipt = await readReceipt(client, position, "prepared");
  if (!receipt)
    throw new Error("Delivery has no complete preparation; resume preparing the original intent");
  const actual = await sourceIntentFingerprint(client, position);
  if (
    receipt.serialized_message_id !==
      (position.transport === "pulsar" ? position.serializedMessageId : "") ||
    receipt.effect_count !== actual.effect_count ||
    receipt.effect_digest !== actual.effect_digest ||
    receipt.chunk_count !== (actual.effect_count === "0" ? "1" : actual.effect_count) ||
    receipt.stages.length !== 1 ||
    receipt.stages[0] !== "scalar"
  )
    throw new Error("Complete preparation does not match its immutable structural intent");
  return receipt;
}

/**
 * Persist structural intent without discovery receipts. The generator must finish
 * before its manifest is published, including zero-effect and resumed preparations.
 * A complete manifest is replayed as-is; its source preimage is never recalculated.
 */
export async function prepareAnalyticsDelivery(
  client: ClickHouseClient,
  input: { position: MetricStreamPosition; pages(): AsyncIterable<readonly AnalyticsEffect[]> },
): Promise<void> {
  metricStreamPositionSchema.parse(input.position);
  if (!client.insert) throw new Error("Analytics preparation requires an insert-capable client");
  if (await readReceipt(client, input.position, "prepared")) {
    await verifyPreparation(client, input.position);
    return;
  }
  if (await readReceipt(client, input.position))
    throw new Error("Cannot prepare an already committed delivery");
  const digest = createHash("sha256");
  let count = 0n;
  for await (const page of input.pages()) {
    if (page.length > RECEIPT_PAGE_SIZE)
      throw new Error("Preparation accepts at most 20 effects per page");
    const effects = validateEffectBatch(page);
    for (const effect of effects) {
      if (
        effect.stage !== "scalar" ||
        BigInt(effect.cursor.effectOrdinal) !== count ||
        compareMetricStreamPositions(effect.position, input.position) !== 0 ||
        metricStreamPositionIdentity(effect.position) !==
          metricStreamPositionIdentity(input.position)
      )
        throw new Error(
          "Source preparation requires consecutive scalar effects from its exact delivery",
        );
      digest.update(effectHash(effect));
      count++;
    }
    await persistAnalyticsEffectPage(client, effects, "prepare");
  }
  const expected = { effect_count: String(count), effect_digest: digest.digest("hex") };
  const actual = await sourceIntentFingerprint(client, input.position);
  if (
    expected.effect_count !== actual.effect_count ||
    expected.effect_digest !== actual.effect_digest
  )
    throw new Error("Preparation ended before its previously persisted intent was complete");
  await client.insert({
    table: "analytics.delivery_receipt",
    format: "JSONEachRow",
    values: [
      {
        ...receiptValues(input.position),
        ...expected,
        serialized_message_id:
          input.position.transport === "pulsar" ? input.position.serializedMessageId : "",
        chunk_count: String(count === 0n ? 1n : count),
        stages: ["scalar"],
        status: "prepared",
      },
    ],
    clickhouse_settings: { async_insert: 0 },
  });
}

export async function* readPreparedAnalyticsEffectPages(
  client: ClickHouseClient,
  position: MetricStreamPosition,
): AsyncGenerator<readonly AnalyticsEffect[]> {
  // Verify the whole manifest with bounded reads before returning any raw-write work.
  await verifyPreparation(client, position);
  yield* readSourceIntentPages(client, position);
}

/** The caller must finish every raw mutation before making this intent discoverable. */
export async function commitPreparedAnalyticsDelivery(
  client: ClickHouseClient,
  position: MetricStreamPosition,
): Promise<void> {
  if (!client.insert) throw new Error("Analytics commit requires an insert-capable client");
  const prepared = await verifyPreparation(client, position);
  const previous = await readReceipt(client, position);
  if (previous && JSON.stringify(previous) !== JSON.stringify(prepared))
    throw new Error("Committed delivery differs from its complete preparation");
  for await (const page of readSourceIntentPages(client, position))
    await persistAnalyticsEffectPage(client, page, "commit");
  if (prepared.effect_count === "0")
    await client.insert({
      table: "analytics.effect_receipt",
      format: "JSONEachRow",
      values: [
        {
          ...receiptValues(position),
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
    values: [{ ...receiptValues(position), ...prepared, status: "committed" }],
    clickhouse_settings: { async_insert: 0 },
  });
}

async function readReferencedEffect(
  client: Pick<ClickHouseClient, "query">,
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
  const effect = decodeJournalRow(row);
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
  client: Pick<ClickHouseClient, "query">,
  position: MetricStreamPosition,
): Promise<{ effectCount: bigint }> {
  const receipt = await readReceipt(client, position);
  if (
    !receipt ||
    receipt.serialized_message_id !==
      (position.transport === "pulsar" ? position.serializedMessageId : "")
  )
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
  return { effectCount };
}

/** Missing completion is pending work; an existing corrupt receipt is an error. */
export async function hasCompleteAnalyticsDeliveryReceipt(
  client: Pick<ClickHouseClient, "query">,
  position: MetricStreamPosition,
): Promise<boolean> {
  if (!(await readReceipt(client, position))) return false;
  await verifyAnalyticsDeliveryReceipt(client, position);
  return true;
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
    compareMetricStreamPositions(positionAtJournalKey(frontier, input.after.delivery), frontier) > 0
  )
    throw new Error("Analytics page cursor exceeds its sealed frontier");
  const after = input.after;
  const afterPosition = after
    ? journalPositionColumns(positionAtJournalKey(frontier, after.delivery))
    : null;
  const upperBound =
    frontier.transport === "kafka"
      ? "kafka_offset<={kafka_offset:UInt64}"
      : "(major<{major:UInt64} OR (major={major:UInt64} AND minor<{minor:UInt64}) OR (major={major:UInt64} AND minor={minor:UInt64} AND batch<={batch:Int32}))";
  const lowerBound =
    frontier.transport === "kafka"
      ? "(kafka_offset>{afterOffset:UInt64} OR (kafka_offset={afterOffset:UInt64} AND effect_ordinal>{afterOrdinal:Int128}))"
      : "(major>{afterMajor:UInt64} OR (major={afterMajor:UInt64} AND minor>{afterMinor:UInt64}) OR (major={afterMajor:UInt64} AND minor={afterMinor:UInt64} AND batch>{afterBatch:Int32}) OR (major={afterMajor:UInt64} AND minor={afterMinor:UInt64} AND batch={afterBatch:Int32} AND effect_ordinal>{afterOrdinal:Int128}))";
  const result = await client.clickhouse.query({
    query: `SELECT * FROM analytics.effect_receipt FINAL
 PREWHERE epoch={epoch:String} AND topic={topic:String} AND partition={partition:Int32} AND transport={transport:String}
 WHERE stage={stage:String} AND ${frontier.transport === "pulsar" ? "kafka_offset=0" : "major=0 AND minor=0 AND batch=-1"} AND ${upperBound}
 ${after ? `AND ${lowerBound}` : ""}
 ORDER BY kafka_offset,major,minor,batch,effect_ordinal LIMIT {limit:UInt32}`,
    query_params: {
      ...deliveryParams(frontier),
      stage: input.stage,
      limit: input.limit + 1,
      afterOffset: afterPosition?.kafka_offset,
      afterMajor: afterPosition?.major,
      afterMinor: afterPosition?.minor,
      afterBatch: afterPosition?.batch,
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
          delivery:
            last.transport === "kafka"
              ? { offset: last.kafka_offset }
              : { major: last.major, minor: last.minor, batch: last.batch },
          effectOrdinal: last.effect_ordinal,
        }
      : input.after,
    exhausted: receipts.length <= input.limit,
  };
}
