import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { buildClickHouseBootstrapStatementsForNativeMetricStream } from "../db/clickhouse-metric-stream-bootstrap.ts";
import {
  applyMetricStreamEventsToClickHouse,
  type ClickHouseMetricStreamInsertClient,
  insertMetricStreamEventsIntoClickHouse,
  mapMetricStreamEventToClickHouseRow,
  markMetricStreamScopeDeletedInClickHouse,
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
  type MetricStreamDeleteScopeInput,
  type MetricStreamRowInput,
  metricStreamEventV2Schema,
} from "./events.ts";

const testUserId = randomUUID();
const testEventId = "5e6f7a8b-0c1d-4e2f-8a3b-4c5d6e7f8a90";
const latestScopeTestEventId = "6f7a8b9c-1d2e-4f3a-9b4c-5d6e7f8a9b01";
const nullExternalIdTestEventId = "7a8b9c0d-2e3f-404b-8c5d-6e7f8a9b0c12";
const replacementTestEventId = "8b9c0d1e-3f40-415c-9d6e-7f8a9b0c1d23";
const crossRouteReplacementTestEventId = "4a9c0d1e-3f40-415c-9d6e-7f8a9b0c1d23";
const batchedDeleteTestEventId = "9c0d1e2f-4051-426d-8e7f-8a9b0c1d2e34";
const batchedDeleteSecondTestEventId = "ad1e2f30-5162-437e-8f90-9b0c1d2e3f45";
const batchedDeleteUnrelatedTestEventId = "be2f3041-6273-448f-901a-0c1d2e3f4056";
const longDeleteTestEventIds = [
  "ce2f3041-6273-448f-901a-0c1d2e3f4056",
  "de2f3041-6273-448f-901a-0c1d2e3f4056",
  "ee2f3041-6273-448f-901a-0c1d2e3f4056",
] as const;
const operationRevision = "1000000000000000";

const zeppMetricRowsSchema = z.array(
  z.object({
    id: z.string(),
    channel: z.string(),
    vector: z.array(z.number()),
    metadata: z.string(),
  }),
);

const zeppSamples = [
  { channel: "accelerometer", vector: [1.25, -2.5, 980], units: "cm/s²" },
  { channel: "gyroscope", vector: [-10, 20, 30.5], units: "deg/s" },
  { channel: "accelerometer", vector: [4, 5, 981], units: "cm/s²" },
].map((sample, index) =>
  createMetricStreamEvent(
    {
      recordedAt: "2026-06-11T14:36:12.042Z",
      userId: testUserId,
      providerId: "amazfit-zepp",
      externalId: `zos-imu:1781188572000:${index}:${sample.channel}`,
      sourceType: "api",
      channel: sample.channel,
      vector: sample.vector,
      metadata: { units: sample.units },
    },
    operationRevision,
  ),
);

function createCurrentMetricStreamEvent(
  row: MetricStreamRowInput & { id?: string },
  revision = operationRevision,
) {
  // Historical wire fixtures retain stored IDs, including moved-identity versions.
  if (row.id !== undefined) {
    return metricStreamEventV2Schema.parse({ ...row, version: 2, operationRevision: revision });
  }
  return createMetricStreamEvent(row, revision);
}

function createCurrentMetricStreamDeletedEvent(
  scope: MetricStreamDeleteScopeInput,
  revision = operationRevision,
) {
  return createMetricStreamDeletedEvent(scope, revision);
}

function assertInsertCapable(
  client: ClickHouseClient,
): asserts client is ClickHouseClient & ClickHouseMetricStreamInsertClient {
  if (typeof client.insert !== "function") {
    throw new Error("ClickHouse client must support insert");
  }
}

async function removeTestEvent(client: ClickHouseClient): Promise<void> {
  await client.command({
    query: `ALTER TABLE ${METRIC_STREAM_DELETE_SCOPE_TABLE} DELETE WHERE user_id = {user_id:UUID} SETTINGS mutations_sync = 1`,
    query_params: { user_id: testUserId },
  });
  await client.command({
    query: `ALTER TABLE ${METRIC_STREAM_TABLE}
      DELETE WHERE id IN {ids:Array(UUID)}
      SETTINGS mutations_sync = 1`,
    query_params: {
      ids: [
        testEventId,
        latestScopeTestEventId,
        nullExternalIdTestEventId,
        replacementTestEventId,
        crossRouteReplacementTestEventId,
        ...zeppSamples.map((event) => event.id),
        batchedDeleteTestEventId,
        batchedDeleteSecondTestEventId,
        batchedDeleteUnrelatedTestEventId,
        ...longDeleteTestEventIds,
      ],
    },
  });
}

