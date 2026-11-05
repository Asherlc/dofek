import { createHash, randomUUID } from "node:crypto";

import { TupleParam } from "@clickhouse/client";

import { z } from "zod";

import type { ClickHouseClient } from "../db/clickhouse.ts";

import type { Database } from "../db/index.ts";

import {
  compareMetricStreamPositions,
  type MetricStreamPosition,
  metricStreamPositionSchema,
} from "../metric-stream/transport-position.ts";

import {
  type AnalyticsEffectCursor,
  type AnalyticsStream,
  journalDeliveryKey,
  journalDeliveryKeySchema,
  journalPositionColumns,
  metricStreamPositionIdentity,
  positionAtJournalKey,
} from "./journal-position.ts";

import { type SourcePlacement, sourcePlacementSchema } from "./source-placement.ts";

export type AnalyticsStage = "scalar" | "dedup" | "activity";

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

export interface AnalyticsJournalClient {
  clickhouse: ClickHouseClient;
  database: Database;
}

export const DETERMINISTIC_PREPARATION_ATTEMPT = "00000000-0000-0000-0000-000000000000";

const stageSchema = z.enum(["scalar", "dedup", "activity"]);

export const stageOrder = { scalar: 1, dedup: 2, activity: 3 } as const;

const analyticsStreamSchema = z
  .object({
    transport: z.enum(["pulsar", "kafka"]),
    epoch: z.string().min(1),
    topic: z.string().min(1),
    partition: z.number().int().min(-1).max(2147483647),
  })
  .refine((stream) => stream.transport !== "kafka" || stream.partition >= 0, {
    path: ["partition"],
    message: "Kafka partition must be nonnegative",
  });

const analyticsEffectCursorSchema = z.strictObject({
  delivery: journalDeliveryKeySchema,
  effectOrdinal: z.union([z.literal("-1"), sourcePlacementSchema.shape.sourceVersion]),
});

const effectSchema = z.object({
  stream: analyticsStreamSchema,
  position: metricStreamPositionSchema,
  cursor: analyticsEffectCursorSchema.extend({
    effectOrdinal: sourcePlacementSchema.shape.sourceVersion,
  }),
  stage: stageSchema,
  operationId: z.uuid().nullable(),
  sourceId: z.uuid(),
  sourceVersion: sourcePlacementSchema.shape.sourceVersion,
  generation: sourcePlacementSchema.shape.generation,
  before: sourcePlacementSchema.nullable(),
  after: sourcePlacementSchema.nullable(),
});

export const receiptSchema = z.object({
  preparation_attempt: z.uuid(),
  serialized_message_id: z.string(),
  effect_count: sourcePlacementSchema.shape.sourceVersion,
  chunk_count: sourcePlacementSchema.shape.sourceVersion,
  effect_digest: z.string().length(64),
  stages: z.array(stageSchema).min(1).max(3),
});

export const discoveryReceiptSchema = z.object({
  preparation_attempt: z.uuid(),
  outcome: z.enum(["written", "fenced", "generation_filtered"]),
  transport: z.enum(["pulsar", "kafka"]),
  kafka_offset: z.string(),
  epoch: z.string(),
  topic: z.string(),
  partition: z.number(),
  major: z.string(),
  minor: z.string(),
  batch: z.number(),
  effect_ordinal: analyticsEffectCursorSchema.shape.effectOrdinal,
  stage: stageSchema,
  effect_hash: z.string().length(64),
  is_empty: z.number().int().min(0).max(1),
  user_id: z.uuid().nullable(),
});

export type DiscoveryReceipt = z.infer<typeof discoveryReceiptSchema>;

export const EMPTY_DIGEST = createHash("sha256").digest("hex");

// Each discovery receipt holds exactly one reference; pages inspect at most 20.
export const RECEIPT_PAGE_SIZE = 20;

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

