import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { Readable } from "node:stream";
import { TupleParam } from "@clickhouse/client";
import Pulsar, { type Client } from "pulsar-client";
import { z } from "zod";
import { coordinateAnalyticsDeliveryGroup } from "../analytics/analytics-delivery.ts";
import { loadAnalyticsStreamState } from "../analytics/analytics-work-store.ts";
import { metricStreamPositionIdentity } from "../analytics/journal-position.ts";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { createDatabaseFromEnv, type Database } from "../db/index.ts";
import { captureException } from "../lib/error-reporting.ts";
import {
  type ClickHouseMetricStreamRow,
  mapMetricStreamEventToClickHouseRow,
} from "./clickhouse-row.ts";
import {
  ACCOUNT_ERASURE_FENCE_TABLE,
  ACCOUNT_ERASURE_OPERATION_FENCE_TABLE,
  METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE,
  METRIC_STREAM_DELETE_SCOPE_TABLE,
  METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE,
  METRIC_STREAM_TABLE,
  PROVIDER_DATA_GENERATION_TABLE,
} from "./clickhouse-table.ts";
import type { MetricStreamConsumerBatchContext } from "./consumer-context.ts";
import {
  createMetricStreamConsumerReadinessServer,
  MetricStreamConsumerReadiness,
} from "./consumer-readiness.ts";
import {
  isMetricStreamBatchCompletedEvent,
  isMetricStreamDeletedEvent,
  type MetricStreamDeleteScope,
  type MetricStreamEventV1,
  type MetricStreamEventV2,
  type MetricStreamRedpandaEvent,
  type MetricStreamRowEvent,
} from "./events.ts";
import { runPulsarMetricStreamConsumer } from "./pulsar-consumer.ts";
import { compareMetricStreamPositions, metricStreamPositionSchema } from "./transport-position.ts";

export interface ClickHouseMetricStreamInsertClient {
  command?(options: {
    query: string;
    query_params?: Record<string, unknown>;
    clickhouse_settings?: Record<string, string | number | boolean>;
  }): Promise<unknown>;
  query?(options: {
    query: string;
    query_params?: Record<string, unknown>;
    format: "JSONEachRow";
    clickhouse_settings?: Record<string, string | number | boolean>;
  }): Promise<{ json(): Promise<unknown> }>;
  insert(options: {
    table: typeof METRIC_STREAM_TABLE;
    values: readonly ClickHouseMetricStreamRow[];
    format: "JSONEachRow";
    clickhouse_settings?: Record<string, string | number | boolean>;
  }): Promise<unknown>;
}

const accountErasureOperationFenceRowsSchema = z.array(
  z.object({ operation_hash: z.string().length(64) }),
);

const providerDataGenerationRowsSchema = z.array(
  z.object({
    user_id: z.string(),
    provider_id: z.string(),
    generation: z.coerce.number().int().nonnegative(),
  }),
);
const accountErasureFenceRowsSchema = z.array(z.object({ user_hash: z.string() }));
const deletionAcknowledgementRowsSchema = z.array(
  z.object({ acknowledgement_count: z.coerce.number().int().nonnegative() }),
);
function providerGenerationKey(userId: string, providerId: string): string {
  return `${userId}\0${providerId}`;
}

async function isMetricStreamDeletionAcknowledged(
  client: Pick<ClickHouseMetricStreamInsertClient, "query">,
  eventId: string,
): Promise<boolean> {
  if (!client.query) return false;
  const result = await client.query({
    query: `SELECT 1 AS acknowledgement_count
      FROM ${METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE}
      WHERE event_id = {event_id:UUID}
      LIMIT 1`,
    query_params: { event_id: eventId },
    format: "JSONEachRow",
  });
  return deletionAcknowledgementRowsSchema
    .parse(await result.json())
    .some((row) => row.acknowledgement_count > 0);
}

async function filterEventsByProviderGeneration(
  client: Pick<ClickHouseMetricStreamInsertClient, "query">,
  events: readonly MetricStreamRowEvent[],
): Promise<MetricStreamRowEvent[]> {
  if (events.length === 0) return [];
  if (!client.query) {
    throw new Error("ClickHouse metric-stream ingestion requires a query-capable client");
  }

  const providerScopes = new Map<string, { providerId: string; userId: string }>();
  for (const event of events) {
    providerScopes.set(providerGenerationKey(event.userId, event.providerId), {
      providerId: event.providerId,
      userId: event.userId,
    });
  }

  const queryParams: Record<string, unknown> = {};
  const predicates = [...providerScopes.values()].map((scope, index) => {
    queryParams[`user_id_${index}`] = scope.userId;
    queryParams[`provider_id_${index}`] = scope.providerId;
    return `(user_id = {user_id_${index}:UUID} AND provider_id = {provider_id_${index}:String})`;
  });
  const result = await client.query({
    query: `SELECT user_id, provider_id, max(generation) AS generation
      FROM ${PROVIDER_DATA_GENERATION_TABLE}
      WHERE ${predicates.join(" OR ")}
      GROUP BY user_id, provider_id`,
    query_params: queryParams,
    format: "JSONEachRow",
  });
  const activeGenerations = new Map<string, number>();
  for (const row of providerDataGenerationRowsSchema.parse(await result.json())) {
    activeGenerations.set(providerGenerationKey(row.user_id, row.provider_id), row.generation);
  }

  return events.filter(
    (event) =>
      event.generation >=
      (activeGenerations.get(providerGenerationKey(event.userId, event.providerId)) ?? 0),
  );
}

