import { createHash } from "node:crypto";
import { z } from "zod";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import {
  type MetricStreamPosition,
  metricStreamPositionSchema,
} from "../metric-stream/transport-position.ts";
import {
  type AnalyticsDeliveryGroup,
  describeAnalyticsDeliveryGroup,
} from "./analytics-delivery-group.ts";
import {
  type AnalyticsEffect,
  commitPreparedAnalyticsDelivery,
  type DiscoveryReceipt,
  deliveryParams,
  discoveryReceiptSchema,
  EMPTY_DIGEST,
  effectHash,
  indexProofRows,
  integerSettings,
  persistAnalyticsEffectPage,
  prepareAnalyticsDelivery,
  RECEIPT_PAGE_SIZE,
  readPreparedAnalyticsEffectPages,
  readReferencedEffects,
  receiptSchema,
  receiptValues,
  selectKeys,
  stageOrder,
  storageKey,
  storageKeySchema,
  validateEffectBatch,
} from "./effect-journal.ts";
import { metricStreamPositionIdentity } from "./journal-position.ts";

export async function verifyAnalyticsDeliveryReceipts(
  client: Pick<ClickHouseClient, "query">,
  positions: readonly MetricStreamPosition[],
): Promise<void> {
  describeAnalyticsDeliveryGroup(positions, 500);
  const keys = positions.map(deliveryParams);
  const selected = selectKeys(keys);
  const expected = new Map(
    positions.map((position) => [storageKey(deliveryParams(position)), position]),
  );
  const result = await client.query({
    query: `SELECT ${selected.columns},serialized_message_id,effect_count,chunk_count,effect_digest,stages
      FROM analytics.delivery_receipt FINAL WHERE ${selected.where} AND status='committed'
      LIMIT 2 BY ${selected.columns}`,
    query_params: selected.params,
    format: "JSONEachRow",
    clickhouse_settings: integerSettings,
  });
  const manifests = indexProofRows(
    z
      .array(storageKeySchema.merge(receiptSchema))
      .max(positions.length * 2)
      .parse(await result.json()),
    new Set(expected.keys()),
    storageKey,
  );
  const state = new Map<
    string,
    {
      receipt: z.infer<typeof receiptSchema>;
      digest: ReturnType<typeof createHash>;
      effectCount: bigint;
      chunkCount: bigint;
    }
  >();
  for (const [key, position] of expected) {
    const rows = manifests.get(key) ?? [];
    const receipt = rows[0];
    if (
      rows.length !== 1 ||
      !receipt ||
      receipt.serialized_message_id !==
        (position.transport === "pulsar" ? position.serializedMessageId : "")
    )
      throw new Error("Durable analytics delivery receipt is missing or mismatched");
    state.set(key, { receipt, digest: createHash("sha256"), effectCount: 0n, chunkCount: 0n });
  }
  const simpleGroup = [...state.values()].every(
    ({ receipt }) =>
      receipt.chunk_count === "1" &&
      (receipt.effect_count === "0" || receipt.effect_count === "1") &&
      receipt.stages.length === 1 &&
      receipt.stages[0] === "scalar",
  );
  const referenceLimit = simpleGroup ? positions.length : RECEIPT_PAGE_SIZE;
  let after: DiscoveryReceipt | undefined;
  for (;;) {
    const page = await client.query({
      query: `SELECT * FROM analytics.effect_receipt FINAL WHERE ${selected.where}
        ${after ? "AND (kafka_offset,major,minor,batch,effect_ordinal,toInt8(stage)) > ({afterOffset:UInt64},{afterMajor:UInt64},{afterMinor:UInt64},{afterBatch:Int32},{afterOrdinal:Int128},{afterStage:Int8})" : ""}
        ORDER BY kafka_offset,major,minor,batch,effect_ordinal,stage LIMIT {limit:UInt32}`,
      query_params: {
        ...selected.params,
        limit: simpleGroup ? referenceLimit + 1 : referenceLimit,
        ...(after
          ? {
              afterOffset: after.kafka_offset,
              afterMajor: after.major,
              afterMinor: after.minor,
              afterBatch: after.batch,
              afterOrdinal: after.effect_ordinal,
              afterStage: stageOrder[after.stage],
            }
          : {}),
      },
      format: "JSONEachRow",
      clickhouse_settings: integerSettings,
    });
    const refs = z
      .array(discoveryReceiptSchema)
      .max(referenceLimit)
      .parse(await page.json());
    if (!refs.length) break;
    const effects = await readReferencedEffects(client, refs);
    for (const [index, ref] of refs.entries()) {
      const member = state.get(storageKey(ref));
      if (!member?.receipt.stages.includes(ref.stage))
        throw new Error("Unexpected delivery or stage in grouped analytics receipt proof");
      member.chunkCount++;
      if (member.chunkCount > BigInt(member.receipt.chunk_count))
        throw new Error("Analytics delivery receipt has unexpected effect references");
      const effect = effects[index];
      if (effect) {
        member.effectCount++;
        member.digest.update(effectHash(effect));
      }
      after = ref;
    }
    if (simpleGroup) break;
  }
  for (const member of state.values()) {
    if (
      member.effectCount !== BigInt(member.receipt.effect_count) ||
      member.chunkCount !== BigInt(member.receipt.chunk_count) ||
      member.digest.digest("hex") !== member.receipt.effect_digest
    )
      throw new Error(
        "Analytics delivery receipt is incomplete: durable effect identities do not match",
      );
  }
}