export function validateEffectBatch(effects: readonly AnalyticsEffect[]): AnalyticsEffect[] {
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

export function effectHash(effect: AnalyticsEffect) {
  return createHash("sha256").update(JSON.stringify(effect)).digest("hex");
}

export function deliveryParams(position: MetricStreamPosition) {
  return journalPositionColumns(position);
}

export function receiptValues(position: MetricStreamPosition) {
  return journalPositionColumns(position);
}

const deliveryWhere =
  "epoch={epoch:String} AND topic={topic:String} AND partition={partition:Int32} AND transport={transport:String} AND kafka_offset={kafka_offset:UInt64} AND major={major:UInt64} AND minor={minor:UInt64} AND batch={batch:Int32}";

export const integerSettings = { output_format_json_quote_64bit_integers: 1 };

export const storageKeySchema = discoveryReceiptSchema.pick({
  epoch: true,
  topic: true,
  partition: true,
  transport: true,
  kafka_offset: true,
  major: true,
  minor: true,
  batch: true,
});

const attemptKeySchema = storageKeySchema.extend({ preparation_attempt: z.uuid() });

const effectKeySchema = attemptKeySchema.extend({
  effect_ordinal: sourcePlacementSchema.shape.sourceVersion,
  stage: stageSchema,
});

type StorageKey = z.infer<typeof storageKeySchema>;

type EffectKey = z.infer<typeof effectKeySchema>;

export function storageKey(row: StorageKey): string {
  return JSON.stringify([
    row.epoch,
    row.topic,
    row.partition,
    row.transport,
    row.kafka_offset,
    row.major,
    row.minor,
    row.batch,
  ]);
}

function effectKey(row: EffectKey): string {
  return JSON.stringify([storageKey(row), row.preparation_attempt, row.effect_ordinal, row.stage]);
}

export function selectKeys(
  keys: readonly (StorageKey | z.infer<typeof attemptKeySchema> | EffectKey)[],
) {
  // Delivery manifests can cover one finite intake group. Effect/reference
  // callers still enforce their separate twenty-reference page bound.
  z.number().int().min(1).max(500).parse(keys.length);
  let columns = "";
  let types = "";
  const tuples = keys.map((key) => {
    const fields: [string, string, unknown][] = [
      ["epoch", "String", key.epoch],
      ["topic", "String", key.topic],
      ["partition", "Int32", key.partition],
      ["transport", "String", key.transport],
      ["kafka_offset", "UInt64", key.kafka_offset],
      ["major", "UInt64", key.major],
      ["minor", "UInt64", key.minor],
      ["batch", "Int32", key.batch],
    ];
    if ("preparation_attempt" in key)
      fields.push(["preparation_attempt", "UUID", key.preparation_attempt]);
    if ("effect_ordinal" in key)
      fields.push(["effect_ordinal", "UInt64", key.effect_ordinal], ["stage", "String", key.stage]);
    columns = fields.map(([name]) => name).join(",");
    types = fields.map(([, type]) => type).join(",");
    return new TupleParam(
      fields.map(([, type, value]) => (type === "UInt64" ? BigInt(String(value)) : value)),
    );
  });
  return {
    columns,
    params: { deliveryKeys: tuples },
    where: `(${columns}) IN {deliveryKeys:Array(Tuple(${types}))}`,
  };
}

export function indexProofRows<Row>(
  rows: readonly Row[],
  expected: ReadonlySet<string>,
  identify: (row: Row) => string,
) {
  const indexed = new Map<string, Row[]>();
  for (const row of rows) {
    const key = identify(row);
    if (!expected.has(key)) throw new Error("Unexpected analytics proof identity");
    const matches = indexed.get(key) ?? [];
    if (matches.length === 2) throw new Error("Analytics proof exceeded its per-key bound");
    matches.push(row);
    indexed.set(key, matches);
  }
  return indexed;
}

async function readEffectProofs(
  client: Pick<ClickHouseClient, "query">,
  effects: readonly AnalyticsEffect[],
  preparationAttempt: string,
) {
  const keys = effects.map((effect) => ({
    ...deliveryParams(effect.position),
    preparation_attempt: preparationAttempt,
    effect_ordinal: effect.cursor.effectOrdinal,
    stage: effect.stage,
  }));
  const deliveries = [
    ...new Map(
      effects.map((effect) => {
        const key = deliveryParams(effect.position);
        return [storageKey(key), key] as const;
      }),
    ).values(),
  ];
  const delivery = selectKeys(deliveries);
  const manifests = await client.query({
    query: `SELECT ${delivery.columns},preparation_attempt,serialized_message_id,effect_count,chunk_count,effect_digest,stages
      FROM analytics.delivery_receipt FINAL WHERE ${delivery.where} AND status='committed'
      LIMIT 2 BY ${delivery.columns}`,
    query_params: delivery.params,
    format: "JSONEachRow",
    clickhouse_settings: integerSettings,
  });
  const manifestRows = z
    .array(storageKeySchema.merge(receiptSchema))
    .max(deliveries.length * 2)
    .parse(await manifests.json());
  const manifestIndex = indexProofRows(
    manifestRows,
    new Set(deliveries.map(storageKey)),
    storageKey,
  );
  const selected = selectKeys(keys);
  const expected = new Set(keys.map(effectKey));
  const hashSchema = effectKeySchema.extend({ effect_hash: z.string() });
  const discovery = await client.query({
    query: `SELECT ${selected.columns},effect_hash,outcome FROM analytics.effect_receipt FINAL
      WHERE ${selected.where} LIMIT 2 BY ${selected.columns}`,
    query_params: selected.params,
    format: "JSONEachRow",
    clickhouse_settings: integerSettings,
  });
  const receipts = indexProofRows(
    z
      .array(hashSchema.extend({ outcome: z.enum(["written", "fenced", "generation_filtered"]) }))
      .max(keys.length * 2)
      .parse(await discovery.json()),
    expected,
    effectKey,
  );
  const prior = await client.query({
    query: `SELECT ${selected.columns},effect_hash FROM analytics.effect_journal FINAL
      WHERE ${selected.where} LIMIT 2 BY ${selected.columns}`,
    query_params: selected.params,
    format: "JSONEachRow",
    clickhouse_settings: integerSettings,
  });
  const journal = indexProofRows(
    z
      .array(hashSchema)
      .max(keys.length * 2)
      .parse(await prior.json()),
    expected,
    effectKey,
  );
  return { manifests: manifestIndex, receipts, journal };
}

async function readReceipt(
  client: Pick<ClickHouseClient, "query">,
  position: MetricStreamPosition,
  status: "prepared" | "committed" = "committed",
) {
  const result = await client.query({
    query: `SELECT preparation_attempt,serialized_message_id,effect_count,chunk_count,effect_digest,stages FROM analytics.delivery_receipt FINAL WHERE ${deliveryWhere} AND status={status:String} LIMIT 2`,
    query_params: { ...deliveryParams(position), status },
    format: "JSONEachRow",
    clickhouse_settings: integerSettings,
  });
  const rows = z.array(receiptSchema).parse(await result.json());
  if (rows.length > 1) throw new Error("Conflicting analytics delivery receipts");
  return rows[0];
}

export async function persistAnalyticsEffectPage(
  client: ClickHouseClient,
  effects: readonly AnalyticsEffect[],
  phase: "prepare" | "commit" | "prepareFresh" | "commitFresh",
  preparationAttempt: string,
  outcome: "written" | "generation_filtered",
): Promise<void> {
  if (!client.insert)
    throw new Error("Analytics journal requires a ClickHouse insert-capable client");
  z.enum(["written", "generation_filtered"]).parse(outcome);
  const validated = validateEffectBatch(effects);
  const rows: object[] = [];
  const receipts: object[] = [];
  for (let offset = 0; offset < validated.length; offset += RECEIPT_PAGE_SIZE) {
    const page = validated.slice(offset, offset + RECEIPT_PAGE_SIZE);
    // A fresh group has one artifact probe under exclusive publication ownership.
    // Its newly written rows are verified together before the frontier advances.
    const proofs =
      phase === "prepareFresh" ? null : await readEffectProofs(client, page, preparationAttempt);
    for (const effect of page) {
      const hash = effectHash(effect);
      const key = {
        ...deliveryParams(effect.position),
        preparation_attempt: preparationAttempt,
        effect_ordinal: effect.cursor.effectOrdinal,
        stage: effect.stage,
      };
      const manifests = proofs?.manifests.get(storageKey(key)) ?? [];
      if (manifests.length > 1) throw new Error("Conflicting analytics delivery receipts");
      const receipt = manifests[0];
      const expected = proofs?.receipts.get(effectKey(key)) ?? [];
      if (
        receipt?.stages.includes(effect.stage) &&
        !expected.some((row) => row.effect_hash === hash)
      )
        throw new Error(
          "Analytics delivery receipt forbids adding or changing effects in a closed stage",
        );
      if (expected.some((row) => row.outcome === "fenced"))
        throw new Error("Ordinary receipt publication cannot restore a fenced effect");
      if (expected.some((row) => row.effect_hash !== hash))
        throw new Error("Replay changed an existing analytics effect receipt identity");
      for (const row of proofs?.journal.get(effectKey(key)) ?? [])
        if (row.effect_hash !== hash)
          throw new Error("Replay changed an existing analytics effect identity");
      const owner = effect.after?.userId ?? effect.before?.userId;
      if (!owner) throw new Error("Analytics effect account ownership is missing");
      rows.push({
        ...receiptValues(effect.position),
        preparation_attempt: preparationAttempt,
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
        preparation_attempt: preparationAttempt,
        effect_ordinal: effect.cursor.effectOrdinal,
        stage: effect.stage,
        effect_hash: hash,
        is_empty: 0,
        outcome: expected[0]?.outcome === "generation_filtered" ? "generation_filtered" : outcome,
        user_id: owner,
      });
    }
  }
  if (rows.length) {
    if (phase !== "commit" && phase !== "commitFresh")
      await client.insert({
        table: "analytics.effect_journal",
        format: "JSONEachRow",
        values: rows,
        clickhouse_settings: { async_insert: 0 },
      });
    if (phase !== "prepare" && phase !== "prepareFresh")
      await client.insert({
        table: "analytics.effect_receipt",
        format: "JSONEachRow",
        values: receipts,
        clickhouse_settings: { async_insert: 0 },
      });
  }
}

/** Application outcomes are structural proof only; the manifest commits the whole delivery. */
export async function recordAnalyticsEffectOutcomes(
  client: ClickHouseClient,
  effects: readonly AnalyticsEffect[],
  outcome: "written" | "generation_filtered",
): Promise<void> {
  z.enum(["written", "generation_filtered"]).parse(outcome);
  if (!effects.length) return;
  z.number().int().max(500).parse(effects.length);
  const selected = selectKeys([
    ...new Map(
      effects.map((effect) => {
        const key = deliveryParams(effect.position);
        return [storageKey(key), key] as const;
      }),
    ).values(),
  ]);
  const response = await client.query({
    query: `SELECT ${selected.columns},preparation_attempt,serialized_message_id,effect_count,chunk_count,effect_digest,stages
      FROM analytics.delivery_receipt FINAL WHERE ${selected.where} AND status='prepared'
      LIMIT 2 BY ${selected.columns}`,
    query_params: selected.params,
    format: "JSONEachRow",
    clickhouse_settings: integerSettings,
  });
  const manifests = indexProofRows(
    z
      .array(storageKeySchema.merge(receiptSchema))
      .max(effects.length * 2)
      .parse(await response.json()),
    new Set(effects.map((effect) => storageKey(deliveryParams(effect.position)))),
    storageKey,
  );
  const attempts = new Map<string, AnalyticsEffect[]>();
  for (const effect of effects) {
    const rows = manifests.get(storageKey(deliveryParams(effect.position))) ?? [];
    if (rows.length !== 1 || !rows[0])
      throw new Error("Application outcome has no exact prepared manifest");
    const attempt = rows[0].preparation_attempt;
    const page = attempts.get(attempt) ?? [];
    page.push(effect);
    attempts.set(attempt, page);
  }
  for (const [attempt, page] of attempts)
    await persistAnalyticsEffectPage(client, page, "commit", attempt, outcome);
}

const journalRowSchema = z.object({
  preparation_attempt: z.uuid(),
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

async function* readSourceReferences(
  client: ClickHouseClient,
  position: MetricStreamPosition,
  preparationAttempt: string,
) {
  let afterOrdinal = "-1";
  for (;;) {
    const result = await client.query({
      query: `SELECT * FROM (
        (SELECT epoch,topic,partition,transport,kafka_offset,major,minor,batch,preparation_attempt,effect_ordinal,stage,effect_hash,0 AS is_empty,user_id,'written' AS outcome
        FROM analytics.effect_journal AS intent FINAL WHERE ${deliveryWhere}
          AND preparation_attempt={preparationAttempt:UUID} AND stage='scalar'
          AND intent.effect_ordinal>{afterOrdinal:Int128}
        ORDER BY intent.effect_ordinal LIMIT {limit:UInt32})
        UNION ALL
        (SELECT epoch,topic,partition,transport,kafka_offset,major,minor,batch,preparation_attempt,effect_ordinal,stage,effect_hash,is_empty,user_id,toString(outcome) AS outcome
        FROM analytics.effect_receipt AS reference FINAL WHERE ${deliveryWhere}
          AND preparation_attempt={preparationAttempt:UUID} AND stage='scalar' AND reference.outcome='fenced'
          AND reference.effect_ordinal>{afterOrdinal:Int128}
        ORDER BY reference.effect_ordinal LIMIT {limit:UInt32})
      ) ORDER BY effect_ordinal LIMIT {combinedLimit:UInt32}`,
      query_params: {
        ...deliveryParams(position),
        preparationAttempt,
        afterOrdinal,
        limit: RECEIPT_PAGE_SIZE,
        combinedLimit: RECEIPT_PAGE_SIZE * 2,
      },
      format: "JSONEachRow",
      clickhouse_settings: integerSettings,
    });
    const candidates = z
      .array(discoveryReceiptSchema)
      .max(RECEIPT_PAGE_SIZE * 2)
      .parse(await result.json());
    const merged = new Map<string, DiscoveryReceipt>();
    for (const candidate of candidates) {
      const previous = merged.get(candidate.effect_ordinal);
      if (previous) {
        if (
          previous.effect_hash !== candidate.effect_hash ||
          previous.outcome === candidate.outcome
        )
          throw new Error("Prepared structural references disagree on an effect identity");
        if (candidate.outcome === "fenced") merged.set(candidate.effect_ordinal, candidate);
      } else merged.set(candidate.effect_ordinal, candidate);
    }
    const refs = [...merged.values()]
      .sort((left, right) => (BigInt(left.effect_ordinal) < BigInt(right.effect_ordinal) ? -1 : 1))
      .slice(0, RECEIPT_PAGE_SIZE);
    if (!refs.length) return;
    const resolved = await readReferencedEffects(client, refs);
    for (const { reference } of resolved) {
      if (BigInt(reference.effect_ordinal) !== BigInt(afterOrdinal) + 1n)
        throw new Error("Prepared intent contains a missing or duplicate ordinal");
      afterOrdinal = reference.effect_ordinal;
    }
    yield resolved;
  }
}

async function* readSourceIntentPages(
  client: ClickHouseClient,
  position: MetricStreamPosition,
  preparationAttempt: string,
) {
  for await (const page of readSourceReferences(client, position, preparationAttempt)) {
    const effects = page.flatMap(({ effect }) => (effect ? [effect] : []));
    for (const effect of effects)
      if (metricStreamPositionIdentity(effect.position) !== metricStreamPositionIdentity(position))
        throw new Error("Prepared intent native message identity changed");
    if (effects.length) yield effects;
  }
}

async function sourceIntentFingerprint(
  client: ClickHouseClient,
  position: MetricStreamPosition,
  preparationAttempt: string,
) {
  const digest = createHash("sha256");
  let count = 0n;
  for await (const page of readSourceReferences(client, position, preparationAttempt))
    for (const { reference } of page) {
      digest.update(reference.effect_hash);
      count++;
    }
  return { effect_count: String(count), effect_digest: digest.digest("hex") };
}

async function verifyPreparation(client: ClickHouseClient, position: MetricStreamPosition) {
  const receipt = await readReceipt(client, position, "prepared");
  if (!receipt)
    throw new Error("Delivery has no complete preparation; resume preparing the original intent");
  const actual = await sourceIntentFingerprint(client, position, receipt.preparation_attempt);
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
 * A complete manifest is replayed as-is; its original source intent is never recalculated.
 */
export async function prepareAnalyticsDelivery(
  client: ClickHouseClient,
  input: {
    position: MetricStreamPosition;
    preparation: "deterministic" | "control";
    pages(): AsyncIterable<readonly AnalyticsEffect[]>;
  },
): Promise<void> {
  metricStreamPositionSchema.parse(input.position);
  if (!client.insert) throw new Error("Analytics preparation requires an insert-capable client");
  if (await readReceipt(client, input.position, "prepared")) {
    await verifyPreparation(client, input.position);
    return;
  }
  if (await readReceipt(client, input.position))
    throw new Error("Cannot prepare an already committed delivery");
  const preparationAttempt =
    input.preparation === "control" ? randomUUID() : DETERMINISTIC_PREPARATION_ATTEMPT;
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
    await persistAnalyticsEffectPage(client, effects, "prepare", preparationAttempt, "written");
  }
  const expected = { effect_count: String(count), effect_digest: digest.digest("hex") };
  const actual = await sourceIntentFingerprint(client, input.position, preparationAttempt);
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
        preparation_attempt: preparationAttempt,
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
  const prepared = await verifyPreparation(client, position);
  yield* readSourceIntentPages(client, position, prepared.preparation_attempt);
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
  for await (const page of readSourceIntentPages(client, position, prepared.preparation_attempt))
    await persistAnalyticsEffectPage(
      client,
      page,
      "commit",
      prepared.preparation_attempt,
      "written",
    );
  if (prepared.effect_count === "0")
    await client.insert({
      table: "analytics.effect_receipt",
      format: "JSONEachRow",
      values: [
        {
          ...receiptValues(position),
          preparation_attempt: prepared.preparation_attempt,
          outcome: "written",
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

export async function readReferencedEffects(
  client: Pick<ClickHouseClient, "query">,
  receipts: readonly DiscoveryReceipt[],
): Promise<{ reference: DiscoveryReceipt; effect: AnalyticsEffect | null }[]> {
  z.number().int().max(500).parse(receipts.length);
  const nonempty: EffectKey[] = [];
  for (const receipt of receipts) {
    if (receipt.outcome === "fenced") {
      if (receipt.user_id !== null || receipt.is_empty !== 0 || receipt.effect_ordinal === "-1")
        throw new Error("Malformed fenced structural receipt");
      continue;
    }
    if (receipt.is_empty) {
      if (receipt.effect_ordinal !== "-1" || receipt.effect_hash !== EMPTY_DIGEST)
        throw new Error("Malformed empty analytics discovery receipt");
    } else {
      if (receipt.effect_ordinal === "-1")
        throw new Error("Negative ordinal cannot identify an analytics effect");
      nonempty.push(effectKeySchema.parse(receipt));
    }
  }
  let indexed = new Map<string, z.infer<typeof journalRowSchema>[]>();
  if (nonempty.length) {
    const expected = new Set(nonempty.map(effectKey));
    if (expected.size !== nonempty.length)
      throw new Error("Duplicate analytics discovery reference identity");
    const selected = selectKeys(nonempty);
    const result = await client.query({
      query: `SELECT * FROM analytics.effect_journal FINAL WHERE ${selected.where} LIMIT 2 BY ${selected.columns}`,
      query_params: selected.params,
      format: "JSONEachRow",
      clickhouse_settings: integerSettings,
    });
    const rows = z
      .array(journalRowSchema)
      .max(nonempty.length * 2)
      .parse(await result.json());
    indexed = indexProofRows(rows, expected, effectKey);
  }
  return receipts.map((receipt) => {
    if (receipt.is_empty || receipt.outcome === "fenced")
      return { reference: receipt, effect: null };
    const rows = indexed.get(effectKey(effectKeySchema.parse(receipt))) ?? [];
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
    return { reference: receipt, effect };
  });
}

async function verifyAnalyticsDeliveryReceipt(
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
      query: `SELECT * FROM analytics.effect_receipt FINAL WHERE ${deliveryWhere} AND preparation_attempt={preparationAttempt:UUID} AND stage IN {stages:Array(String)} AND (effect_ordinal>{afterOrdinal:Int128} OR (effect_ordinal={afterOrdinal:Int128} AND toInt8(stage)>{afterStage:Int8})) ORDER BY effect_ordinal,stage LIMIT {limit:UInt32}`,
      query_params: {
        ...deliveryParams(position),
        preparationAttempt: receipt.preparation_attempt,
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
    if (chunkCount + BigInt(refs.length) > BigInt(receipt.chunk_count))
      throw new Error("Analytics delivery receipt has unexpected effect references");
    const effects = await readReferencedEffects(client, refs);
    for (const [index, reference] of refs.entries()) {
      chunkCount++;
      const resolved = effects[index];
      if (resolved && !resolved.reference.is_empty) {
        effectCount++;
        digest.update(resolved.reference.effect_hash);
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