async function filterEventsByAccountErasureFence(
  client: Pick<ClickHouseMetricStreamInsertClient, "query">,
  events: readonly MetricStreamRowEvent[],
): Promise<MetricStreamRowEvent[]> {
  if (events.length === 0) return [];
  if (!client.query) {
    throw new Error("ClickHouse metric-stream ingestion requires a query-capable client");
  }
  const userHashes = new Map<string, string>();
  for (const event of events) {
    userHashes.set(event.userId, createHash("sha256").update(event.userId).digest("hex"));
  }
  const result = await client.query({
    query: `SELECT user_hash
      FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL
      WHERE user_hash IN {user_hashes:Array(String)}`,
    query_params: {
      user_hashes: [...userHashes.values()],
    },
    format: "JSONEachRow",
  });
  const erasedUserHashes = new Set(
    accountErasureFenceRowsSchema.parse(await result.json()).map((row) => row.user_hash),
  );
  return events.filter((event) => !erasedUserHashes.has(userHashes.get(event.userId) ?? ""));
}

async function tombstoneMetricStreamIds(
  client: Pick<ClickHouseMetricStreamInsertClient, "command">,
  rows: readonly ClickHouseMetricStreamRow[],
): Promise<void> {
  if (rows.length === 0) return;
  if (!client.command) {
    throw new Error(
      "ClickHouse metric-stream generation fencing requires a command-capable client",
    );
  }
  await client.command({
    query: `INSERT INTO ${METRIC_STREAM_TABLE} (
        id, activity_id, user_id, recorded_at, channel, provider_id, external_id,
        device_id, source_type, scalar, vector, point, metadata, ingested_at,
        is_deleted, version, generation
      )
      SELECT
        id,
        latest_row.1 AS activity_id,
        latest_row.2 AS user_id,
        latest_row.3 AS recorded_at,
        latest_row.4 AS channel,
        latest_row.5 AS provider_id,
        latest_row.6 AS external_id,
        latest_row.7 AS device_id,
        latest_row.8 AS source_type,
        latest_row.9 AS scalar,
        latest_row.10 AS vector,
        latest_row.11 AS point,
        latest_row.12 AS metadata,
        parseDateTime64BestEffort(arrayElement({ingested_ats:Array(String)},indexOf({row_ids:Array(UUID)},id)),9) AS ingested_at,
        1 AS is_deleted,
        latest_row.15 + 1 AS version,
        latest_row.13 AS generation
      FROM (
        SELECT
          id,
          argMax(
            tuple(
              activity_id,
              user_id,
              recorded_at,
              channel,
              provider_id,
              external_id,
              device_id,
              source_type,
              scalar,
              vector,
              point,
              metadata,
              generation,
              is_deleted,
              version
            ),
            tuple(version, ingested_at)
          ) AS latest_row
        FROM ${METRIC_STREAM_TABLE}
        WHERE id IN {row_ids:Array(UUID)}
        GROUP BY id
      )
      INNER JOIN (SELECT user_id AS generation_user,provider_id AS generation_provider,
          max(generation) AS current_generation FROM ${PROVIDER_DATA_GENERATION_TABLE}
          GROUP BY user_id,provider_id) AS policy
        ON latest_row.2=policy.generation_user AND latest_row.5=policy.generation_provider
      WHERE latest_row.14 = 0 AND latest_row.13 < policy.current_generation`,
    query_params: {
      row_ids: rows.map((row) => row.id),
      ingested_ats: rows.map((row) => row.ingested_at),
    },
  });
}

async function tombstoneRowsWithNewerDeleteScopes(
  client: ClickHouseClient,
  incomingRows: readonly ClickHouseMetricStreamRow[],
): Promise<void> {
  if (incomingRows.length === 0) return;
  if (!client.query)
    throw new Error("ClickHouse metric-stream ingestion requires a query-capable client");
  // The row insert precedes this read, and scope persistence precedes the delete
  // scan. Concurrent sinks therefore cannot both miss an overlapping write.
  const result = await client.query({
    query: `SELECT row.row_index AS row_index, toString(max(scope.operation_revision * 2)) AS version
      FROM (
        SELECT event.1 AS row_index, event.2 AS user_id, event.3 AS provider_id,
          event.4 AS activity_id, event.5 AS channel, event.6 AS external_id,
          parseDateTime64BestEffort(event.7, 6) AS recorded_at, toUInt64(event.8) AS version
        FROM (SELECT arrayJoin(arrayZip(
          {row_indexes:Array(UInt16)}, {row_user_ids:Array(UUID)},
          {provider_ids:Array(String)}, {activity_ids:Array(Nullable(UUID))},
          {channels:Array(String)}, {external_ids:Array(Nullable(String))},
          {recorded_ats:Array(String)}, {versions:Array(String)}
        )) AS event)
      ) AS row
      CROSS JOIN (SELECT * FROM ${METRIC_STREAM_DELETE_SCOPE_TABLE} FINAL
        WHERE (user_id IS NULL OR user_id IN {user_ids:Array(UUID)})
          AND (provider_id IS NULL OR provider_id IN {scope_provider_ids:Array(String)})
          AND operation_revision * 2 > arrayMin(arrayMap(
            row_version -> toUInt64(row_version), {versions:Array(String)}
          ))) AS scope
      WHERE (scope.user_id IS NULL OR scope.user_id = row.user_id)
        AND (scope.provider_id IS NULL OR scope.provider_id = row.provider_id)
        AND (scope.activity_id IS NULL OR scope.activity_id = row.activity_id)
        AND (scope.channel IS NULL OR scope.channel = row.channel)
        AND (scope.external_id_set = 0 OR isNotDistinctFrom(scope.external_id, row.external_id))
        AND (scope.recorded_at_start IS NULL OR row.recorded_at >= scope.recorded_at_start)
        AND (scope.recorded_at_end IS NULL OR row.recorded_at < scope.recorded_at_end)
        AND row.version < scope.operation_revision * 2
      GROUP BY row.row_index`,
    query_params: {
      row_indexes: incomingRows.map((_row, index) => index),
      row_user_ids: incomingRows.map((row) => row.user_id),
      provider_ids: incomingRows.map((row) => row.provider_id),
      activity_ids: incomingRows.map((row) => row.activity_id),
      channels: incomingRows.map((row) => row.channel),
      external_ids: incomingRows.map((row) => row.external_id),
      recorded_ats: incomingRows.map((row) => row.recorded_at),
      versions: incomingRows.map((row) => String(row.version)),
      user_ids: [...new Set(incomingRows.map((row) => row.user_id))],
      scope_provider_ids: [...new Set(incomingRows.map((row) => row.provider_id))],
    },
    format: "JSONEachRow",
  });
  const guards = new Map(
    z
      .array(
        z.object({ row_index: z.number().int().nonnegative(), version: z.string().regex(/^\d+$/) }),
      )
      .parse(await result.json())
      .map((row) => [row.row_index, row.version]),
  );
  const rows = incomingRows.flatMap((row, index) => {
    const version = guards.get(index);
    return version && BigInt(row.version) < BigInt(version)
      ? [{ ...row, is_deleted: 1 as const, version }]
      : [];
  });
  if (rows.length > 0) {
    if (!client.insert) throw new Error("Metric-stream tombstones require insert");
    await client.insert({
      table: METRIC_STREAM_TABLE,
      values: rows,
      format: "JSONEachRow",
      clickhouse_settings: { date_time_input_format: "best_effort" },
    });
  }
}

