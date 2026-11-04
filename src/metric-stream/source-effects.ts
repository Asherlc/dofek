import { createHash } from "node:crypto";
import { z } from "zod";
import type { AnalyticsQueryOwner } from "../analytics/analytics-query-owner.ts";
import type { AnalyticsEffect } from "../analytics/effect-journal.ts";
import { journalDeliveryKey } from "../analytics/journal-position.ts";
import { resolveSourcePlacements, type SourcePlacement } from "../analytics/source-placement.ts";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { mapMetricStreamEventToClickHouseRow } from "./clickhouse-row.ts";
import {
  ACCOUNT_ERASURE_FENCE_TABLE,
  METRIC_STREAM_DELETE_SCOPE_TABLE,
  METRIC_STREAM_TABLE,
  PROVIDER_DATA_GENERATION_TABLE,
} from "./clickhouse-table.ts";
import {
  isMetricStreamBatchCompletedEvent,
  isMetricStreamDeletedEvent,
  type MetricStreamDeleteScope,
  type MetricStreamRedpandaEvent,
} from "./events.ts";
import type { MetricStreamPosition } from "./transport-position.ts";

function effect(
  position: MetricStreamPosition,
  ordinal: number,
  before: SourcePlacement | null,
  after: SourcePlacement,
): AnalyticsEffect {
  return {
    stream: {
      transport: position.transport,
      epoch: position.epoch,
      topic: position.topic,
      partition: position.partition,
    },
    position,
    cursor: { delivery: journalDeliveryKey(position), effectOrdinal: String(ordinal) },
    stage: "scalar",
    operationId: null,
    sourceId: after.sourceId,
    sourceVersion: after.sourceVersion,
    generation: after.generation,
    before,
    after,
  };
}

async function accountErased(client: ClickHouseClient, userId: string) {
  const result = await client.query({
    query: `SELECT user_hash FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL WHERE user_hash={hash:String} LIMIT 1`,
    query_params: { hash: createHash("sha256").update(userId).digest("hex") },
    format: "JSONEachRow",
    clickhouse_settings: { log_queries: 0 },
  });
  return z.array(z.object({ user_hash: z.string() })).parse(await result.json()).length > 0;
}

function scopePredicate(scope: MetricStreamDeleteScope, params: Record<string, unknown>) {
  const predicates: string[] = [];
  for (const [field, column, type] of [
    ["userId", "user_id", "UUID"],
    ["providerId", "provider_id", "String"],
    ["activityId", "activity_id", "UUID"],
    ["channel", "channel", "String"],
  ] as const)
    if (scope[field]) {
      params[field] = scope[field];
      predicates.push(`${column}={${field}:${type}}`);
    }
  if (scope.externalId === null) predicates.push("external_id IS NULL");
  else if (scope.externalId !== undefined) {
    params.externalId = scope.externalId;
    predicates.push("external_id={externalId:String}");
  }
  if (scope.recordedAtStart) {
    params.recordedAtStart = scope.recordedAtStart;
    predicates.push("recorded_at>=parseDateTime64BestEffort({recordedAtStart:String},6)");
  }
  if (scope.recordedAtEnd) {
    params.recordedAtEnd = scope.recordedAtEnd;
    predicates.push("recorded_at<parseDateTime64BestEffort({recordedAtEnd:String},6)");
  }
  if (!predicates.length) throw new Error("Metric-stream delete scope has no conditions");
  return predicates.join(" AND ");
}

