import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { buildClickHouseBootstrapStatementsForNativeMetricStream } from "../db/clickhouse-metric-stream-bootstrap.ts";
import {
  type ClickHouseMetricStreamInsertClient,
  insertMetricStreamEventsIntoClickHouse,
  mapMetricStreamEventToClickHouseRow,
  markMetricStreamScopesDeletedInClickHouse,
} from "./clickhouse-sink.ts";
import {
  METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE,
  METRIC_STREAM_DELETE_SCOPE_TABLE,
  METRIC_STREAM_TABLE,
} from "./clickhouse-table.ts";
import {
  createMetricStreamDeletedEvent,
  createMetricStreamEvent,
  type MetricStreamRowInput,
  metricStreamEventV2Schema,
} from "./events.ts";

const operationRevision = "1000000000000000";
function createCurrentMetricStreamEvent(
  row: MetricStreamRowInput & { id?: string },
  revision = operationRevision,
) {
  return row.id === undefined
    ? createMetricStreamEvent(row, revision)
    : metricStreamEventV2Schema.parse({ ...row, version: 2, operationRevision: revision });
}
const createCurrentMetricStreamDeletedEvent = (
  scope: Parameters<typeof createMetricStreamDeletedEvent>[0],
  revision = operationRevision,
) => createMetricStreamDeletedEvent(scope, revision);
function assertInsertCapable(
  client: ClickHouseClient,
): asserts client is ClickHouseClient & ClickHouseMetricStreamInsertClient {
  if (typeof client.insert !== "function") throw new Error("ClickHouse client must support insert");
}