/**
 * The publication owner serializes this bounded read with every raw writer,
 * including deletes and erasure. Reserved timestamps alone cannot order equal
 * versions in ReplacingMergeTree; reject stale writes before they reach it.
 */
async function admitCurrentKeyRows(
  client: ClickHouseClient,
  rows: readonly ClickHouseMetricStreamRow[],
): Promise<readonly ClickHouseMetricStreamRow[]> {
  if (!rows.length) return [];
  if (rows.length > 500) throw new Error("Raw current-key guard accepts at most 500 rows");
  const payloadSql = `tuple(source.provider_id,toString(source.generation),source.external_id,
    source.device_id,source.source_type,toString(if(source.scalar=0,toFloat32(0),source.scalar)),
    arrayMap(value->toString(if(value=0,toFloat32(0),value)),source.vector),source.point,source.metadata,source.is_deleted)`;
  const result = await client.query({
    query: `WITH incoming AS (
      SELECT entry.1 AS row_index,entry.2 AS id,entry.3 AS user_id,
        entry.4 AS activity_id,entry.5 AS channel,
        parseDateTime64BestEffort(entry.6,6) AS recorded_at,
        parseDateTime64BestEffort(arrayElement({ingested_ats:Array(String)},entry.1+1),9) AS incoming_ingested_at,
        count() OVER (PARTITION BY entry.3,entry.4,entry.5,
          parseDateTime64BestEffort(entry.6,6),entry.2) AS key_count
      FROM (SELECT arrayJoin({keys:Array(Tuple(UInt16,UUID,UUID,Nullable(UUID),String,String))}) AS entry)
    ), ranks AS (
      SELECT source.user_id,source.activity_id,source.channel,source.recorded_at,source.id,
        max(tuple(source.version,source.ingested_at)) AS current_rank
      FROM ${METRIC_STREAM_TABLE} AS source
      WHERE source.user_id IN {users:Array(UUID)}
        AND tuple(source.user_id,isNull(source.activity_id),
          ifNull(source.activity_id,toUUID('00000000-0000-0000-0000-000000000000')),
          source.channel,source.recorded_at,source.id) IN (
            SELECT tuple(user_id,isNull(activity_id),
              ifNull(activity_id,toUUID('00000000-0000-0000-0000-000000000000')),
              channel,recorded_at,id) FROM incoming
          )
      GROUP BY source.user_id,source.activity_id,source.channel,source.recorded_at,source.id
    ), current_rows AS (
      SELECT source.user_id,source.activity_id,source.channel,source.recorded_at,source.id,
        ranks.current_rank AS current_rank,any(${payloadSql}) AS payload,
        toUInt8(min(toJSONString(${payloadSql}))!=max(toJSONString(${payloadSql}))) AS has_conflict,
        toUInt8(1) AS present
      FROM ${METRIC_STREAM_TABLE} AS source INNER JOIN ranks
        ON source.user_id=ranks.user_id
        AND isNull(source.activity_id)=isNull(ranks.activity_id)
        AND ifNull(source.activity_id,toUUID('00000000-0000-0000-0000-000000000000'))
          =ifNull(ranks.activity_id,toUUID('00000000-0000-0000-0000-000000000000'))
        AND source.channel=ranks.channel AND source.recorded_at=ranks.recorded_at AND source.id=ranks.id
      WHERE source.user_id IN {users:Array(UUID)}
        AND tuple(source.version,source.ingested_at)=ranks.current_rank
      GROUP BY source.user_id,source.activity_id,source.channel,source.recorded_at,source.id,ranks.current_rank
    )
    SELECT incoming.row_index AS row_index,incoming.key_count AS key_count,
      current_rows.present AS present,
      toString(toUnixTimestamp64Nano(incoming.incoming_ingested_at)) AS incoming_nanos,
      toString(current_rows.current_rank.1) AS version,
      toString(toUnixTimestamp64Nano(current_rows.current_rank.2)) AS ingested_nanos,
      current_rows.payload AS payload,current_rows.has_conflict AS has_conflict
    FROM incoming LEFT JOIN current_rows ON incoming.user_id=current_rows.user_id
      AND isNull(incoming.activity_id)=isNull(current_rows.activity_id)
      AND ifNull(incoming.activity_id,toUUID('00000000-0000-0000-0000-000000000000'))
        =ifNull(current_rows.activity_id,toUUID('00000000-0000-0000-0000-000000000000'))
      AND incoming.channel=current_rows.channel AND incoming.recorded_at=current_rows.recorded_at
      AND incoming.id=current_rows.id`,
    query_params: {
      users: [...new Set(rows.map((row) => row.user_id))],
      keys: rows.map(
        (row, index) =>
          new TupleParam([
            index,
            row.id,
            row.user_id,
            row.activity_id,
            row.channel,
            row.recorded_at,
          ]),
      ),
      ingested_ats: rows.map((row) => row.ingested_at),
    },
    format: "JSONEachRow",
    use_multipart_params: true,
    // Bound the decoded physical payload read independently of the incoming group.
    clickhouse_settings: {
      join_use_nulls: 0,
      max_result_rows: 500,
      max_result_bytes: 32 * 1024 * 1024,
      result_overflow_mode: "throw",
    },
  });
  const base = {
    row_index: z.number().int().nonnegative(),
    key_count: z.coerce.number().int().positive(),
    incoming_nanos: z.string().regex(/^-?\d+$/),
  };
  const current = z.discriminatedUnion("present", [
    z.object({ ...base, present: z.literal(0) }),
    z.object({
      ...base,
      present: z.literal(1),
      version: z.string().regex(/^-?\d+$/),
      ingested_nanos: z.string().regex(/^-?\d+$/),
      has_conflict: z.union([z.literal(0), z.literal(1)]),
      payload: z.tuple([
        z.string(),
        z.string().regex(/^\d+$/),
        z.string().nullable(),
        z.string().nullable(),
        z.string().nullable(),
        z.string().nullable(),
        z.array(z.string()),
        z.string(),
        z.string(),
        z.number().int(),
      ]),
    }),
  ]);
  const stored = z
    .array(current)
    .max(500)
    .parse(await result.json());
  const byIndex = new Map(stored.map((row) => [row.row_index, row]));
  if (
    stored.length !== rows.length ||
    byIndex.size !== rows.length ||
    stored.some((row) => row.row_index >= rows.length)
  )
    throw new Error("Raw current-key guard returned incomplete or duplicate membership");
  if (stored.some((row) => row.key_count !== 1))
    throw new Error("Raw publication requires unique full sorting keys");
  const float32 = (value: number | string) => {
    if (value === "inf") return Number.POSITIVE_INFINITY;
    if (value === "-inf") return Number.NEGATIVE_INFINITY;
    return Math.fround(Number(value));
  };
  return rows.filter((row, index) => {
    const before = byIndex.get(index);
    if (!before) throw new Error("Raw current-key guard omitted a member");
    if (before.present === 0) return true;
    const version = BigInt(row.version),
      previous = BigInt(before.version);
    if (previous !== version) return previous < version;
    const time = BigInt(before.incoming_nanos),
      previousTime = BigInt(before.ingested_nanos);
    if (previousTime !== time) return previousTime < time;
    const [
      provider,
      generation,
      external,
      device,
      source,
      scalar,
      vector,
      point,
      metadata,
      deleted,
    ] = before.payload;
    const sameScalar =
      scalar === null
        ? row.scalar === null
        : row.scalar !== null && float32(scalar) === float32(row.scalar);
    const sameVector =
      vector.length === row.vector.length &&
      vector.every((value, ordinal) => {
        const incoming = row.vector[ordinal];
        return incoming !== undefined && float32(value) === float32(incoming);
      });
    if (
      before.has_conflict ||
      provider !== row.provider_id ||
      BigInt(generation) !== BigInt(row.generation) ||
      external !== row.external_id ||
      device !== row.device_id ||
      source !== row.source_type ||
      !sameScalar ||
      !sameVector ||
      point !== (row.point ?? "") ||
      metadata !== row.metadata ||
      deleted !== row.is_deleted
    )
      throw new Error(
        "Raw replay has conflicting payload at the same version and ingestion timestamp",
      );
    return false;
  });
}

