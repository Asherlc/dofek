import { randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import { z } from "zod";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import type { ClickHouseMetricStreamInsertClient } from "./clickhouse-sink.ts";
import {
  ACCOUNT_ERASURE_FENCE_TABLE,
  METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE,
  METRIC_STREAM_DELETE_SCOPE_TABLE,
  METRIC_STREAM_TABLE,
} from "./clickhouse-table.ts";
import {
  createMetricStreamBatchCompletedEvent,
  createMetricStreamDeletedEvent,
  createMetricStreamEvent,
  type MetricStreamDeleteScopeInput,
} from "./events.ts";

type CallableVitestMock = { mock: { calls: unknown[][] } };

export function makeActiveGenerationQuery(generation: string, providerId: string, userId: string) {
  return vi.fn(async (options: { query: string }) => ({
    json: async () =>
      options.query.includes(ACCOUNT_ERASURE_FENCE_TABLE) ||
      options.query.includes(METRIC_STREAM_DELETE_SCOPE_TABLE)
        ? []
        : [{ generation, provider_id: providerId, user_id: userId }],
  }));
}

export function createProcessingMarker() {
  return createMetricStreamBatchCompletedEvent(
    {
      operationId: "30000000-0000-4000-8000-000000000001",
      batchId: "heart-rate-1",
      datasetKeys: ["recovery"],
    },
    1,
  );
}

export function makeEmptyGenerationQuery() {
  return vi.fn(async () => ({ json: async () => [] }));
}

export const processingMarkerFailureCases = [
  {
    reason: "Kafka batch context",
    client: { command: vi.fn(async () => undefined), insert: vi.fn(async () => undefined) },
    error: "processing marker requires Kafka batch context",
  },
  {
    reason: "marker offset",
    client: { command: vi.fn(async () => undefined), insert: vi.fn(async () => undefined) },
    context: {
      topic: "metric-stream-v1",
      partition: 2,
      eventOffsets: [],
      heartbeat: vi.fn(async () => undefined),
    },
    error: "processing marker is missing its Kafka offset",
  },
  {
    reason: "a command-capable client",
    client: { insert: vi.fn(async () => undefined) },
    context: {
      topic: "metric-stream-v1",
      partition: 2,
      eventOffsets: ["42"],
      heartbeat: vi.fn(async () => undefined),
    },
    error: "ClickHouse metric-stream processing acknowledgement requires a command-capable client",
  },
];

export function createAcknowledgementDeleteFixture(userId: string, providerId: string) {
  const deletedRows = Array.from({ length: 101 }, (_, index) =>
    createMetricStreamEvent(
      {
        userId,
        providerId,
        externalId: `affected-${index}`,
        recordedAt: "2026-06-11T14:36:12.000Z",
        sourceType: "api",
        channel: "heart_rate",
        scalar: index,
      },
      "999999999999999",
    ),
  );
  const unaffectedRows = ["other-provider", "other-user", "other-external-id"].map(
    (suffix, index) =>
      createMetricStreamEvent(
        {
          userId: index === 1 ? randomUUID() : userId,
          providerId: index === 0 ? `${providerId}-other` : providerId,
          externalId: `unaffected-${suffix}`,
          recordedAt: "2026-06-11T14:36:12.000Z",
          sourceType: "api",
          channel: "heart_rate",
          scalar: 200 + index,
        },
        "999999999999999",
      ),
  );
  const events = deletedRows.map((_, index) =>
    createMetricStreamDeletedEvent(
      { userId, providerId, externalId: `affected-${index}` },
      "1000000000000000",
    ),
  );
  return { deletedRows, unaffectedRows, events };
}

export const replacementScopeTestCases: {
  label: string;
  scope: MetricStreamDeleteScopeInput;
  params: Record<string, string>;
  candidate: string[];
  latest: string[];
  accountFence: boolean;
}[] = [
  {
    label: "nullable bounded",
    scope: {
      userId: "10000000-0000-4000-8000-000000000001",
      providerId: "fitbit",
      externalId: null,
      channel: "body_weight",
      activityId: "20000000-0000-4000-8000-000000000001",
      recordedAtStart: "2026-03-01T00:00:00.000Z",
      recordedAtEnd: "2026-03-02T00:00:00.000Z",
    },
    params: {
      user_id: "10000000-0000-4000-8000-000000000001",
      provider_id: "fitbit",
      channel: "body_weight",
      activity_id: "20000000-0000-4000-8000-000000000001",
      recorded_at_start: "2026-03-01T00:00:00.000Z",
      recorded_at_end: "2026-03-02T00:00:00.000Z",
    },
    candidate: [
      "candidate_row.user_id = {user_id:UUID}",
      "candidate_row.provider_id = {provider_id:String}",
      "candidate_row.external_id IS NULL",
      "candidate_row.channel = {channel:String}",
      "candidate_row.activity_id = {activity_id:UUID}",
      "candidate_row.recorded_at >= parseDateTime64BestEffort({recorded_at_start:String})",
      "candidate_row.recorded_at < parseDateTime64BestEffort({recorded_at_end:String})",
    ],
    latest: [
      "latest_row.2 = {user_id:UUID}",
      "latest_row.5 = {provider_id:String}",
      "latest_row.6 IS NULL",
      "latest_row.4 = {channel:String}",
      "latest_row.1 = {activity_id:UUID}",
      "latest_row.3 >= parseDateTime64BestEffort({recorded_at_start:String})",
      "latest_row.3 < parseDateTime64BestEffort({recorded_at_end:String})",
    ],
    accountFence: false,
  },
  {
    label: "non-null external ID",
    scope: { providerId: "fitbit", externalId: "measurement-1" },
    params: { provider_id: "fitbit", external_id: "measurement-1" },
    candidate: ["candidate_row.external_id = {external_id:String}"],
    latest: ["latest_row.6 = {external_id:String}"],
    accountFence: false,
  },
  {
    label: "account-wide",
    scope: { userId: "10000000-0000-4000-8000-000000000001" },
    params: { user_id: "10000000-0000-4000-8000-000000000001" },
    candidate: ["candidate_row.user_id = {user_id:UUID}"],
    latest: ["latest_row.2 = {user_id:UUID}"],
    accountFence: true,
  },
];

export function firstCommandQuery(command: CallableVitestMock): string {
  const call = command.mock.calls
    .map((args: unknown[]) => args[0])
    .find(
      (arg: unknown) =>
        typeof arg === "object" &&
        arg !== null &&
        "query" in arg &&
        typeof arg.query === "string" &&
        arg.query.startsWith(`INSERT INTO ${METRIC_STREAM_TABLE} (`),
    );
  if (!call || typeof call !== "object" || !("query" in call) || typeof call.query !== "string") {
    throw new Error("expected command call");
  }
  return call.query;
}

export function insertedValues(insert: CallableVitestMock, callIndex: number): unknown[] {
  const call = insert.mock.calls[callIndex]?.[0];
  if (!call || typeof call !== "object" || !("values" in call) || !Array.isArray(call.values)) {
    throw new Error("expected an insert call with row values");
  }
  return call.values;
}

export function expectMetricStreamInsert(
  insert: CallableVitestMock,
  values: unknown[],
  callIndex?: number,
) {
  const options = {
    table: METRIC_STREAM_TABLE,
    values,
    format: "JSONEachRow",
    clickhouse_settings: { date_time_input_format: "best_effort" },
  };
  if (callIndex === undefined) {
    expect(insert).toHaveBeenCalledWith(options);
  } else {
    expect(insert).toHaveBeenNthCalledWith(callIndex, options);
  }
}

export function expectDeletionAcknowledgementQuery(query: CallableVitestMock, eventIds: string[]) {
  expect(query).toHaveBeenCalledWith({
    query: expect.stringMatching(
      /SELECT event_id[\s\S]+metric_stream_delete_acknowledgement[\s\S]+Array\(UUID\)/,
    ),
    query_params: { event_ids: eventIds },
    format: "JSONEachRow",
  });
}

export function parseDeletionAcknowledgementInsert(query: string): string[] {
  const rows = query
    .split("\n")
    .slice(2)
    .map((row) => JSON.parse(row));
  return z
    .array(z.object({ event_id: z.uuid() }))
    .parse(rows)
    .map(({ event_id }) => event_id);
}

export function profileDeletionAcknowledgements(
  client: ClickHouseClient & ClickHouseMetricStreamInsertClient,
) {
  const readQueryIds: string[] = [];
  const writeQueryIds: string[] = [];
  const profiledClient: ClickHouseMetricStreamInsertClient = {
    command: (options) => {
      if (!options.query.includes(METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE)) {
        return client.command(options);
      }
      const queryId = randomUUID();
      writeQueryIds.push(queryId);
      return client.command({
        ...options,
        query_id: queryId,
        clickhouse_settings: { ...options.clickhouse_settings, log_queries: 1 },
      });
    },
    insert: (options) => client.insert(options),
    query: (options) => {
      if (!options.query.includes(METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE)) {
        return client.query(options);
      }
      const queryId = randomUUID();
      readQueryIds.push(queryId);
      return client.query({
        ...options,
        query_id: queryId,
        clickhouse_settings: { ...options.clickhouse_settings, log_queries: 1 },
      });
    },
  };
  return { client: profiledClient, readQueryIds, writeQueryIds };
}

export async function assertQueryFinishes(client: ClickHouseClient, queryIds: string[]) {
  expect(queryIds.length).toBeGreaterThan(0);
  await client.command({ query: "SYSTEM FLUSH LOGS" });
  const finished = await client.query({
    query: `SELECT query_id FROM system.query_log
      WHERE query_id IN {queryIds:Array(String)} AND type = 'QueryFinish'`,
    query_params: { queryIds },
    format: "JSONEachRow",
  });
  const rows = z.array(z.object({ query_id: z.string().min(1) })).parse(await finished.json());
  expect(rows).toHaveLength(queryIds.length);
  expect(new Set(rows.map(({ query_id }) => query_id))).toEqual(new Set(queryIds));
}

export async function expectDeletionReceiptIds(
  client: ClickHouseClient,
  eventIds: string[],
  expectedEventIds: string[],
) {
  const result = await client.query({
    query: `SELECT event_id
      FROM ${METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE}
      WHERE event_id IN {eventIds:Array(UUID)}`,
    query_params: { eventIds },
    format: "JSONEachRow",
  });
  const rows = z.array(z.object({ event_id: z.uuid() })).parse(await result.json());
  expect(rows.map(({ event_id }) => event_id).sort()).toEqual([...expectedEventIds].sort());
}

export async function expectMetricStreamDeleteState(
  client: ClickHouseClient,
  rowIds: string[],
  deletedRowIds: string[],
) {
  const result = await client.query({
    query: `SELECT id, is_deleted FROM ${METRIC_STREAM_TABLE} FINAL
      WHERE id IN {rowIds:Array(UUID)}`,
    query_params: { rowIds },
    format: "JSONEachRow",
  });
  const rows = z
    .array(z.object({ id: z.string(), is_deleted: z.coerce.number() }))
    .parse(await result.json());
  const deleted = new Set(deletedRowIds);
  expect(rows.sort((a, b) => a.id.localeCompare(b.id))).toEqual(
    rowIds
      .map((id) => ({ id, is_deleted: deleted.has(id) ? 1 : 0 }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}