export interface PreparedAnalyticsDeliveryGroup {
  positions: readonly MetricStreamPosition[];
  effects: readonly AnalyticsEffect[];
  fresh: boolean;
}

export async function readAnalyticsDeliveryGroupPositions(
  client: Pick<ClickHouseClient, "query">,
  group: AnalyticsDeliveryGroup,
): Promise<readonly MetricStreamPosition[]> {
  z.number().int().min(1).max(500).parse(group.memberCount);
  const first = deliveryParams(group.first),
    last = deliveryParams(group.last);
  const result = await client.query({
    query: `SELECT epoch,topic,partition,transport,kafka_offset,major,minor,batch,serialized_message_id
      FROM analytics.delivery_receipt FINAL
      WHERE epoch={epoch:String} AND topic={topic:String} AND partition={partition:Int32} AND transport={transport:String}
        AND status='committed'
        AND (kafka_offset,major,minor,batch)>=({kafka_offset:UInt64},{major:UInt64},{minor:UInt64},{batch:Int32})
        AND (kafka_offset,major,minor,batch)<=({lastOffset:UInt64},{lastMajor:UInt64},{lastMinor:UInt64},{lastBatch:Int32})
      ORDER BY kafka_offset,major,minor,batch LIMIT {limit:UInt32}`,
    query_params: {
      ...first,
      lastOffset: last.kafka_offset,
      lastMajor: last.major,
      lastMinor: last.minor,
      lastBatch: last.batch,
      limit: group.memberCount + 1,
    },
    format: "JSONEachRow",
    clickhouse_settings: integerSettings,
  });
  const rows = z
    .array(storageKeySchema.extend({ serialized_message_id: z.string() }))
    .max(group.memberCount + 1)
    .parse(await result.json());
  const positions = rows.map((row) =>
    metricStreamPositionSchema.parse(
      row.transport === "kafka"
        ? { ...group.stream, transport: "kafka", offset: row.kafka_offset }
        : {
            ...group.stream,
            transport: "pulsar",
            serializedMessageId: row.serialized_message_id,
            delivery: { major: row.major, minor: row.minor, batch: row.batch },
          },
    ),
  );
  if (
    positions.length !== group.memberCount ||
    describeAnalyticsDeliveryGroup(positions, 500).positionsDigest !== group.positionsDigest
  )
    throw new Error("Completed group membership does not match its retained digest and count");
  return positions;
}