async function publishRawRows(
  client: ClickHouseClient,
  inputs: readonly { event: MetricStreamRowEvent; ingestedAt: string }[],
): Promise<number> {
  const replicated = inputs.filter(({ event }) => event.channel !== "imu");
  const active = await filterEventsByAccountErasureFence(
    client,
    replicated.map(({ event }) => event),
  );
  const ids = new Set(active.map((event) => event.id));
  const candidateRows = replicated
    .filter(({ event }) => ids.has(event.id))
    .map(({ event, ingestedAt }) => mapMetricStreamEventToClickHouseRow(event, ingestedAt));
  const rows = await admitCurrentKeyRows(client, candidateRows);
  if (!rows.length) return 0;
  const result = await client.exec({
    query: `INSERT INTO ${METRIC_STREAM_TABLE} FORMAT JSONEachRow`,
    values: Readable.from(
      rows.map((row) => `${JSON.stringify({ ...row, point: row.point ?? "" })}\n`),
    ),
    clickhouse_settings: {
      date_time_input_format: "best_effort",
      wait_end_of_query: 1,
      insert_deduplicate: 0,
    },
  });
  const written = result.summary?.written_rows;
  if (
    typeof written !== "string" ||
    !/^(0|[1-9]\d*)$/.test(written) ||
    BigInt(written) < BigInt(rows.length)
  )
    throw new Error(
      `Raw write summary written_rows ${written ?? "missing"} is below ${rows.length} sent rows`,
    );
  await tombstoneRowsWithNewerDeleteScopes(client, rows);
  const admittedIds = new Set(rows.map((row) => row.id));
  const current = await filterEventsByProviderGeneration(
    client,
    active.filter((event) => admittedIds.has(event.id)),
  );
  const currentIds = new Set(current.map((event) => event.id));
  await tombstoneMetricStreamIds(
    client,
    rows.filter((row) => !currentIds.has(row.id)),
  );
  return current.length;
}
interface ClickHouseDeleteScopeColumnExpressions {
  activityId: string;
  channel: string;
  externalId: string;
  providerId: string;
  recordedAt: string;
  userId: string;
}

