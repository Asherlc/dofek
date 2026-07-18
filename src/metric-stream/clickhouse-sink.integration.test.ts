import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { buildClickHouseBootstrapStatementsForNativeMetricStream } from "../db/clickhouse-metric-stream-bootstrap.ts";
import {
  applyMetricStreamEventsToClickHouse,
  type ClickHouseMetricStreamInsertClient,
  insertMetricStreamEventsIntoClickHouse,
  markMetricStreamScopeDeletedInClickHouse,
} from "./clickhouse-sink.ts";
import { METRIC_STREAM_TABLE } from "./clickhouse-table.ts";
import { createMetricStreamDeletedEvent, createMetricStreamEvent } from "./events.ts";

const testUserId = "00000000-0000-0000-0000-000000000001";
const testEventId = "5e6f7a8b-0c1d-4e2f-8a3b-4c5d6e7f8a90";

function assertInsertCapable(
  client: ClickHouseClient,
): asserts client is ClickHouseClient & ClickHouseMetricStreamInsertClient {
  if (typeof client.insert !== "function") {
    throw new Error("ClickHouse client must support insert");
  }
}

async function removeTestEvent(client: ClickHouseClient): Promise<void> {
  await client.command({
    query: `DELETE FROM ${METRIC_STREAM_TABLE} WHERE id = {id:UUID}`,
    query_params: { id: testEventId },
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
    const event = createMetricStreamEvent({
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
    const event = createMetricStreamEvent({
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

    const result = await client.query<{ is_deleted: number }>({
      query: `SELECT argMax(is_deleted, version) AS is_deleted
        FROM ${METRIC_STREAM_TABLE}
        WHERE id = {id:UUID}`,
      query_params: { id: testEventId },
      format: "JSONEachRow",
    });
    const row = (await result.json())[0];
    expect(row?.is_deleted).toBe(1);
  });

  it("acknowledges a deletion event only after applying it", async () => {
    const deletedEvent = createMetricStreamDeletedEvent({
      userId: testUserId,
      providerId: "withings",
    });

    await applyMetricStreamEventsToClickHouse(client, [deletedEvent]);

    const result = await client.query<{ acknowledgement_count: string }>({
      query: `SELECT count() AS acknowledgement_count
        FROM ingest.metric_stream_delete_acknowledgement
        WHERE event_id = {eventId:UUID}`,
      query_params: { eventId: deletedEvent.eventId },
      format: "JSONEachRow",
    });
    expect(Number((await result.json())[0]?.acknowledgement_count)).toBe(1);
  });
});
