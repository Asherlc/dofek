import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { TupleParam } from "@clickhouse/client";
import { z } from "zod";
import type { AnalyticsQueryOwner } from "../analytics/analytics-query-owner.ts";
import type { AnalyticsEffect } from "../analytics/effect-journal.ts";
import { journalDeliveryKey, metricStreamPositionIdentity } from "../analytics/journal-position.ts";
import { resolveSourcePlacements, type SourcePlacement } from "../analytics/source-placement.ts";
import { mapMetricStreamEventToClickHouseRow } from "./clickhouse-row.ts";
import {
  ACCOUNT_ERASURE_FENCE_TABLE,
  METRIC_STREAM_DELETE_SCOPE_TABLE,
  METRIC_STREAM_TABLE,
  PROVIDER_DATA_GENERATION_TABLE,
} from "./clickhouse-table.ts";
import {
  type MetricStreamEventV1,
  type MetricStreamEventV2,
  metricStreamEventV1Schema,
  metricStreamEventV2Schema,
} from "./events.ts";
import { metricStreamSourceEffect } from "./source-effects.ts";
import {
  compareMetricStreamPositions,
  type MetricStreamPosition,
  metricStreamPositionSchema,
} from "./transport-position.ts";

export interface MetricStreamSourceEffectsGroupInput {
  event: MetricStreamEventV1 | MetricStreamEventV2;
  position: MetricStreamPosition;
  ingestedAt: string;
}

const groupInputSchema = z
  .array(
    z.object({
      event: z.union([metricStreamEventV1Schema, metricStreamEventV2Schema]),
      position: metricStreamPositionSchema,
      ingestedAt: z.string().min(1),
    }),
  )
  .max(500);
const unsigned = z.string().regex(/^\d+$/);
const sourcePolicySchema = z.object({
  source_id: z.uuid(),
  generation: unsigned,
  recorded_at: z.string(),
});
const deletePolicySchema = z.object({ source_id: z.uuid(), version: unsigned });
const identity = (id: string) => id.toLowerCase();
const userHash = (userId: string) => createHash("sha256").update(identity(userId)).digest("hex");

function validateGroup(inputs: readonly MetricStreamSourceEffectsGroupInput[]) {
  const parsed = groupInputSchema.parse(inputs);
  const seen = new Set<string>();
  for (const [index, input] of parsed.entries()) {
    const id = identity(input.event.id);
    if (seen.has(id)) throw new Error("Source-effect group requires distinct source UUIDs");
    seen.add(id);
    const previous = parsed[index - 1];
    if (previous && compareMetricStreamPositions(previous.position, input.position) >= 0)
      throw new Error("Source-effect group requires strictly increasing native positions");
  }
  return parsed;
}

function policyParameters(inputs: readonly MetricStreamSourceEffectsGroupInput[]) {
  return {
    ids: inputs.map(({ event }) => event.id),
    users: [...new Set(inputs.map(({ event }) => event.userId))],
    providers: [...new Set(inputs.map(({ event }) => event.providerId))],
    owners: inputs.map(({ event }) => new TupleParam([event.userId, event.providerId])),
    hashes: [...new Set(inputs.map(({ event }) => userHash(event.userId)))],
    rows: inputs.map(
      ({ event }) =>
        new TupleParam([
          event.id,
          event.userId,
          event.providerId,
          event.activityId ?? null,
          event.channel,
          event.externalId ?? null,
          event.recordedAt,
        ]),
    ),
  };
}

const policyInput = `SELECT row.1 AS source_id,row.2 AS user_id,row.3 AS provider_id,
  row.4 AS activity_id,row.5 AS channel,row.6 AS external_id,
  parseDateTime64BestEffort(row.7,6) AS recorded_at
  FROM (SELECT arrayJoin({rows:Array(Tuple(UUID,UUID,String,Nullable(UUID),String,Nullable(String),String))}) AS row)`;

// Constant pairs preserve the same bounded generation lookup used by single-row inserts.
const currentGenerations = `SELECT user_id,provider_id,max(generation) AS current_generation
  FROM ${PROVIDER_DATA_GENERATION_TABLE}
  WHERE (user_id,provider_id) IN {owners:Array(Tuple(UUID,String))} GROUP BY user_id,provider_id`;