const candidateDeleteScopeColumns = {
  activityId: "candidate_row.activity_id",
  channel: "candidate_row.channel",
  externalId: "candidate_row.external_id",
  providerId: "candidate_row.provider_id",
  recordedAt: "candidate_row.recorded_at",
  userId: "candidate_row.user_id",
} satisfies ClickHouseDeleteScopeColumnExpressions;

const latestDeleteScopeColumns = {
  activityId: "latest_row.1",
  channel: "latest_row.4",
  externalId: "latest_row.6",
  providerId: "latest_row.5",
  recordedAt: "latest_row.3",
  userId: "latest_row.2",
} satisfies ClickHouseDeleteScopeColumnExpressions;

function clickHouseDeleteScopeConditions(
  scope: MetricStreamDeleteScope,
  queryParams: Record<string, unknown>,
  columns: ClickHouseDeleteScopeColumnExpressions,
  parameterSuffix = "",
): string[] {
  const conditions: string[] = [];
  const parameterName = (name: string) => `${name}${parameterSuffix}`;
  if (scope.userId) {
    queryParams[parameterName("user_id")] = scope.userId;
    conditions.push(`${columns.userId} = {${parameterName("user_id")}:UUID}`);
  }
  if (scope.providerId) {
    queryParams[parameterName("provider_id")] = scope.providerId;
    conditions.push(`${columns.providerId} = {${parameterName("provider_id")}:String}`);
  }
  if (scope.externalId === null) {
    conditions.push(`${columns.externalId} IS NULL`);
  } else if (scope.externalId !== undefined) {
    queryParams[parameterName("external_id")] = scope.externalId;
    conditions.push(`${columns.externalId} = {${parameterName("external_id")}:String}`);
  }
  if (scope.channel) {
    queryParams[parameterName("channel")] = scope.channel;
    conditions.push(`${columns.channel} = {${parameterName("channel")}:String}`);
  }
  if (scope.activityId) {
    queryParams[parameterName("activity_id")] = scope.activityId;
    conditions.push(`${columns.activityId} = {${parameterName("activity_id")}:UUID}`);
  }
  if (scope.recordedAtStart) {
    queryParams[parameterName("recorded_at_start")] = scope.recordedAtStart;
    conditions.push(
      `${columns.recordedAt} >= parseDateTime64BestEffort({${parameterName("recorded_at_start")}:String})`,
    );
  }
  if (scope.recordedAtEnd) {
    queryParams[parameterName("recorded_at_end")] = scope.recordedAtEnd;
    conditions.push(
      `${columns.recordedAt} < parseDateTime64BestEffort({${parameterName("recorded_at_end")}:String})`,
    );
  }
  if (conditions.length === 0) {
    throw new Error("Metric stream delete scope produced no ClickHouse conditions");
  }
  return conditions;
}

interface MetricStreamDeleteCommand {
  eventId?: string;
  operationRevision?: string;
  scope: MetricStreamDeleteScope;
}

// Each scope can add seven HTTP parameters. Keep requests below ClickHouse's
// default 1,000-field limit, including the revision and client settings.
const MAX_METRIC_STREAM_DELETE_SCOPES_PER_WRITE = 100;