export async function* prepareMetricStreamSourceEffects(
  owner: AnalyticsQueryOwner,
  event: MetricStreamRedpandaEvent,
  position: MetricStreamPosition,
): AsyncGenerator<readonly AnalyticsEffect[]> {
  const client = owner.client;
  if (isMetricStreamBatchCompletedEvent(event)) return;
  if (!isMetricStreamDeletedEvent(event)) {
    if (event.channel === "imu") return;
    const before = (await resolveSourcePlacements(client, [event.id]))[0] ?? null;
    if (before && before.userId !== event.userId)
      throw new Error(`Source ${event.id} has conflicting account owners`);
    if (await accountErased(client, event.userId)) return;
    const row = mapMetricStreamEventToClickHouseRow(event, owner.ingestedAt);
    if (before && BigInt(before.sourceVersion) > BigInt(row.version)) return;
    const generation = await client.query({
      query: `SELECT toString(max(generation)) AS generation,
        concat(replaceOne(toString(parseDateTime64BestEffort({recorded:String},6)),' ','T'),'Z') AS recorded_at
        FROM ${PROVIDER_DATA_GENERATION_TABLE} WHERE user_id={user:UUID} AND provider_id={provider:String}`,
      query_params: { user: event.userId, provider: event.providerId, recorded: event.recordedAt },
      format: "JSONEachRow",
    });
    const source = z
      .tuple([z.object({ generation: z.string().regex(/^\d+$/), recorded_at: z.string() })])
      .parse(await generation.json())[0];
    const guards = await client.query({
      query: `SELECT toString(max(operation_revision*2)) AS version FROM ${METRIC_STREAM_DELETE_SCOPE_TABLE} FINAL
        WHERE (user_id IS NULL OR user_id={user:UUID}) AND (provider_id IS NULL OR provider_id={provider:String})
          AND (activity_id IS NULL OR activity_id={activity:Nullable(UUID)})
          AND (channel IS NULL OR channel={channel:String})
          AND (external_id_set=0 OR isNotDistinctFrom(external_id,{external:Nullable(String)}))
          AND (recorded_at_start IS NULL OR recorded_at_start<=parseDateTime64BestEffort({recorded:String},6))
          AND (recorded_at_end IS NULL OR recorded_at_end>parseDateTime64BestEffort({recorded:String},6))`,
      query_params: {
        user: event.userId,
        provider: event.providerId,
        activity: event.activityId ?? null,
        channel: event.channel,
        external: event.externalId ?? null,
        recorded: event.recordedAt,
      },
      format: "JSONEachRow",
    });
    const guard = z
      .tuple([z.object({ version: z.string().regex(/^\d+$/) })])
      .parse(await guards.json())[0].version;
    const staleGeneration = BigInt(event.generation) < BigInt(source.generation);
    let version = BigInt(row.version);
    if (staleGeneration) version++;
    if (BigInt(guard) > version) version = BigInt(guard);
    const after: SourcePlacement = {
      sourceId: event.id,
      userId: event.userId,
      providerId: event.providerId,
      sourceVersion: String(version),
      generation: String(event.generation),
      key: {
        userId: event.userId,
        channel: event.channel,
        recordedAt: source.recorded_at,
      },
      activityId: event.activityId ?? null,
      deleted: staleGeneration || BigInt(guard) > BigInt(row.version),
    };
    yield [effect(position, 0, before, after)];
    return;
  }
  let cursor: string | null = null;
  let ordinal = 0;
  for (;;) {
    const params: Record<string, unknown> = { cursor };
    const predicate = scopePredicate(event.scope, params);
    const result = await client.query({
      query: `SELECT id FROM ${METRIC_STREAM_TABLE} WHERE ${predicate} ${cursor ? "AND id>{cursor:UUID}" : ""} GROUP BY id ORDER BY id LIMIT 20`,
      query_params: params,
      format: "JSONEachRow",
    });
    const ids: string[] = z
      .array(z.object({ id: z.uuid() }))
      .parse(await result.json())
      .map((row) => row.id);
    if (!ids.length) return;
    const placements = await resolveSourcePlacements(client, ids);
    if (placements.length !== ids.length)
      throw new Error(
        "Source placement index is incomplete; finish the protected bounded bootstrap before source mutation",
      );
    const matchingResult = await client.query({
      query: `SELECT id FROM (SELECT id,latest.1 AS user_id,latest.2 AS provider_id,
          latest.3 AS activity_id,latest.4 AS channel,latest.5 AS recorded_at,latest.6 AS external_id
        FROM (SELECT id,argMax(tuple(user_id,provider_id,activity_id,channel,recorded_at,external_id),tuple(version,ingested_at)) AS latest
          FROM ${METRIC_STREAM_TABLE} WHERE id IN {ids:Array(UUID)} GROUP BY id))
        WHERE ${predicate}`,
      query_params: { ...params, ids },
      format: "JSONEachRow",
    });
    const matchingIds = new Set(
      z
        .array(z.object({ id: z.uuid() }))
        .parse(await matchingResult.json())
        .map((row) => row.id),
    );
    const page: AnalyticsEffect[] = [];
    for (const before of placements) {
      if (
        before.deleted ||
        !matchingIds.has(before.sourceId) ||
        (await accountErased(client, before.userId))
      )
        continue;
      const version =
        "operationRevision" in event
          ? BigInt(event.operationRevision) * 2n
          : BigInt(before.sourceVersion) + 1n;
      if (version < BigInt(before.sourceVersion)) continue;
      page.push(
        effect(position, ordinal++, before, {
          ...before,
          sourceVersion: String(version),
          deleted: true,
        }),
      );
    }
    if (page.length) yield page;
    cursor = ids.at(-1) ?? null;
  }
}