export async function prepareMetricStreamSourceEffectsGroup(
  owner: AnalyticsQueryOwner,
  inputs: readonly MetricStreamSourceEffectsGroupInput[],
): Promise<readonly AnalyticsEffect[]> {
  const rows = validateGroup(inputs).filter(({ event }) => event.channel !== "imu");
  if (!rows.length) return [];
  const placements = new Map<string, SourcePlacement>();
  const resolved = await resolveSourcePlacements(
    owner.client,
    rows.map(({ event }) => event.id),
  );
  for (const placement of resolved) placements.set(identity(placement.sourceId), placement);
  for (const { event } of rows) {
    const before = placements.get(identity(event.id));
    if (before && identity(before.userId) !== identity(event.userId))
      throw new Error(`Source ${event.id} has conflicting account owners`);
  }
  const params = policyParameters(rows);
  const accounts = await owner.client.query({
    query: `SELECT user_hash FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL WHERE user_hash IN {hashes:Array(String)}`,
    query_params: { hashes: params.hashes },
    format: "JSONEachRow",
    clickhouse_settings: { log_queries: 0 },
  });
  const erased = new Set(
    z
      .array(z.object({ user_hash: z.string() }))
      .parse(await accounts.json())
      .map((row) => row.user_hash),
  );
  const generationResult = await owner.client.query({
    query: `SELECT incoming.source_id,toString(ifNull(current.current_generation,0)) AS generation,
      concat(replaceOne(toString(incoming.recorded_at),' ','T'),'Z') AS recorded_at
      FROM (${policyInput}) AS incoming LEFT JOIN (${currentGenerations}) AS current
        ON incoming.user_id=current.user_id AND incoming.provider_id=current.provider_id`,
    query_params: params,
    format: "JSONEachRow",
  });
  const generations = new Map(
    z
      .array(sourcePolicySchema)
      .parse(await generationResult.json())
      .map((row) => [identity(row.source_id), row]),
  );
  if (
    generations.size !== rows.length ||
    rows.some(({ event }) => !generations.has(identity(event.id)))
  )
    throw new Error("Grouped generation policy is incomplete");
  const deleteResult = await owner.client.query({
    query: `SELECT incoming.source_id,toString(max(scope.operation_revision*2)) AS version
      FROM (${policyInput}) AS incoming CROSS JOIN
        (SELECT * FROM ${METRIC_STREAM_DELETE_SCOPE_TABLE} FINAL
          WHERE (user_id IS NULL OR user_id IN {users:Array(UUID)})
            AND (provider_id IS NULL OR provider_id IN {providers:Array(String)})) AS scope
      WHERE (scope.user_id IS NULL OR scope.user_id=incoming.user_id)
        AND (scope.provider_id IS NULL OR scope.provider_id=incoming.provider_id)
        AND (scope.activity_id IS NULL OR scope.activity_id=incoming.activity_id)
        AND (scope.channel IS NULL OR scope.channel=incoming.channel)
        AND (scope.external_id_set=0 OR isNotDistinctFrom(scope.external_id,incoming.external_id))
        AND (scope.recorded_at_start IS NULL OR scope.recorded_at_start<=incoming.recorded_at)
        AND (scope.recorded_at_end IS NULL OR scope.recorded_at_end>incoming.recorded_at)
      GROUP BY incoming.source_id`,
    query_params: params,
    format: "JSONEachRow",
  });
  const guards = new Map(
    z
      .array(deletePolicySchema)
      .parse(await deleteResult.json())
      .map((row) => [identity(row.source_id), row.version]),
  );
  const effects: AnalyticsEffect[] = [];
  for (const input of rows) {
    const { event, position } = input;
    const before = placements.get(identity(event.id)) ?? null;
    if (erased.has(userHash(event.userId))) continue;
    const row = mapMetricStreamEventToClickHouseRow(event, input.ingestedAt);
    if (before && BigInt(before.sourceVersion) > BigInt(row.version)) continue;
    const source = generations.get(identity(event.id));
    if (!source) throw new Error("Grouped generation policy is incomplete");
    const guard = BigInt(guards.get(identity(event.id)) ?? "0");
    const staleGeneration = BigInt(event.generation) < BigInt(source.generation);
    let version = BigInt(row.version) + (staleGeneration ? 1n : 0n);
    if (guard > version) version = guard;
    effects.push(
      metricStreamSourceEffect(position, 0n, before, {
        sourceId: event.id,
        userId: event.userId,
        providerId: event.providerId,
        sourceVersion: String(version),
        generation: String(event.generation),
        key: { userId: event.userId, channel: event.channel, recordedAt: source.recorded_at },
        activityId: event.activityId ?? null,
        deleted: staleGeneration || guard > BigInt(row.version),
      }),
    );
  }
  return effects;
}