async function markMetricStreamDeleteCommandsInClickHouse(
  client: Pick<ClickHouseMetricStreamInsertClient, "command">,
  deletes: readonly MetricStreamDeleteCommand[],
  ingestedAt: string,
): Promise<void> {
  if (deletes.length === 0) {
    return;
  }
  if (!client.command) {
    throw new Error("ClickHouse metric-stream deletion requires a command-capable client");
  }
  const operationRevision = deletes[0]?.operationRevision;
  if (deletes.some((event) => event.operationRevision !== operationRevision)) {
    throw new Error("ClickHouse metric-stream deletion batch requires one operation revision");
  }
  if (deletes.length > MAX_METRIC_STREAM_DELETE_SCOPES_PER_WRITE) {
    for (
      let offset = 0;
      offset < deletes.length;
      offset += MAX_METRIC_STREAM_DELETE_SCOPES_PER_WRITE
    ) {
      await markMetricStreamDeleteCommandsInClickHouse(
        client,
        deletes.slice(offset, offset + MAX_METRIC_STREAM_DELETE_SCOPES_PER_WRITE),
        ingestedAt,
      );
    }
    return;
  }
  const queryParams: Record<string, unknown> = {};
  const replacementVersionExpression = operationRevision
    ? "{replacement_version:UInt64}"
    : "latest_row.15 + 1";
  if (operationRevision) {
    queryParams.replacement_version = (BigInt(operationRevision) * 2n).toString();
  }
  queryParams.ingested_at = ingestedAt;
  const isBatch = deletes.length > 1;
  const candidatePredicates = deletes.map((event, index) =>
    clickHouseDeleteScopeConditions(
      event.scope,
      queryParams,
      candidateDeleteScopeColumns,
      isBatch ? `_${index}` : "",
    ),
  );
  const latestPredicates = deletes.map((event, index) =>
    clickHouseDeleteScopeConditions(
      event.scope,
      queryParams,
      latestDeleteScopeColumns,
      isBatch ? `_${index}` : "",
    ),
  );
  const scopedCandidates = candidatePredicates
    .map(
      (conditions, index) => `SELECT candidate_row.id AS id, toUInt16(${index}) AS scope_index
          FROM ${METRIC_STREAM_TABLE} AS candidate_row
          WHERE ${conditions.join(" AND ")}
          GROUP BY candidate_row.id`,
    )
    .join("\n          UNION ALL\n          ");
  const correlatedLatestPredicates = latestPredicates
    .map((conditions, index) => `(scope_index = ${index} AND ${conditions.join(" AND ")})`)
    .join(" OR ");

  if (operationRevision) {
    const scopes = deletes.map(({ scope }) => ({
      user_id: scope.userId ?? null,
      provider_id: scope.providerId ?? null,
      activity_id: scope.activityId ?? null,
      channel: scope.channel ?? null,
      external_id: scope.externalId ?? null,
      external_id_set: scope.externalId === undefined ? 0 : 1,
      recorded_at_start: scope.recordedAtStart ?? null,
      recorded_at_end: scope.recordedAtEnd ?? null,
      operation_revision: operationRevision,
    }));
    await client.command({
      query: `INSERT INTO ${METRIC_STREAM_DELETE_SCOPE_TABLE} FORMAT JSONEachRow\n${scopes.map((scope) => JSON.stringify(scope)).join("\n")}`,
      clickhouse_settings: { date_time_input_format: "best_effort" },
    });
  }

  await client.command({
    query: `INSERT INTO ${METRIC_STREAM_TABLE} (
        id, activity_id, user_id, recorded_at, channel, provider_id, external_id,
        device_id, source_type, scalar, vector, point, metadata, ingested_at,
        is_deleted, version, generation
      )
      SELECT
        id,
        latest_row.1 AS activity_id,
        latest_row.2 AS user_id,
        latest_row.3 AS recorded_at,
        latest_row.4 AS channel,
        latest_row.5 AS provider_id,
        latest_row.6 AS external_id,
        latest_row.7 AS device_id,
        latest_row.8 AS source_type,
        latest_row.9 AS scalar,
        latest_row.10 AS vector,
        latest_row.11 AS point,
        latest_row.12 AS metadata,
        parseDateTime64BestEffort({ingested_at:String},9) AS ingested_at,
        1 AS is_deleted,
        ${replacementVersionExpression} AS version,
        latest_row.13 AS generation
      FROM (
        SELECT DISTINCT id, latest_row
        FROM (
        SELECT
          metric_stream_row.id AS id,
          candidate_scope.scope_index AS scope_index,
          argMax(
            tuple(
              metric_stream_row.activity_id,
              metric_stream_row.user_id,
              metric_stream_row.recorded_at,
              metric_stream_row.channel,
              metric_stream_row.provider_id,
              metric_stream_row.external_id,
              metric_stream_row.device_id,
              metric_stream_row.source_type,
              metric_stream_row.scalar,
              metric_stream_row.vector,
              metric_stream_row.point,
              metric_stream_row.metadata,
              metric_stream_row.generation,
              metric_stream_row.is_deleted,
              metric_stream_row.version
            ),
            tuple(metric_stream_row.version, metric_stream_row.ingested_at)
          ) AS latest_row
        FROM ${METRIC_STREAM_TABLE} AS metric_stream_row
        INNER JOIN (
          ${scopedCandidates}
        ) AS candidate_scope ON candidate_scope.id = metric_stream_row.id
        GROUP BY metric_stream_row.id, candidate_scope.scope_index
        )
        WHERE ${correlatedLatestPredicates}
      )
      WHERE latest_row.14 = 0
        AND lower(hex(SHA256(toString(latest_row.2)))) NOT IN (
          SELECT user_hash
          FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL
        )`,
    query_params: queryParams,
  });
  for (const { eventId } of deletes) {
    if (eventId) {
      await client.command({
        query: `INSERT INTO ${METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE} (event_id,applied_at)
          VALUES ({event_id:UUID},parseDateTime64BestEffort({ingested_at:String},9))`,
        query_params: { event_id: eventId, ingested_at: ingestedAt },
      });
    }
  }
}

function listenReadinessServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(3001, "0.0.0.0");
  });
}

async function keepMetricStreamOwnershipActive<T>(
  context: MetricStreamConsumerBatchContext,
  operation: () => Promise<T>,
): Promise<T> {
  let failure: unknown;
  let pending: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (pending || failure) return;
    pending = context
      .assertActive()
      .catch((error: unknown) => {
        failure = error;
        captureException(error, {
          tags: { metricStreamConsumer: "clickhouse-sink", metricStreamFailure: "ownership" },
        });
      })
      .finally(() => {
        pending = undefined;
      });
  }, 3_000);
  const stop = async () => {
    clearInterval(timer);
    await pending;
  };
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    await stop();
    throw error;
  }
  await stop();
  if (failure) throw failure;
  return result;
}