describe("metric stream ClickHouse sink (integration)", () => {
  const client = createClickHouseClientFromEnv();
  assertInsertCapable(client);

  beforeAll(async () => {
    for (const statement of buildClickHouseBootstrapStatementsForNativeMetricStream("")) {
      await client.command({ query: statement });
    }
    await removeTestEvent(client);
  }, 120_000);

  afterAll(async () => {
    await removeTestEvent(client);
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

  it("retains Zepp vectors and units, distinct same-millisecond records, and deduplicated retries", async () => {
    await applyMetricStreamEventsToClickHouse(client, zeppSamples);
    await applyMetricStreamEventsToClickHouse(client, zeppSamples);

    const result = await client.query({
      query: `SELECT id, channel, vector, metadata
        FROM ${METRIC_STREAM_TABLE} FINAL
        WHERE id IN {ids:Array(UUID)}
        ORDER BY external_id`,
      query_params: { ids: zeppSamples.map((event) => event.id) },
      format: "JSONEachRow",
    });
    expect(zeppMetricRowsSchema.parse(await result.json())).toEqual(
      zeppSamples.map((event) => ({
        id: event.id,
        channel: event.channel,
        vector: event.vector,
        metadata: JSON.stringify(event.metadata),
      })),
    );
  });

  it("inserts events whose recordedAt carries a UTC Z suffix", async () => {
    // recordedAt is canonical ISO-8601 with a trailing Z; ClickHouse rejects it
    // unless the insert parses each datetime value with best_effort.
    const event = createCurrentMetricStreamEvent({
      id: testEventId,
      recordedAt: "2026-06-07T14:36:12.000Z",
      userId: testUserId,
      providerId: "withings",
      externalId: "integration-z-suffix",
      sourceType: "api",
      channel: "body_weight",
      scalar: 84.862,
    });

    await insertMetricStreamEventsIntoClickHouse(client, [event]);

    const result = await client.query<{ count: string }>({
      query: `SELECT count() AS count FROM ${METRIC_STREAM_TABLE} WHERE id = {id:UUID}`,
      query_params: { id: testEventId },
      format: "JSONEachRow",
    });
    const rows = await result.json();
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it("retains distinct device timestamp identities while coalescing repeated timestamp identities", async () => {
    const userId = randomUUID();
    const reading = (deviceId: string, recordedAt: string, scalar: number) =>
      createCurrentMetricStreamEvent({
        userId,
        providerId: "whoop_ble",
        deviceId,
        recordedAt,
        externalId: `whoop_ble:${deviceId}:heart_rate:${recordedAt}`,
        sourceType: "ble",
        channel: "heart_rate",
        scalar,
      });
    const sameTime = "2026-10-28T12:05:00.000Z";
    const clamped = [reading("clamped", sameTime, 60), reading("clamped", sameTime, 61)];
    const raw = [
      reading("raw", "2026-10-28T12:00:00.000Z", 60),
      reading("raw", "2026-10-28T12:00:01.000Z", 61),
    ];
    expect(clamped[0]?.id).toBe(clamped[1]?.id);
    expect(raw[0]?.id).not.toBe(raw[1]?.id);
    try {
      await insertMetricStreamEventsIntoClickHouse(client, [...clamped, ...raw]);
      const counts = await client.query({
        query: `SELECT device_id, count() AS count FROM ${METRIC_STREAM_TABLE} FINAL
          WHERE user_id = {userId:UUID} GROUP BY device_id ORDER BY device_id`,
        query_params: { userId },
        format: "JSONEachRow",
      });
      expect(
        z
          .array(z.object({ device_id: z.string(), count: z.coerce.number() }))
          .parse(await counts.json()),
      ).toEqual([
        { device_id: "clamped", count: 1 },
        { device_id: "raw", count: 2 },
      ]);
      const readings = await client.query({
        query: `SELECT scalar FROM ${METRIC_STREAM_TABLE} FINAL
          WHERE user_id = {userId:UUID} AND device_id = 'raw' ORDER BY recorded_at`,
        query_params: { userId },
        format: "JSONEachRow",
      });
      expect(z.array(z.object({ scalar: z.number() })).parse(await readings.json())).toEqual([
        { scalar: 60 },
        { scalar: 61 },
      ]);
    } finally {
      await client.command({
        query: `ALTER TABLE ${METRIC_STREAM_TABLE} DELETE WHERE user_id = {userId:UUID} SETTINGS mutations_sync = 1`,
        query_params: { userId },
      });
    }
  });

  it("tombstones the latest provider-scoped metric version", async () => {
    const event = createCurrentMetricStreamEvent({
      id: testEventId,
      recordedAt: "2026-06-07T14:36:12.000Z",
      userId: testUserId,
      providerId: "withings",
      externalId: "integration-provider-delete",
      sourceType: "api",
      channel: "body_weight",
      scalar: 84.862,
    });
    await insertMetricStreamEventsIntoClickHouse(client, [event, event, event, event]);

    await markMetricStreamScopeDeletedInClickHouse(client, {
      userId: testUserId,
      providerId: "withings",
    });

    const result = await client.query<{ is_deleted: number; latest_version: number }>({
      query: `SELECT
          argMax(is_deleted, version) AS is_deleted,
          max(version) AS latest_version
        FROM ${METRIC_STREAM_TABLE}
        WHERE id = {id:UUID}`,
      query_params: { id: testEventId },
      format: "JSONEachRow",
    });
    const row = (await result.json())[0];
    expect(row).toEqual({ is_deleted: 1, latest_version: 2_000_000_000_000_002 });
  });

  it("preserves the latest activity when only an older version matches the delete scope", async () => {
    const oldActivityId = randomUUID();
    const newActivityId = randomUUID();
    await client.command({
      query: `ALTER TABLE ${METRIC_STREAM_TABLE}
        DELETE WHERE id = {id:UUID}
        SETTINGS mutations_sync = 1`,
      query_params: { id: latestScopeTestEventId },
    });
    await client.command({ query: `SYSTEM STOP MERGES ${METRIC_STREAM_TABLE}` });
    const matchingEvent = createCurrentMetricStreamEvent({
      id: latestScopeTestEventId,
      recordedAt: "2026-06-08T14:36:12.000Z",
      userId: testUserId,
      providerId: "withings",
      activityId: oldActivityId,
      externalId: "integration-latest-scope",
      sourceType: "api",
      channel: "body_weight",
      scalar: 84.862,
    });
    const latestEvent = { ...matchingEvent, activityId: newActivityId };
    try {
      const matchingRow = {
        ...mapMetricStreamEventToClickHouseRow(matchingEvent),
        ingested_at: "2026-06-08T14:36:12.000Z",
        version: 1,
      };
      const latestRow = {
        ...mapMetricStreamEventToClickHouseRow(latestEvent),
        ingested_at: "2026-06-08T14:36:13.000Z",
        version: 2,
      };
      await client.insert({
        table: METRIC_STREAM_TABLE,
        values: [matchingRow],
        format: "JSONEachRow",
        clickhouse_settings: { date_time_input_format: "best_effort" },
      });
      await client.insert({
        table: METRIC_STREAM_TABLE,
        values: [latestRow],
        format: "JSONEachRow",
        clickhouse_settings: { date_time_input_format: "best_effort" },
      });

      const historyResult = await client.query<{
        activity_id: string;
        version: string;
      }>({
        query: `SELECT activity_id, version
          FROM ${METRIC_STREAM_TABLE}
          WHERE id = {id:UUID}
          ORDER BY version`,
        query_params: { id: latestScopeTestEventId },
        format: "JSONEachRow",
      });
      expect(await historyResult.json()).toEqual([
        { activity_id: oldActivityId, version: 1 },
        { activity_id: newActivityId, version: 2 },
      ]);

      await markMetricStreamScopeDeletedInClickHouse(client, {
        userId: testUserId,
        activityId: oldActivityId,
      });

      const result = await client.query({
        query: `SELECT argMax(tuple(activity_id), tuple(version, ingested_at)).1 AS activity_id,
            countIf(is_deleted = 1) AS deleted_versions
          FROM ${METRIC_STREAM_TABLE}
          WHERE id = {id:UUID}`,
        query_params: { id: latestScopeTestEventId },
        format: "JSONEachRow",
      });
      const rows = z
        .array(
          z.object({
            activity_id: z.string(),
            deleted_versions: z.coerce.number(),
          }),
        )
        .parse(await result.json());
      expect(rows).toEqual([{ activity_id: newActivityId, deleted_versions: 0 }]);
    } finally {
      await client.command({ query: `SYSTEM START MERGES ${METRIC_STREAM_TABLE}` });
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

  it("tombstones rows scoped to a null external ID", async () => {
    const event = createCurrentMetricStreamEvent({
      id: nullExternalIdTestEventId,
      recordedAt: "2026-06-09T14:36:12.000Z",
      userId: testUserId,
      providerId: "withings",
      sourceType: "api",
      channel: "body_weight",
      scalar: 84.862,
    });
    await insertMetricStreamEventsIntoClickHouse(client, [event]);

    await markMetricStreamScopeDeletedInClickHouse(client, {
      userId: testUserId,
      providerId: "withings",
      externalId: null,
    });

    const result = await client.query<{ is_deleted: number }>({
      query: `SELECT argMax(is_deleted, version) AS is_deleted
        FROM ${METRIC_STREAM_TABLE}
        WHERE id = {id:UUID}`,
      query_params: { id: nullExternalIdTestEventId },
      format: "JSONEachRow",
    });
    expect((await result.json())[0]?.is_deleted).toBe(1);
  });

  it("tombstones multiple external-ID scopes in one ordered delete batch", async () => {
    const baseRow = {
      recordedAt: "2026-06-09T15:36:12.000Z",
      userId: testUserId,
      providerId: "apple_health",
      sourceType: "file",
      channel: "heart_rate",
      scalar: 72,
    } satisfies Omit<MetricStreamRowInput, "externalId" | "id">;
    await insertMetricStreamEventsIntoClickHouse(client, [
      createCurrentMetricStreamEvent(
        {
          ...baseRow,
          id: batchedDeleteTestEventId,
          externalId: "integration-batched-delete-1",
        },
        "999999999999999",
      ),
      createCurrentMetricStreamEvent(
        {
          ...baseRow,
          id: batchedDeleteSecondTestEventId,
          externalId: "integration-batched-delete-2",
        },
        "999999999999999",
      ),
      createCurrentMetricStreamEvent(
        {
          ...baseRow,
          id: batchedDeleteUnrelatedTestEventId,
          externalId: "integration-batched-delete-unrelated",
        },
        "999999999999999",
      ),
    ]);
    const firstDelete = createCurrentMetricStreamDeletedEvent({
      userId: testUserId,
      providerId: "apple_health",
      externalId: "integration-batched-delete-1",
    });
    const secondDelete = createCurrentMetricStreamDeletedEvent({
      userId: testUserId,
      providerId: "apple_health",
      externalId: "integration-batched-delete-2",
    });

    await markMetricStreamScopesDeletedInClickHouse(client, [firstDelete, secondDelete]);

    const result = await client.query<{ external_id: string; is_deleted: number }>({
      query: `SELECT external_id, is_deleted
        FROM ${METRIC_STREAM_TABLE} FINAL
        WHERE id IN {ids:Array(UUID)}
        ORDER BY external_id`,
      query_params: {
        ids: [
          batchedDeleteTestEventId,
          batchedDeleteSecondTestEventId,
          batchedDeleteUnrelatedTestEventId,
        ],
      },
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      { external_id: "integration-batched-delete-1", is_deleted: 1 },
      { external_id: "integration-batched-delete-2", is_deleted: 1 },
      { external_id: "integration-batched-delete-unrelated", is_deleted: 0 },
    ]);
  });

  it("reactivates the same deterministic row ID after a scoped replacement", async () => {
    const initialEvent = createCurrentMetricStreamEvent(
      {
        id: replacementTestEventId,
        recordedAt: "2026-06-10T14:36:12.000Z",
        userId: testUserId,
        providerId: "garmin-dump",
        externalId: "integration-scoped-replacement",
        sourceType: "file",
        channel: "heart_rate",
        scalar: 94,
      },
      "1000000000000001",
    );
    await applyMetricStreamEventsToClickHouse(client, [initialEvent]);

    const replacementEvent = createCurrentMetricStreamEvent(
      {
        id: replacementTestEventId,
        recordedAt: "2026-06-10T14:36:12.000Z",
        userId: testUserId,
        providerId: "garmin-dump",
        externalId: "integration-scoped-replacement",
        sourceType: "file",
        channel: "heart_rate",
        scalar: 94,
      },
      "1000000000000002",
    );

    await applyMetricStreamEventsToClickHouse(client, [
      createCurrentMetricStreamDeletedEvent(
        { providerId: "garmin-dump", userId: testUserId },
        "1000000000000002",
      ),
      replacementEvent,
    ]);

    const result = await client.query<{ is_deleted: number; scalar: number }>({
      query: `SELECT is_deleted, scalar
        FROM ${METRIC_STREAM_TABLE} FINAL
        WHERE id = {id:UUID}`,
      query_params: { id: replacementTestEventId },
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([{ is_deleted: 0, scalar: 94 }]);
  });

  it("keeps the newer live replacement when an older history replacement arrives last", async () => {
    const row = {
      id: crossRouteReplacementTestEventId,
      recordedAt: "2026-06-10T15:36:12.000Z",
      userId: testUserId,
      providerId: "cross-route-replacement-test",
      externalId: "integration-cross-route-replacement",
      sourceType: "api",
      channel: "heart_rate",
    } satisfies Omit<MetricStreamRowInput, "scalar"> & { id: string };
    const scope = {
      userId: row.userId,
      providerId: row.providerId,
      externalId: row.externalId,
    };
    const historyDelete = createCurrentMetricStreamDeletedEvent(scope, "1000000000000001");
    const liveDelete = createCurrentMetricStreamDeletedEvent(scope, "1000000000000003");
    const lateHistoryDelete = createCurrentMetricStreamDeletedEvent(scope, "1000000000000002");
    const historyReplacement = createCurrentMetricStreamEvent(
      { ...row, scalar: 70 },
      "1000000000000001",
    );
    const liveReplacement = createCurrentMetricStreamEvent(
      { ...row, scalar: 75 },
      "1000000000000003",
    );
    const lateHistoryReplacement = createCurrentMetricStreamEvent(
      { ...row, scalar: 72 },
      "1000000000000002",
    );
    const readCurrentRow = async () => {
      const result = await client.query({
        query: `SELECT is_deleted, scalar, toString(version) AS version
          FROM ${METRIC_STREAM_TABLE} FINAL
          WHERE id = {id:UUID}`,
        query_params: { id: row.id },
        format: "JSONEachRow",
      });
      return result.json();
    };

    await applyMetricStreamEventsToClickHouse(client, [historyDelete, historyReplacement]);
    expect(await readCurrentRow()).toEqual([
      { is_deleted: 0, scalar: 70, version: "2000000000000003" },
    ]);

    await applyMetricStreamEventsToClickHouse(client, [liveDelete, liveReplacement]);
    expect(await readCurrentRow()).toEqual([
      { is_deleted: 0, scalar: 75, version: "2000000000000007" },
    ]);

    await applyMetricStreamEventsToClickHouse(client, [lateHistoryDelete, lateHistoryReplacement]);
    expect(await readCurrentRow()).toEqual([
      { is_deleted: 0, scalar: 75, version: "2000000000000007" },
    ]);

    const acknowledgements = await client.query({
      query: `SELECT toString(count()) AS count
        FROM ${METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE} FINAL
        WHERE event_id IN {ids:Array(UUID)}`,
      query_params: {
        ids: [historyDelete.eventId, liveDelete.eventId, lateHistoryDelete.eventId],
      },
      format: "JSONEachRow",
    });
    expect(await acknowledgements.json()).toEqual([{ count: "3" }]);
  });

  it("guards rows omitted by a newer live replacement before older history first arrives", async () => {
    const scope = { userId: testUserId, providerId: "late-history-omission-test" };
    const row = {
      ...scope,
      recordedAt: "2026-06-10T15:36:12.000Z",
      sourceType: "api",
      channel: "heart_rate",
    };
    const historyA = createCurrentMetricStreamEvent({ ...row, externalId: "A", scalar: 70 }, "101");
    const historyB = createCurrentMetricStreamEvent({ ...row, externalId: "B", scalar: 71 }, "101");
    const liveA = createCurrentMetricStreamEvent({ ...row, externalId: "A", scalar: 75 }, "103");
    try {
      await applyMetricStreamEventsToClickHouse(client, [
        createCurrentMetricStreamDeletedEvent(scope, "103"),
        liveA,
      ]);
      await applyMetricStreamEventsToClickHouse(client, [
        createCurrentMetricStreamDeletedEvent(scope, "101"),
        historyA,
        historyB,
      ]);
      const result = await client.query({
        query: `SELECT external_id, scalar, toString(version) AS version FROM ${METRIC_STREAM_TABLE} FINAL WHERE provider_id = {provider:String} AND is_deleted = 0 ORDER BY external_id`,
        query_params: { provider: scope.providerId },
        format: "JSONEachRow",
      });
      expect(await result.json()).toEqual([{ external_id: "A", scalar: 75, version: "207" }]);
    } finally {
      await client.command({
        query: `ALTER TABLE ${METRIC_STREAM_TABLE} DELETE WHERE provider_id = {provider:String} SETTINGS mutations_sync = 1`,
        query_params: { provider: scope.providerId },
      });
    }
  });

  it("does not amplify incoming rows against deletion scopes older than the batch", async () => {
    const userId = randomUUID();
    const providerId = `scope-pruning-${userId}`;
    const scopeQueryIds: string[] = [];
    const rows = Array.from({ length: 32 }, (_, index) =>
      createCurrentMetricStreamEvent(
        {
          userId,
          providerId,
          externalId: `current-${index}`,
          recordedAt: "2026-06-11T14:36:12.000Z",
          sourceType: "api",
          channel: "heart_rate",
          scalar: 75,
        },
        "1000000000000040",
      ),
    );
    const profiledClient: ClickHouseMetricStreamInsertClient = {
      command: (options) => client.command(options),
      insert: (options) => client.insert(options),
      query: (options) => {
        const queryId = randomUUID();
        if (options.query.includes(METRIC_STREAM_DELETE_SCOPE_TABLE)) {
          scopeQueryIds.push(queryId);
        }
        return client.query({
          ...options,
          query_id: queryId,
          clickhouse_settings: {
            ...options.clickhouse_settings,
            log_queries: 1,
            log_profile_events: 1,
          },
        });
      },
    };

    try {
      await client.insert({
        table: METRIC_STREAM_DELETE_SCOPE_TABLE,
        values: Array.from({ length: 512 }, (_, index) => ({
          user_id: index % 2 === 0 ? userId : null,
          provider_id: providerId,
          recorded_at_start: new Date(Date.UTC(2026, 5, 10) + index * 1_000).toISOString(),
          operation_revision: "1000000000000039",
        })),
        format: "JSONEachRow",
        clickhouse_settings: { date_time_input_format: "best_effort" },
      });

      await applyMetricStreamEventsToClickHouse(profiledClient, rows);
      const currentRows = await client.query({
        query: `SELECT count() AS count FROM ${METRIC_STREAM_TABLE} FINAL
          WHERE user_id = {userId:UUID} AND is_deleted = 0`,
        query_params: { userId },
        format: "JSONEachRow",
      });
      expect(
        z.array(z.object({ count: z.coerce.number() })).parse(await currentRows.json()),
      ).toEqual([{ count: 32 }]);

      await client.command({ query: "SYSTEM FLUSH LOGS" });
      const profileResult = await client.query({
        query: `SELECT ProfileEvents['JoinResultRowCount'] AS join_rows
          FROM system.query_log
          WHERE query_id IN {queryIds:Array(String)} AND type = 'QueryFinish'`,
        query_params: { queryIds: scopeQueryIds },
        format: "JSONEachRow",
      });
      const profileSchema = z.array(z.object({ join_rows: z.coerce.number() }));
      expect(profileSchema.parse(await profileResult.json())).toEqual([{ join_rows: 0 }]);
    } finally {
      await client.command({
        query: `ALTER TABLE ${METRIC_STREAM_DELETE_SCOPE_TABLE}
          DELETE WHERE provider_id = {providerId:String} SETTINGS mutations_sync = 1`,
        query_params: { providerId },
      });
      await client.command({
        query: `ALTER TABLE ${METRIC_STREAM_TABLE}
          DELETE WHERE user_id = {userId:UUID} SETTINGS mutations_sync = 1`,
        query_params: { userId },
      });
    }
  });

  it("guards older rows in a mixed-version batch while retaining same-operation and newer rows", async () => {
    const userId = randomUUID();
    const scope = { userId, providerId: "mixed-revision-test" };
    const row = {
      ...scope,
      recordedAt: "2026-06-11T14:36:12.000Z",
      sourceType: "api",
      channel: "heart_rate",
      scalar: 75,
    };
    // Put the newest row first to catch filtering by the first or maximum version.
    // The minimum version rounds up to the deletion boundary if converted to Number.
    const rows = [
      createCurrentMetricStreamEvent({ ...row, externalId: "newer" }, "5000000000000103"),
      createCurrentMetricStreamEvent({ ...row, externalId: "older" }, "5000000000000101"),
      createCurrentMetricStreamEvent({ ...row, externalId: "same-operation" }, "5000000000000102"),
    ];

    try {
      await applyMetricStreamEventsToClickHouse(client, [
        createCurrentMetricStreamDeletedEvent(scope, "5000000000000102"),
        ...rows,
      ]);
      const result = await client.query({
        query: `SELECT external_id, is_deleted, toString(version) AS version
          FROM ${METRIC_STREAM_TABLE} FINAL
          WHERE user_id = {userId:UUID} ORDER BY external_id`,
        query_params: { userId },
        format: "JSONEachRow",
      });
      const resultSchema = z.array(
        z.object({ external_id: z.string(), is_deleted: z.number(), version: z.string() }),
      );
      expect(resultSchema.parse(await result.json())).toEqual([
        { external_id: "newer", is_deleted: 0, version: "10000000000000207" },
        { external_id: "older", is_deleted: 1, version: "10000000000000204" },
        { external_id: "same-operation", is_deleted: 0, version: "10000000000000205" },
      ]);
    } finally {
      await client.command({
        query: `ALTER TABLE ${METRIC_STREAM_DELETE_SCOPE_TABLE}
          DELETE WHERE user_id = {userId:UUID} SETTINGS mutations_sync = 1`,
        query_params: { userId },
      });
      await client.command({
        query: `ALTER TABLE ${METRIC_STREAM_TABLE}
          DELETE WHERE user_id = {userId:UUID} SETTINGS mutations_sync = 1`,
        query_params: { userId },
      });
    }
  });

  it("applies deletion chunks within HTTP limits before their replacement rows", async () => {
    const ids = longDeleteTestEventIds;
    const deleteCount = 101; // Cross the 100-scope write boundary once.
    const scopeIndexes = [0, 99, 100];
    const rows = ids.map((id, index) =>
      createCurrentMetricStreamEvent({
        id,
        recordedAt: "2026-06-10T14:36:12.000Z",
        userId: testUserId,
        providerId: "bounded-delete-test",
        externalId: `bounded-delete-${scopeIndexes[index]}`,
        sourceType: "file",
        channel: "heart_rate",
        scalar: 94,
      }),
    );
    await insertMetricStreamEventsIntoClickHouse(client, rows);
    const revision = "1000000000000003";
    const deletes = Array.from({ length: deleteCount }, (_, index) =>
      createCurrentMetricStreamDeletedEvent(
        {
          userId: testUserId,
          providerId: "bounded-delete-test",
          externalId: `bounded-delete-${index}`,
        },
        revision,
      ),
    );
    const replacement = createCurrentMetricStreamEvent(
      {
        id: longDeleteTestEventIds[2],
        recordedAt: "2026-06-10T14:36:12.000Z",
        userId: testUserId,
        providerId: "bounded-delete-test",
        externalId: "bounded-delete-100",
        sourceType: "file",
        channel: "heart_rate",
        scalar: 99,
      },
      revision,
    );

    await applyMetricStreamEventsToClickHouse(client, [...deletes, replacement]);

    const result = await client.query({
      query: `SELECT external_id, is_deleted, scalar FROM ${METRIC_STREAM_TABLE} FINAL
        WHERE id IN {ids:Array(UUID)} ORDER BY external_id`,
      query_params: { ids },
      format: "JSONEachRow",
    });
    const rowsSchema = z.array(
      z.object({
        external_id: z.string(),
        is_deleted: z.number(),
        scalar: z.number(),
      }),
    );
    expect(rowsSchema.parse(await result.json())).toEqual([
      { external_id: "bounded-delete-0", is_deleted: 1, scalar: 94 },
      { external_id: "bounded-delete-100", is_deleted: 0, scalar: 99 },
      { external_id: "bounded-delete-99", is_deleted: 1, scalar: 94 },
    ]);
    const acknowledgements = await client.query({
      query: `SELECT count() AS count FROM ${METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE} FINAL
        WHERE event_id IN {ids:Array(UUID)}`,
      query_params: { ids: deletes.map((event) => event.eventId) },
      format: "JSONEachRow",
    });
    const countSchema = z.array(z.object({ count: z.coerce.number() }));
    expect(countSchema.parse(await acknowledgements.json())).toEqual([{ count: deleteCount }]);
  });

  it("matches nullable and bounded scopes precisely without deleting equal-revision replacements", async () => {
    const activityId = randomUUID();
    const scope = {
      userId: testUserId,
      providerId: "scope-boundary-test",
      activityId,
      channel: "heart_rate",
      externalId: null,
      recordedAtStart: "2026-09-01T00:00:00.000Z",
      recordedAtEnd: "2026-09-02T00:00:00.000Z",
    };
    const base = {
      userId: testUserId,
      providerId: scope.providerId,
      activityId,
      channel: scope.channel,
      externalId: null,
      recordedAt: scope.recordedAtStart,
      sourceType: "api",
    };
    const olderRevision = "9007199254740993";
    const newerRevision = "9007199254740995";
    const fixtures = [
      { ...base, scalar: 1 },
      { ...base, scalar: 2, recordedAt: scope.recordedAtEnd },
      { ...base, scalar: 3, recordedAt: "2026-08-31T23:59:59.999Z" },
      { ...base, scalar: 4, externalId: "other" },
      { ...base, scalar: 5, channel: "power" },
      { ...base, scalar: 6, activityId: randomUUID() },
      { ...base, scalar: 7, providerId: "other-scope-provider" },
      { ...base, scalar: 8 },
    ].map((row) =>
      createCurrentMetricStreamEvent(
        { ...row, id: randomUUID() },
        row.scalar === 8 ? newerRevision : olderRevision,
      ),
    );
    try {
      await applyMetricStreamEventsToClickHouse(client, [
        createCurrentMetricStreamDeletedEvent(scope, newerRevision),
      ]);
      await applyMetricStreamEventsToClickHouse(client, fixtures);
      const result = await client.query({
        query: `SELECT scalar FROM ${METRIC_STREAM_TABLE} FINAL WHERE id IN {ids:Array(UUID)} AND is_deleted = 0 ORDER BY scalar`,
        query_params: { ids: fixtures.map((event) => event.id) },
        format: "JSONEachRow",
      });
      expect(await result.json()).toEqual([2, 3, 4, 5, 6, 7, 8].map((scalar) => ({ scalar })));
    } finally {
      await client.command({
        query: `ALTER TABLE ${METRIC_STREAM_TABLE} DELETE WHERE id IN {ids:Array(UUID)} SETTINGS mutations_sync = 1`,
        query_params: { ids: fixtures.map((event) => event.id) },
      });
    }
  });

  it("acknowledges a deletion event only after applying it", async () => {
    const deletedEvent = createCurrentMetricStreamDeletedEvent({
      userId: testUserId,
      providerId: "withings",
    });

    await applyMetricStreamEventsToClickHouse(client, [deletedEvent]);

    const result = await client.query<{ acknowledgement_count: string }>({
      query: `SELECT count() AS acknowledgement_count
        FROM ${METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE}
        WHERE event_id = {eventId:UUID}`,
      query_params: { eventId: deletedEvent.eventId },
      format: "JSONEachRow",
    });
    expect(Number((await result.json())[0]?.acknowledgement_count)).toBe(1);
  });
});