export async function applyMetricStreamSourceEffectsGroup(
  owner: AnalyticsQueryOwner,
  inputs: readonly MetricStreamSourceEffectsGroupInput[],
  effects: readonly AnalyticsEffect[],
): Promise<number> {
  const validated = validateGroup(inputs);
  const byId = new Map(validated.map((input) => [identity(input.event.id), input]));
  const seen = new Set<string>();
  const rows = effects.map((effect) => {
    const input = byId.get(identity(effect.sourceId));
    const after = effect.after;
    if (
      !input ||
      !after ||
      seen.has(identity(effect.sourceId)) ||
      input.event.channel === "imu" ||
      identity(after.sourceId) !== identity(input.event.id) ||
      identity(after.userId) !== identity(input.event.userId) ||
      after.providerId !== input.event.providerId ||
      after.key.channel !== input.event.channel ||
      after.generation !== String(input.event.generation) ||
      effect.sourceVersion !== after.sourceVersion ||
      effect.generation !== after.generation ||
      effect.stage !== "scalar" ||
      effect.cursor.effectOrdinal !== "0" ||
      compareMetricStreamPositions(input.position, effect.position) !== 0 ||
      metricStreamPositionIdentity(input.position) !==
        metricStreamPositionIdentity(effect.position) ||
      JSON.stringify(journalDeliveryKey(input.position)) !== JSON.stringify(effect.cursor.delivery)
    )
      throw new Error("Grouped raw insert has mismatched prepared source effects");
    seen.add(identity(effect.sourceId));
    return {
      ...mapMetricStreamEventToClickHouseRow(input.event, input.ingestedAt),
      version: after.sourceVersion,
      is_deleted: after.deleted ? 1 : 0,
    };
  });
  if (!rows.length) return 0;
  await owner.client.command({
    query: `INSERT INTO ${METRIC_STREAM_TABLE} (id,activity_id,user_id,recorded_at,channel,provider_id,external_id,device_id,source_type,scalar,vector,point,metadata,ingested_at,is_deleted,version,generation)
      SELECT incoming.id,incoming.activity_id,incoming.user_id,parseDateTime64BestEffort(incoming.recorded_at,6),incoming.channel,incoming.provider_id,
        incoming.external_id,incoming.device_id,incoming.source_type,incoming.scalar,incoming.vector,incoming.point,incoming.metadata,
        parseDateTime64BestEffort(incoming.ingested_at,9),incoming.is_deleted,incoming.version,incoming.generation
      FROM input('id UUID,activity_id Nullable(UUID),user_id UUID,recorded_at String,channel String,provider_id String,
        external_id Nullable(String),device_id Nullable(String),source_type String,scalar Nullable(Float32),vector Array(Float32),point String,metadata String,
        ingested_at String,is_deleted Int8,version Int64,generation UInt64') AS incoming
      LEFT JOIN (${currentGenerations}) AS current ON incoming.user_id=current.user_id AND incoming.provider_id=current.provider_id
      WHERE lower(hex(SHA256(toString(incoming.user_id)))) NOT IN
        (SELECT user_hash FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL WHERE user_hash IN {hashes:Array(String)})
        AND (incoming.is_deleted=1 OR incoming.generation>=ifNull(current.current_generation,0))
      FORMAT JSONEachRow`,
    query_params: {
      owners: rows.map((row) => new TupleParam([row.user_id, row.provider_id])),
      hashes: [...new Set(rows.map((row) => userHash(row.user_id)))],
    },
    values: Readable.from(
      rows.map((row) => `${JSON.stringify({ ...row, point: row.point ?? "" })}\n`),
    ),
  });
  return rows.filter((row) => row.is_deleted === 0).length;
}