export async function applyMetricStreamEventsToClickHouse(
  client: ClickHouseClient,
  events: readonly MetricStreamRedpandaEvent[],
  context: MetricStreamConsumerBatchContext,
  database: Database,
): Promise<number> {
  if (!client.insert) throw new Error("Metric-stream sink requires an insert-capable client");
  if (
    context.positions.length !== events.length ||
    context.positions.some(
      (position) =>
        !metricStreamPositionSchema.safeParse(position).success ||
        position.topic !== context.topic ||
        position.partition !== context.partition,
    )
  )
    throw new Error(
      "Metric-stream delivery positions must align with every event and batch stream",
    );
  for (let index = 1; index < context.positions.length; index++) {
    const prior = context.positions[index - 1],
      current = context.positions[index];
    if (!prior || !current || compareMetricStreamPositions(prior, current) >= 0)
      throw new Error(
        "Metric-stream delivery positions must preserve strict native delivery order",
      );
  }
  let inserted = 0;
  for (let index = 0; index < events.length; ) {
    const event = events[index];
    if (!event) throw new Error("Metric-stream event is missing");
    const position = context.positions[index];
    if (!position) throw new Error("Metric-stream delivery position is missing");
    if (isMetricStreamRow(event)) {
      const members: {
        event: MetricStreamEventV1 | MetricStreamEventV2;
        position: typeof position;
      }[] = [];
      const seen = new Set<string>();
      while (index < events.length && members.length < 500) {
        const next = events[index],
          nextPosition = context.positions[index];
        if (!next || !nextPosition) throw new Error("Metric-stream group input is incomplete");
        if (!isMetricStreamRow(next) || seen.has(next.id.toLowerCase())) break;
        seen.add(next.id.toLowerCase());
        members.push({ event: next, position: nextPosition });
        index++;
      }
      const byPosition = new Map(
        members.map((member) => [metricStreamPositionIdentity(member.position), member]),
      );
      const inputs = (positions: readonly (typeof position)[], times: readonly string[]) => {
        if (positions.length !== times.length)
          throw new Error("Grouped ingestion times do not match native members");
        return positions.map((position, ordinal) => {
          const member = byPosition.get(metricStreamPositionIdentity(position)),
            ingestedAt = times[ordinal];
          if (!member || !ingestedAt)
            throw new Error("Grouped native member or ingestion time is missing");
          return { ...member, ingestedAt };
        });
      };
      await keepMetricStreamOwnershipActive(context, () =>
        coordinateAnalyticsDeliveryGroup(
          { database, clickhouse: client },
          {
            positions: members.map((member) => member.position),
            maximum: 500,
            assertActive: context.assertActive,
            userIds: members.map(({ event }) => event.userId),
            publish: async (owner, positions, times, fenced) => {
              const rows = inputs(positions, times).filter(
                ({ event }) => !fenced.has(event.userId.toLowerCase()),
              );
              inserted += await publishRawRows(owner.client, rows);
            },
          },
        ),
      );
      await context.assertActive();
      continue;
    }
    if (isMetricStreamBatchCompletedEvent(event) && position.transport !== "pulsar")
      throw new Error("Native processing marker requires a Pulsar position");
    await context.assertActive();
    await keepMetricStreamOwnershipActive(context, () =>
      coordinateAnalyticsDeliveryGroup(
        { database, clickhouse: client },
        {
          positions: [position],
          maximum: 1,
          userIds:
            isMetricStreamDeletedEvent(event) && event.scope.userId ? [event.scope.userId] : [],
          assertActive: context.assertActive,
          publish: async (owner, _positions, times, fenced) => {
            const ingestedAt = times[0];
            if (!ingestedAt) throw new Error("Control ingestion reservation is missing");
            if (isMetricStreamDeletedEvent(event)) {
              if (event.scope.userId && fenced.has(event.scope.userId.toLowerCase())) return;
              if (
                "eventId" in event &&
                (await isMetricStreamDeletionAcknowledged(owner.client, event.eventId))
              )
                return;
              await markMetricStreamDeleteCommandsInClickHouse(
                owner.client,
                [
                  {
                    scope: event.scope,
                    eventId: "eventId" in event ? event.eventId : undefined,
                    operationRevision:
                      "operationRevision" in event ? event.operationRevision : undefined,
                  },
                ],
                ingestedAt,
              );
            }
            if (isMetricStreamBatchCompletedEvent(event)) {
              if (position.transport !== "pulsar")
                throw new Error("Native processing marker requires a Pulsar position");
              if (await isOperationAccountErasureFenced(owner.client, event.operationId)) return;
              await owner.client.command({
                query:
                  "INSERT INTO " +
                  METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE +
                  " (operation_id,batch_id,dataset_keys,expected_event_count,topic,topic_partition,marker_offset,marker_transport,marker_epoch,marker_message_id,applied_at)" +
                  " VALUES ({operation_id:UUID},{batch_id:String},{dataset_keys:Array(String)},{expected_event_count:UInt64},{topic:String},{partition:Int32},{marker_offset:Nullable(UInt64)},{marker_transport:String},{marker_epoch:Nullable(String)},{marker_message_id:Nullable(String)},parseDateTime64BestEffort({ingested_at:String},9))",
                query_params: {
                  operation_id: event.operationId,
                  batch_id: event.batchId,
                  dataset_keys: event.datasetKeys,
                  expected_event_count: event.expectedEventCount,
                  topic: position.topic,
                  partition: position.partition,
                  marker_offset: null,
                  marker_transport: "pulsar",
                  marker_epoch: position.epoch,
                  marker_message_id: position.serializedMessageId,
                  ingested_at: ingestedAt,
                },
              });
            }
          },
        },
      ),
    );
    await context.assertActive();
    index++;
  }
  return inserted;
}