export async function prepareAnalyticsDeliveryGroup(
  client: ClickHouseClient,
  input: {
    positions: readonly MetricStreamPosition[];
    maximum: number;
    wasPending: boolean;
    prepare(): Promise<readonly AnalyticsEffect[]>;
  },
): Promise<PreparedAnalyticsDeliveryGroup> {
  describeAnalyticsDeliveryGroup(input.positions, input.maximum);
  if (!client.insert) throw new Error("Grouped preparation requires an insert-capable client");
  const selected = selectKeys(input.positions.map(deliveryParams));
  const probe = await client.query({
    query: `SELECT count()>0 AS present FROM (
      (SELECT 1 FROM analytics.effect_journal WHERE ${selected.where} LIMIT 1)
      UNION ALL (SELECT 1 FROM analytics.effect_receipt WHERE ${selected.where} LIMIT 1)
      UNION ALL (SELECT 1 FROM analytics.delivery_receipt WHERE ${selected.where} LIMIT 1))`,
    query_params: selected.params,
    format: "JSONEachRow",
    clickhouse_settings: integerSettings,
  });
  const [{ present }] = z
    .tuple([z.object({ present: z.number().int().min(0).max(1) })])
    .parse(await probe.json());
  const fresh = !input.wasPending && present === 0;
  let generated: readonly AnalyticsEffect[] | undefined;
  const generate = async () => {
    if (generated) return generated;
    const effects = validateEffectBatch(await input.prepare());
    const members = new Map(
      input.positions.map((position) => [storageKey(deliveryParams(position)), position]),
    );
    if (effects.length > members.size)
      throw new Error("Grouped row preparation has more effects than input deliveries");
    for (const effect of effects) {
      const position = members.get(storageKey(deliveryParams(effect.position)));
      if (
        !position ||
        metricStreamPositionIdentity(position) !== metricStreamPositionIdentity(effect.position) ||
        effect.stage !== "scalar" ||
        effect.cursor.effectOrdinal !== "0"
      )
        throw new Error(
          "Grouped row preparation requires one scalar ordinal zero per exact input delivery",
        );
    }
    generated = effects;
    return effects;
  };
  if (!fresh) {
    const effects: AnalyticsEffect[] = [];
    for (const position of input.positions) {
      await prepareAnalyticsDelivery(client, {
        position,
        pages: async function* () {
          const key = storageKey(deliveryParams(position));
          const page = (await generate()).filter(
            (effect) => storageKey(deliveryParams(effect.position)) === key,
          );
          if (page.length) yield page;
        },
      });
      for await (const page of readPreparedAnalyticsEffectPages(client, position)) {
        if (page.length > 1 || effects.length + page.length > input.positions.length)
          throw new Error("Grouped row replay contains an unexpected multi-effect delivery");
        effects.push(...page);
      }
    }
    return { positions: input.positions, effects, fresh: false };
  }
  const effects = await generate();
  await persistAnalyticsEffectPage(client, effects, "prepareFresh");
  await client.insert({
    table: "analytics.delivery_receipt",
    format: "JSONEachRow",
    values: groupManifestRows(input.positions, effects, "prepared"),
    clickhouse_settings: { async_insert: 0 },
  });
  return { positions: input.positions, effects, fresh: true };
}

export async function commitAnalyticsDeliveryGroup(
  client: ClickHouseClient,
  prepared: PreparedAnalyticsDeliveryGroup,
): Promise<void> {
  if (!client.insert) throw new Error("Grouped commit requires an insert-capable client");
  if (!prepared.fresh) {
    for (const position of prepared.positions)
      await commitPreparedAnalyticsDelivery(client, position);
    return;
  }
  await persistAnalyticsEffectPage(client, prepared.effects, "commitFresh");
  const nonempty = new Set(
    prepared.effects.map((effect) => storageKey(deliveryParams(effect.position))),
  );
  const empty = prepared.positions.filter(
    (position) => !nonempty.has(storageKey(deliveryParams(position))),
  );
  if (empty.length)
    await client.insert({
      table: "analytics.effect_receipt",
      format: "JSONEachRow",
      values: empty.map((position) => ({
        ...receiptValues(position),
        effect_ordinal: "-1",
        stage: "scalar",
        effect_hash: EMPTY_DIGEST,
        is_empty: 1,
        user_id: null,
      })),
      clickhouse_settings: { async_insert: 0 },
    });
  await client.insert({
    table: "analytics.delivery_receipt",
    format: "JSONEachRow",
    values: groupManifestRows(prepared.positions, prepared.effects, "committed"),
    clickhouse_settings: { async_insert: 0 },
  });
}

function groupManifestRows(
  positions: readonly MetricStreamPosition[],
  effects: readonly AnalyticsEffect[],
  status: "prepared" | "committed",
) {
  const indexed = new Map(
    effects.map((effect) => [storageKey(deliveryParams(effect.position)), effect]),
  );
  return positions.map((position) => {
    const effect = indexed.get(storageKey(deliveryParams(position)));
    return {
      ...receiptValues(position),
      serialized_message_id: position.transport === "pulsar" ? position.serializedMessageId : "",
      effect_count: effect ? "1" : "0",
      chunk_count: "1",
      effect_digest: effect
        ? createHash("sha256").update(effectHash(effect)).digest("hex")
        : EMPTY_DIGEST,
      stages: ["scalar"],
      status,
    };
  });
}