export async function applyMetricStreamSourceEffects(
  owner: AnalyticsQueryOwner,
  event: MetricStreamRedpandaEvent,
  effects: readonly AnalyticsEffect[],
): Promise<number> {
  if (!effects.length) return 0;
  if (!isMetricStreamDeletedEvent(event) && !isMetricStreamBatchCompletedEvent(event)) {
    const after = effects[0]?.after;
    if (!after) throw new Error("Prepared source insert has no terminal placement");
    const row = {
      ...mapMetricStreamEventToClickHouseRow(event, owner.ingestedAt),
      version: after.sourceVersion,
      is_deleted: after.deleted ? 1 : 0,
    };
    await owner.client.command({
      query: `INSERT INTO ${METRIC_STREAM_TABLE} (id,activity_id,user_id,recorded_at,channel,provider_id,external_id,device_id,source_type,scalar,vector,point,metadata,ingested_at,is_deleted,version,generation)
        SELECT {id:UUID},{activity:Nullable(UUID)},{user:UUID},parseDateTime64BestEffort({recorded:String},6),{channel:String},{provider:String},
          {external:Nullable(String)},{device:Nullable(String)},{sourceType:String},{scalar:Nullable(Float32)},{vector:Array(Float32)},{point:String},{metadata:String},
          parseDateTime64BestEffort({ingested:String},9),{deleted:Int8},{version:Int64},{generation:UInt64}
        WHERE lower(hex(SHA256(toString({user:UUID})))) NOT IN (SELECT user_hash FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL)`,
      query_params: {
        id: row.id,
        activity: row.activity_id,
        user: row.user_id,
        recorded: row.recorded_at,
        channel: row.channel,
        provider: row.provider_id,
        external: row.external_id,
        device: row.device_id,
        sourceType: row.source_type,
        scalar: row.scalar,
        vector: row.vector,
        point: row.point ?? "",
        metadata: row.metadata,
        ingested: owner.ingestedAt,
        deleted: row.is_deleted,
        version: String(row.version),
        generation: row.generation,
      },
    });
    return after.deleted ? 0 : 1;
  }
  const placements = effects.map((effect) => {
    if (!effect.after?.deleted) throw new Error("Prepared deletion has no terminal tombstone");
    return effect.after;
  });
  await owner.client.command({
    query: `INSERT INTO ${METRIC_STREAM_TABLE} (id,activity_id,user_id,recorded_at,channel,provider_id,external_id,device_id,source_type,scalar,vector,point,metadata,ingested_at,is_deleted,version,generation)
      SELECT source.id,latest.1,latest.2,latest.3,latest.4,latest.5,latest.6,latest.7,latest.8,latest.9,latest.10,latest.11,latest.12,
        parseDateTime64BestEffort({ingested:String},9),1,intent.version,latest.13
      FROM (SELECT id,argMax(tuple(activity_id,user_id,recorded_at,channel,provider_id,external_id,device_id,source_type,scalar,vector,point,metadata,generation),tuple(version,ingested_at)) AS latest
        FROM ${METRIC_STREAM_TABLE} WHERE id IN {ids:Array(UUID)} GROUP BY id) AS source
      INNER JOIN (SELECT pair.1 AS id,toInt64(pair.2) AS version FROM (SELECT arrayJoin(arrayZip({ids:Array(UUID)},{versions:Array(String)})) AS pair)) AS intent ON source.id=intent.id
      WHERE lower(hex(SHA256(toString(latest.2)))) NOT IN (SELECT user_hash FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL)`,
    query_params: {
      ids: placements.map((value) => value.sourceId),
      versions: placements.map((value) => value.sourceVersion),
      ingested: owner.ingestedAt,
    },
  });
  return 0;
}
