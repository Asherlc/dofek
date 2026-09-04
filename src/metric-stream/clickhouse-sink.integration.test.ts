import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  METRIC_STREAM_TABLE,
} from "./clickhouse-table.ts";
import {
  createMetricStreamDeletedEvent,
  createMetricStreamEvent,
  type MetricStreamDeleteScopeInput,
  type MetricStreamRowInput,
} from "./events.ts";

const testUserId = "00000000-0000-0000-0000-000000000001";
const testEventId = "5e6f7a8b-0c1d-4e2f-8a3b-4c5d6e7f8a90";
const latestScopeTestEventId = "6f7a8b9c-1d2e-4f3a-9b4c-5d6e7f8a9b01";
const nullExternalIdTestEventId = "7a8b9c0d-2e3f-404b-8c5d-6e7f8a9b0c12";
const replacementTestEventId = "8b9c0d1e-3f40-415c-9d6e-7f8a9b0c1d23";
const batchedDeleteTestEventId = "9c0d1e2f-4051-426d-8e7f-8a9b0c1d2e34";
const batchedDeleteSecondTestEventId = "ad1e2f30-5162-437e-8f90-9b0c1d2e3f45";
const batchedDeleteUnrelatedTestEventId = "be2f3041-6273-448f-901a-0c1d2e3f4056";
const operationRevision = "1000000000000000";

function createCurrentMetricStreamEvent(row: MetricStreamRowInput, revision = operationRevision) {
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
    query: `ALTER TABLE ${METRIC_STREAM_TABLE}
      DELETE WHERE id IN {ids:Array(UUID)}
      SETTINGS mutations_sync = 1`,
    query_params: {
      ids: [
        testEventId,
        latestScopeTestEventId,
        nullExternalIdTestEventId,
        replacementTestEventId,
        batchedDeleteTestEventId,
        batchedDeleteSecondTestEventId,
        batchedDeleteUnrelatedTestEventId,
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

  it("preserves the latest row when only an older version matches the delete scope", async () => {
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
      externalId: "integration-latest-scope",
      sourceType: "api",
      channel: "body_weight",
      scalar: 84.862,
    });
    const latestEvent = { ...matchingEvent, providerId: "garmin" };
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
        provider_id: string;
        version: string;
      }>({
        query: `SELECT provider_id, version
          FROM ${METRIC_STREAM_TABLE}
          WHERE id = {id:UUID}
          ORDER BY version`,
        query_params: { id: latestScopeTestEventId },
        format: "JSONEachRow",
      });
      expect(await historyResult.json()).toEqual([
        { provider_id: "withings", version: 1 },
        { provider_id: "garmin", version: 2 },
      ]);

      await markMetricStreamScopeDeletedInClickHouse(client, {
        userId: testUserId,
        providerId: "withings",
      });

      const result = await client.query<{ is_deleted: number; provider_id: string }>({
        query: `SELECT provider_id, is_deleted
          FROM ${METRIC_STREAM_TABLE} FINAL
          WHERE id = {id:UUID}`,
        query_params: { id: latestScopeTestEventId },
        format: "JSONEachRow",
      });
      expect(await result.json()).toEqual([{ provider_id: "garmin", is_deleted: 0 }]);
    } finally {
      await client.command({ query: `SYSTEM START MERGES ${METRIC_STREAM_TABLE}` });
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