function isMetricStreamRow(event: MetricStreamRedpandaEvent): event is MetricStreamRowEvent {
  return !isMetricStreamDeletedEvent(event) && !isMetricStreamBatchCompletedEvent(event);
}
async function isOperationAccountErasureFenced(
  client: Pick<ClickHouseClient, "query">,
  operationId: string,
): Promise<boolean> {
  const result = await client.query({
    query:
      "SELECT operation_hash FROM " +
      ACCOUNT_ERASURE_OPERATION_FENCE_TABLE +
      " FINAL WHERE operation_hash={operation_hash:FixedString(64)} LIMIT 1",
    query_params: { operation_hash: createHash("sha256").update(operationId).digest("hex") },
    format: "JSONEachRow",
    clickhouse_settings: { log_queries: 0 },
  });
  return accountErasureOperationFenceRowsSchema.parse(await result.json()).length > 0;
}
function requiredSinkEnvironment(
  key:
    | "PULSAR_SERVICE_URL"
    | "METRIC_STREAM_TOPIC"
    | "METRIC_STREAM_TRANSPORT_EPOCH"
    | "METRIC_STREAM_SUBSCRIPTION",
): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}
export async function runMetricStreamClickHouseSinkFromEnv(
  readiness: MetricStreamConsumerReadiness,
): Promise<void> {
  const controller = new AbortController();
  const stop = () => {
    readiness.markUnavailable();
    controller.abort();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  let database: Database | undefined;
  let client: ReturnType<typeof createClickHouseClientFromEnv> | undefined;
  let native: Client | undefined;
  let failed = false;
  let failure: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    const serviceUrl = requiredSinkEnvironment("PULSAR_SERVICE_URL");
    const topic = requiredSinkEnvironment("METRIC_STREAM_TOPIC");
    const epoch = requiredSinkEnvironment("METRIC_STREAM_TRANSPORT_EPOCH");
    const subscription = requiredSinkEnvironment("METRIC_STREAM_SUBSCRIPTION");
    if (!topic.startsWith("persistent://"))
      throw new Error("METRIC_STREAM_TOPIC must name one concrete persistent Pulsar topic");
    const db = createDatabaseFromEnv();
    database = db;
    const clickhouse = createClickHouseClientFromEnv();
    client = clickhouse;
    const pulsar = new Pulsar.Client({ serviceUrl });
    native = pulsar;
    const stream = { transport: "pulsar" as const, epoch, topic, partition: -1 };
    await runPulsarMetricStreamConsumer({
      client: pulsar,
      readiness,
      topic,
      epoch,
      partition: -1,
      subscription,
      receiverQueueSize: 20,
      nativeBatchMessages: 20,
      nativeBatchBytes: 8 * 1024 * 1024,
      maxGroupMessages: 500,
      maxGroupBytes: 8 * 1024 * 1024,
      signal: controller.signal,
      loadPendingGroup: async () =>
        (await loadAnalyticsStreamState(db, stream))?.pendingGroup ?? null,
      handleEvents: async (events, context) => {
        await applyMetricStreamEventsToClickHouse(clickhouse, events, context, db);
      },
    });
  } catch (error) {
    failed = true;
    failure = error;
    captureException(error, {
      tags: { metricStreamConsumer: "clickhouse-sink", metricStreamFailure: "runtime" },
    });
  } finally {
    readiness.markUnavailable();
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    const closing: Promise<unknown>[] = [];
    const ownedNative = native,
      ownedClient = client,
      ownedDatabase = database;
    if (ownedNative) closing.push(Promise.resolve().then(() => ownedNative.close()));
    if (ownedClient) closing.push(Promise.resolve().then(() => ownedClient.close()));
    if (ownedDatabase) closing.push(Promise.resolve().then(() => ownedDatabase.$client.end()));
    const outcomes = await Promise.allSettled(closing);
    for (const result of outcomes)
      if (result.status === "rejected") {
        cleanupErrors.push(result.reason);
        captureException(result.reason, {
          tags: { metricStreamConsumer: "clickhouse-sink", metricStreamFailure: "cleanup" },
        });
      }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      failed ? [failure, ...cleanupErrors] : cleanupErrors,
      "Metric-stream sink and cleanup failed",
    );
  if (failed) throw failure;
}
export async function startMetricStreamClickHouseSinkFromEnv(): Promise<void> {
  const readiness = new MetricStreamConsumerReadiness();
  const server = createMetricStreamConsumerReadinessServer(readiness);
  let failed = false;
  let failure: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    await listenReadinessServer(server);
    server.unref();
    await runMetricStreamClickHouseSinkFromEnv(readiness);
  } catch (error) {
    failed = true;
    failure = error;
    captureException(error, {
      tags: { metricStreamConsumer: "clickhouse-sink", metricStreamFailure: "readiness" },
    });
  } finally {
    readiness.markUnavailable();
    if (server.listening) {
      try {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      } catch (error) {
        captureException(error, {
          tags: { metricStreamConsumer: "clickhouse-sink", metricStreamFailure: "readiness-close" },
        });
        cleanupErrors.push(error);
      }
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      failed ? [failure, ...cleanupErrors] : cleanupErrors,
      "Metric-stream sink and readiness close failed",
    );
  if (failed) throw failure;
}