describe("metric stream scoped deletion identity (integration)", () => {
  const client = createClickHouseClientFromEnv();
  assertInsertCapable(client);
  beforeAll(async () => {
    for (const statement of buildClickHouseBootstrapStatementsForNativeMetricStream(""))
      await client.command({ query: statement });
  });
  afterAll(async () => {
    await client.close?.();
  });
  it("prunes unrelated identities while applying a scoped deletion", async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const activityId = randomUUID();
    const queryId = randomUUID();
    const fixtureRows = 65_536;
    try {
      await client.command({
        query: `INSERT INTO ${METRIC_STREAM_TABLE}
          (id, user_id, activity_id, provider_id, recorded_at, channel, scalar)
          SELECT reinterpretAsUUID(MD5(concat(toString({userId:UUID}), toString(number)))),
            if(number % 16 = 0, {userId:UUID}, {otherUserId:UUID}),
            {activityId:UUID}, 'identity-pruning-test',
            toDateTime64('2026-06-08 12:00:00', 6), 'heart_rate', 72
          FROM numbers(${fixtureRows})`,
        query_params: { userId, otherUserId, activityId },
      });
      await markMetricStreamScopesDeletedInClickHouse(
        {
          command: (options) =>
            client.command({
              ...options,
              ...(options.query.startsWith(`INSERT INTO ${METRIC_STREAM_TABLE} (`)
                ? { query_id: queryId }
                : {}),
            }),
        },
        [createCurrentMetricStreamDeletedEvent({ userId, activityId })],
      );
      const result = await client.query({
        query: `SELECT user_id, countIf(is_deleted = 1) AS deleted,
            countIf(is_deleted = 0) AS live
          FROM ${METRIC_STREAM_TABLE} FINAL
          WHERE user_id IN {users:Array(UUID)} GROUP BY user_id`,
        query_params: { users: [userId, otherUserId] },
        format: "JSONEachRow",
      });
      const counts = z
        .array(
          z.object({
            user_id: z.string(),
            deleted: z.coerce.number(),
            live: z.coerce.number(),
          }),
        )
        .parse(await result.json());
      expect(counts).toEqual(
        expect.arrayContaining([
          { user_id: userId, deleted: fixtureRows / 16, live: 0 },
          { user_id: otherUserId, deleted: 0, live: (fixtureRows * 15) / 16 },
        ]),
      );

      await client.command({ query: "SYSTEM FLUSH LOGS" });
      const stats = await client.query({
        query: `SELECT read_rows FROM system.query_log
          WHERE query_id = {queryId:String} AND type = 'QueryFinish'`,
        query_params: { queryId },
        format: "JSONEachRow",
      });
      const reads = z
        .array(z.object({ read_rows: z.coerce.number().positive() }))
        .parse(await stats.json());
      expect(reads).toHaveLength(1);
      expect(reads[0]?.read_rows).toBeLessThan(fixtureRows / 2);
    } finally {
      await client.command({
        query: `ALTER TABLE ${METRIC_STREAM_TABLE} DELETE
          WHERE user_id IN {users:Array(UUID)} SETTINGS mutations_sync = 1`,
        query_params: { users: [userId, otherUserId] },
      });
      await client.command({
        query: `ALTER TABLE ${METRIC_STREAM_DELETE_SCOPE_TABLE} DELETE
          WHERE user_id = {userId:UUID} SETTINGS mutations_sync = 1`,
        query_params: { userId },
      });
    }
  });

  it.each(["channel", "externalId", "scalar"] as const)(
    "resolves the latest %s correction with native timestamp precision",
    async (field) => {
      const userId = randomUUID();
      const event = createCurrentMetricStreamEvent({
        id: randomUUID(),
        userId,
        providerId: "identity-correction-test",
        recordedAt: "2026-06-08T12:00:00.000001Z",
        sourceType: "api",
        channel: "heart_rate",
        externalId: "original",
        scalar: 72,
      });
      const changes = { channel: "power", externalId: "moved", scalar: 81 };
      const latest = { ...event, [field]: changes[field] };
      const scope = {
        userId,
        providerId: event.providerId,
        channel: event.channel,
        externalId: event.externalId,
        recordedAtStart: "2026-06-08T12:00:00.000Z",
        recordedAtEnd: "2026-06-08T12:00:01.000Z",
      };
      await client.command({ query: `SYSTEM STOP MERGES ${METRIC_STREAM_TABLE}` });
      try {
        for (const [index, row] of [event, latest].entries()) {
          await client.insert({
            table: METRIC_STREAM_TABLE,
            values: [
              {
                ...mapMetricStreamEventToClickHouseRow(row),
                version: 3,
                ingested_at: `2026-06-08T12:00:00.00000000${index}Z`,
              },
            ],
            format: "JSONEachRow",
            clickhouse_settings: { date_time_input_format: "best_effort" },
          });
        }
        await markMetricStreamScopesDeletedInClickHouse(client, [
          createCurrentMetricStreamDeletedEvent(scope),
        ]);
        const result = await client.query({
          query: `SELECT latest.1 AS channel, latest.2 AS external_id,
              latest.3 AS scalar, latest.4 AS is_deleted,
              toString(toUnixTimestamp64Micro(latest.5)) AS recorded_microseconds,
              deleted_count
            FROM (SELECT argMax(tuple(channel, external_id, scalar, is_deleted, recorded_at),
                tuple(version, ingested_at)) AS latest,
                countIf(is_deleted = 1) AS deleted_count
              FROM ${METRIC_STREAM_TABLE} WHERE id = {id:UUID})`,
          query_params: { id: event.id },
          format: "JSONEachRow",
        });
        const rows = z
          .array(
            z.object({
              channel: z.string(),
              external_id: z.string(),
              scalar: z.number(),
              is_deleted: z.number(),
              recorded_microseconds: z.string(),
              deleted_count: z.coerce.number(),
            }),
          )
          .parse(await result.json());
        expect(rows).toEqual([
          {
            channel: latest.channel,
            external_id: latest.externalId,
            scalar: latest.scalar,
            is_deleted: field === "scalar" ? 1 : 0,
            recorded_microseconds: (
              BigInt(Date.parse("2026-06-08T12:00:00Z")) * 1000n +
              1n
            ).toString(),
            deleted_count: field === "scalar" ? 1 : 0,
          },
        ]);
      } finally {
        await client.command({ query: `SYSTEM START MERGES ${METRIC_STREAM_TABLE}` });
        await client.command({
          query: `ALTER TABLE ${METRIC_STREAM_TABLE} DELETE
            WHERE user_id = {userId:UUID} SETTINGS mutations_sync = 1`,
          query_params: { userId },
        });
        await client.command({
          query: `ALTER TABLE ${METRIC_STREAM_DELETE_SCOPE_TABLE} DELETE
            WHERE user_id = {userId:UUID} SETTINGS mutations_sync = 1`,
          query_params: { userId },
        });
      }
    },
  );

  it("applies an activity-only scope across users in a mixed scope batch", async () => {
    const activityId = randomUUID();
    const specificUser = randomUUID();
    const events = [0, 1].map((index) =>
      createCurrentMetricStreamEvent(
        {
          userId: randomUUID(),
          providerId: `mixed-scope-${index}`,
          activityId,
          recordedAt: "2026-06-08T12:00:00Z",
          externalId: "sample",
          sourceType: "api",
          channel: "heart_rate",
          scalar: 72,
        },
        "999999999999999",
      ),
    );
    const deletes = [
      createCurrentMetricStreamDeletedEvent({ userId: specificUser, providerId: "unrelated" }),
      createCurrentMetricStreamDeletedEvent({ activityId }),
    ];
    try {
      await insertMetricStreamEventsIntoClickHouse(client, events);
      await markMetricStreamScopesDeletedInClickHouse(client, deletes);
      const result = await client.query({
        query: `SELECT countIf(is_deleted = 1) AS deleted
          FROM ${METRIC_STREAM_TABLE} FINAL WHERE id IN {ids:Array(UUID)}`,
        query_params: { ids: events.map((event) => event.id) },
        format: "JSONEachRow",
      });
      expect(z.array(z.object({ deleted: z.coerce.number() })).parse(await result.json())).toEqual([
        { deleted: 2 },
      ]);
      const acknowledgements = await client.query({
        query: `SELECT count() AS count FROM ${METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE} FINAL
          WHERE event_id IN {ids:Array(UUID)}`,
        query_params: { ids: deletes.map((event) => event.eventId) },
        format: "JSONEachRow",
      });
      expect(
        z.array(z.object({ count: z.coerce.number() })).parse(await acknowledgements.json()),
      ).toEqual([{ count: 2 }]);
    } finally {
      await client.command({
        query: `ALTER TABLE ${METRIC_STREAM_TABLE} DELETE
          WHERE activity_id = {activityId:UUID} SETTINGS mutations_sync = 1`,
        query_params: { activityId },
      });
      await client.command({
        query: `ALTER TABLE ${METRIC_STREAM_DELETE_SCOPE_TABLE} DELETE
          WHERE activity_id = {activityId:UUID} OR user_id = {specificUser:UUID}
          SETTINGS mutations_sync = 1`,
        query_params: { activityId, specificUser },
      });
      await client.command({
        query: `ALTER TABLE ${METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE} DELETE
          WHERE event_id IN {ids:Array(UUID)} SETTINGS mutations_sync = 1`,
        query_params: { ids: deletes.map((event) => event.eventId) },
      });
    }
  });
});
