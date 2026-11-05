import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { fenceClickHouseAccount } from "../account-erasure/clickhouse-erasure.ts";
import {
  analyticsDeliveryGroupIngestionTimes,
  analyticsDeliveryGroupIntentId,
  describeAnalyticsDeliveryGroup,
} from "../analytics/analytics-delivery-group.ts";
import {
  ANALYTICS_PUBLICATION_RESOURCE,
  withAnalyticsQueryOwner,
} from "../analytics/analytics-query-owner.ts";
import {
  beginAnalyticsDeliveryGroup,
  claimAnalyticsStream,
  loadAnalyticsStreamState,
} from "../analytics/analytics-work-store.ts";
import { analyticsPosition } from "../analytics/test-helpers.ts";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { mapMetricStreamEventToClickHouseRow } from "./clickhouse-row.ts";
import {
  applyMetricStreamEventsToClickHouse,
  type ClickHouseMetricStreamInsertClient,
} from "./clickhouse-sink.ts";
import {
  ACCOUNT_ERASURE_FENCE_TABLE,
  METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE,
  METRIC_STREAM_DELETE_SCOPE_TABLE,
  METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE,
  METRIC_STREAM_TABLE,
} from "./clickhouse-table.ts";
import {
  createMetricStreamBatchCompletedEvent,
  createMetricStreamDeletedEvent,
  createMetricStreamDeletePartitionKey,
  createMetricStreamEvent,
  type MetricStreamDeleteScopeInput,
  type MetricStreamRedpandaEvent,
  type MetricStreamRowInput,
  metricStreamDeletedEventV1Schema,
  metricStreamEventV1Schema,
} from "./events.ts";
import { createMetricStreamAnalyticsTestContext } from "./test-helpers.ts";
import type { MetricStreamPosition } from "./transport-position.ts";

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

describe("metric stream ClickHouse sink (integration)", () => {
  let context: Awaited<ReturnType<typeof createMetricStreamAnalyticsTestContext>>;
  let client: ClickHouseClient & ClickHouseMetricStreamInsertClient;
  let nextEntry = 1n;
  async function applyEvents(
    target: ClickHouseClient,
    events: readonly MetricStreamRedpandaEvent[],
  ) {
    const positions = events.map(() => analyticsPosition(context.stream, nextEntry++));
    return applyMetricStreamEventsToClickHouse(
      target,
      events,
      {
        topic: context.stream.topic,
        partition: -1,
        positions,
        assertActive: async () => undefined,
      },
      context.database,
    );
  }

  async function applyLegacyScope(scope: MetricStreamDeleteScopeInput) {
    await applyEvents(client, [
      metricStreamDeletedEventV1Schema.parse({
        version: 1,
        eventType: "metric_stream_deleted",
        scope,
        partitionKey: createMetricStreamDeletePartitionKey(scope),
      }),
    ]);
  }

  async function seedPostgresFence(
    userId: string,
    kind: "active request" | "completed retained hash",
  ) {
    const requestId = randomUUID();
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const completed = kind === "completed retained hash";
    if (!completed)
      await context.database.execute(
        sql`INSERT INTO fitness.user_profile(id,name) VALUES (${userId}::uuid,'Fence fixture')`,
      );
    await context.database.execute(sql`INSERT INTO fitness.account_erasure_request
      (id,user_id,user_hash,user_hash_key_id,write_fence_hash,status_token_hash,status,
        replay_retained_until,completion_deadline,pii_scrubbed_at,completed_at)
      VALUES (${requestId}::uuid,${completed ? null : userId}::uuid,${digest(requestId)},'test-v1',
        ${digest(userId)},${digest(randomUUID())},${completed ? "completed" : "pending"},
        now()+interval '7 days',now()+interval '30 days',
        ${completed ? sql`now()` : sql`NULL`},${completed ? sql`now()` : sql`NULL`})`);
  }

  async function admitPendingGroup(positions: readonly MetricStreamPosition[]) {
    const descriptor = describeAnalyticsDeliveryGroup(positions, 500);
    let times: readonly string[] = [];
    await withAnalyticsQueryOwner(
      context.database,
      client,
      {
        resourceId: ANALYTICS_PUBLICATION_RESOURCE,
        intentId: analyticsDeliveryGroupIntentId(descriptor),
      },
      async (owner) => {
        const ownerId = randomUUID();
        times = analyticsDeliveryGroupIngestionTimes(owner.ingestedAt, positions.length);
        const through = times.at(-1);
        if (!through) throw new Error("Fixture reservation is empty");
        await claimAnalyticsStream(context.database, {
          stream: descriptor.stream,
          ownerId,
          expectedOwnerId: null,
        });
        await beginAnalyticsDeliveryGroup(context.database, {
          stream: descriptor.stream,
          ownerId,
          positions,
          maximum: 500,
          expected: null,
          ingestedAt: owner.ingestedAt,
        });
        await owner.reserveIngestionThrough(through);
      },
    );
    return { descriptor, times };
  }

  beforeAll(async () => {
    context = await createMetricStreamAnalyticsTestContext();
    client = context.client;
    assertInsertCapable(client);
  }, 120_000);

  afterAll(async () => {
    if (context) await context.cleanup();
  });

  it("preserves newer live V0 through older pending replay and forced merge", async () => {
    const historyStream = {
      ...context.stream,
      epoch: randomUUID(),
      topic: `persistent://public/default/history-${randomUUID()}`,
    };
    const position = analyticsPosition(historyStream, 1n);
    const old = metricStreamEventV1Schema.parse({
      version: 1,
      id: randomUUID(),
      userId: testUserId,
      providerId: "raw-replay",
      generation: 0,
      sourceType: "sensor",
      channel: "heart_rate",
      activityId: null,
      recordedAt: "2026-11-05T01:00:00.123456789Z",
      scalar: 70,
    });
    let reserved = "";
    const descriptor = describeAnalyticsDeliveryGroup([position], 1);
    await withAnalyticsQueryOwner(
      context.database,
      client,
      {
        resourceId: ANALYTICS_PUBLICATION_RESOURCE,
        intentId: analyticsDeliveryGroupIntentId(descriptor),
      },
      async (owner) => {
        const ownerId = randomUUID();
        reserved = owner.ingestedAt;
        await claimAnalyticsStream(context.database, {
          stream: historyStream,
          ownerId,
          expectedOwnerId: null,
        });
        await beginAnalyticsDeliveryGroup(context.database, {
          stream: historyStream,
          ownerId,
          positions: [position],
          maximum: 1,
          expected: null,
          ingestedAt: reserved,
        });
        await owner.reserveIngestionThrough(reserved);
        if (!owner.client.insert) throw new Error("Fixture requires insert");
        const row = mapMetricStreamEventToClickHouseRow(old, reserved);
        await owner.client.insert({
          table: METRIC_STREAM_TABLE,
          values: [{ ...row, point: row.point ?? "" }],
          format: "JSONEachRow",
          clickhouse_settings: { date_time_input_format: "best_effort" },
        });
      },
    );
    await applyEvents(client, [{ ...old, scalar: 90 }]);
    const inserted = await applyMetricStreamEventsToClickHouse(
      client,
      [old],
      {
        topic: historyStream.topic,
        partition: -1,
        positions: [position],
        assertActive: async () => undefined,
      },
      context.database,
    );
    const read = async () => {
      const result = await client.query({
        query: `SELECT scalar,is_deleted,toString(version) AS version FROM ${METRIC_STREAM_TABLE} FINAL WHERE id={id:UUID}`,
        query_params: { id: old.id },
        format: "JSONEachRow",
      });
      return result.json();
    };
    const beforeMerge = await read();
    await client.command({ query: `OPTIMIZE TABLE ${METRIC_STREAM_TABLE} FINAL` });
    expect(beforeMerge).toEqual([{ scalar: 90, is_deleted: 0, version: "0" }]);
    expect(inserted).toBe(0);
    expect(await read()).toEqual(beforeMerge);
    const state = await loadAnalyticsStreamState(context.database, historyStream);
    expect(state).toMatchObject({
      processed: position,
      pending: null,
      completedGroup: { ingestedAt: reserved },
    });
  }, 30_000);

  it.each([
    "identical payload",
    "newer tombstone",
    "greater version",
    "equal-time conflict",
    "moved ID",
    "older timestamp",
  ])(
    "current-key guard preserves %s",
    async (kind) => {
      const stream = {
        ...context.stream,
        epoch: randomUUID(),
        topic: `persistent://public/default/key-${randomUUID()}`,
      };
      const position = analyticsPosition(stream, 1n);
      const event = metricStreamEventV1Schema.parse({
        version: 1,
        id: randomUUID(),
        userId: testUserId,
        providerId: "raw-current-key",
        generation: 0,
        sourceType: "sensor",
        channel: "heart_rate",
        activityId: null,
        recordedAt: "2026-11-05T01:00:00.123456789Z",
        scalar: kind === "identical payload" ? 72.1 : 72,
        vector: [0.1, 1.25],
        metadata: { source: "stable" },
      });
      const descriptor = describeAnalyticsDeliveryGroup([position], 1);
      let reserved = "";
      await withAnalyticsQueryOwner(
        context.database,
        client,
        {
          resourceId: ANALYTICS_PUBLICATION_RESOURCE,
          intentId: analyticsDeliveryGroupIntentId(descriptor),
        },
        async (owner) => {
          reserved = owner.ingestedAt;
          const ownerId = randomUUID();
          await claimAnalyticsStream(context.database, { stream, ownerId, expectedOwnerId: null });
          await beginAnalyticsDeliveryGroup(context.database, {
            stream,
            ownerId,
            positions: [position],
            maximum: 1,
            expected: null,
            ingestedAt: reserved,
          });
          await owner.reserveIngestionThrough(reserved);
          if (!owner.client.insert) throw new Error("Fixture requires insert");
          const row = mapMetricStreamEventToClickHouseRow(event, reserved);
          await owner.client.insert({
            table: METRIC_STREAM_TABLE,
            format: "JSONEachRow",
            values: [
              {
                ...row,
                point: row.point ?? "",
                ...(kind === "newer tombstone"
                  ? { is_deleted: 1, ingested_at: `${reserved.slice(0, -1)}001Z` }
                  : {}),
                ...(kind === "greater version"
                  ? { version: "9007199254740993", ingested_at: "2020-01-01T00:00:00.123456789Z" }
                  : {}),
                ...(kind === "equal-time conflict" ? { scalar: 90 } : {}),
                ...(kind === "moved ID" ? { activity_id: randomUUID() } : {}),
                ...(kind === "older timestamp"
                  ? { scalar: 60, ingested_at: "2020-01-01T00:00:00.123456789Z" }
                  : {}),
              },
            ],
            clickhouse_settings: { date_time_input_format: "best_effort" },
          });
        },
      );
      const apply = () =>
        applyMetricStreamEventsToClickHouse(
          client,
          [event],
          {
            topic: stream.topic,
            partition: -1,
            positions: [position],
            assertActive: async () => undefined,
          },
          context.database,
        );
      if (kind === "equal-time conflict") {
        await expect(apply()).rejects.toThrow(/conflicting.*payload/i);
        expect(await loadAnalyticsStreamState(context.database, stream)).toMatchObject({
          processed: null,
          pending: position,
          pendingGroup: { ingestedAt: reserved },
        });
      } else {
        expect(await apply()).toBe(kind === "moved ID" || kind === "older timestamp" ? 1 : 0);
        expect(await loadAnalyticsStreamState(context.database, stream)).toMatchObject({
          processed: position,
          pending: null,
          completedGroup: { ingestedAt: reserved },
        });
      }
      const raw = await client.query({
        query: `SELECT count() AS count FROM ${METRIC_STREAM_TABLE} WHERE id={id:UUID}`,
        query_params: { id: event.id },
        format: "JSONEachRow",
      });
      expect(await raw.json()).toEqual([
        { count: kind === "moved ID" || kind === "older timestamp" ? 2 : 1 },
      ]);
      const current = await client.query({
        query: `SELECT is_deleted,toString(version) AS version FROM ${METRIC_STREAM_TABLE} FINAL WHERE id={id:UUID}`,
        query_params: { id: event.id },
        format: "JSONEachRow",
      });
      const expected =
        kind === "greater version"
          ? { is_deleted: 0, version: "9007199254740993" }
          : { is_deleted: kind === "newer tombstone" ? 1 : 0, version: "0" };
      expect(await current.json()).toEqual(kind === "moved ID" ? [expected, expected] : [expected]);
    },
    30_000,
  );

  it.each(["active request", "completed retained hash"] as const)(
    "replays a mixed pending group behind a PG %s before its CH fence",
    async (kind) => {
      const userA = randomUUID(),
        userB = randomUUID();
      const stream = {
        ...context.stream,
        epoch: randomUUID(),
        topic: `persistent://public/default/fenced-${randomUUID()}`,
      };
      const events = [userA, userB].map((userId, index) =>
        createCurrentMetricStreamEvent({
          id: randomUUID(),
          userId,
          providerId: "mixed-pg-fence",
          sourceType: "sensor",
          channel: "heart_rate",
          recordedAt: "2026-11-05T01:00:00.123456Z",
          scalar: 70 + index,
        }),
      );
      const positions = [1n, 2n].map((entry) => analyticsPosition(stream, entry));
      const pending = await admitPendingGroup(positions);
      await seedPostgresFence(userA, kind);
      let laterAdmission = "";
      await withAnalyticsQueryOwner(
        context.database,
        client,
        {
          resourceId: ANALYTICS_PUBLICATION_RESOURCE,
          intentId: `fixture:${randomUUID()}`,
        },
        async (owner) => {
          laterAdmission = owner.ingestedAt;
          await owner.reserveIngestionThrough(owner.ingestedAt);
        },
      );
      const lastSlot = pending.times.at(-1);
      if (!lastSlot) throw new Error("Fixture has no final reservation slot");
      expect(laterAdmission > lastSlot).toBe(true);
      const hash = createHash("sha256").update(userA).digest("hex");
      const fence = await client.query({
        query: `SELECT count() AS count FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL WHERE user_hash={hash:String}`,
        query_params: { hash },
        format: "JSONEachRow",
      });
      expect(await fence.json()).toEqual([{ count: 0 }]);
      let rawRequests = 0;
      const observed: ClickHouseClient = {
        ...client,
        exec: async (options) => {
          rawRequests++;
          return client.exec(options);
        },
      };
      const batch = {
        topic: stream.topic,
        partition: -1,
        positions,
        assertActive: async () => undefined,
      };
      expect(
        await applyMetricStreamEventsToClickHouse(observed, events, batch, context.database),
      ).toBe(1);
      expect(rawRequests).toBe(1);
      const raw = await client.query({
        query: `SELECT source.id,source.scalar,source.is_deleted,
          source.ingested_at=parseDateTime64BestEffort({expected:String},9) AS exact_time
          FROM ${METRIC_STREAM_TABLE} AS source WHERE source.id IN {ids:Array(UUID)}`,
        query_params: { ids: events.map((event) => event.id), expected: pending.times[1] },
        format: "JSONEachRow",
      });
      expect(await raw.json()).toEqual([
        { id: events[1]?.id, scalar: 71, is_deleted: 0, exact_time: 1 },
      ]);
      expect(await loadAnalyticsStreamState(context.database, stream)).toMatchObject({
        processed: positions[1],
        pending: null,
        completedGroup: {
          memberCount: 2,
          positionsDigest: pending.descriptor.positionsDigest,
          ingestedAt: pending.times[0],
        },
      });
      expect(
        await applyMetricStreamEventsToClickHouse(observed, events, batch, context.database),
      ).toBe(0);
      expect(rawRequests).toBe(1);
      const count = await client.query({
        query: `SELECT count() AS count FROM ${METRIC_STREAM_TABLE} WHERE id IN {ids:Array(UUID)}`,
        query_params: { ids: events.map((event) => event.id) },
        format: "JSONEachRow",
      });
      expect(await count.json()).toEqual([{ count: 1 }]);
    },
    30_000,
  );

  it("completes an all-PG-fenced pending group without a raw INSERT", async () => {
    const users = [randomUUID(), randomUUID()];
    const stream = {
      ...context.stream,
      epoch: randomUUID(),
      topic: `persistent://public/default/all-fenced-${randomUUID()}`,
    };
    const events = users.map((userId) =>
      createCurrentMetricStreamEvent({
        id: randomUUID(),
        userId,
        providerId: "all-pg-fenced",
        sourceType: "sensor",
        channel: "heart_rate",
        recordedAt: "2026-11-05T01:00:00.123456Z",
        scalar: 72,
      }),
    );
    const positions = [1n, 2n].map((entry) => analyticsPosition(stream, entry));
    const pending = await admitPendingGroup(positions);
    const first = users[0],
      second = users[1];
    if (!first || !second) throw new Error("Fixture users missing");
    await seedPostgresFence(first, "active request");
    await seedPostgresFence(second, "completed retained hash");
    let rawRequests = 0;
    const observed: ClickHouseClient = {
      ...client,
      exec: async (options) => {
        rawRequests++;
        return client.exec(options);
      },
    };
    const batch = {
      topic: stream.topic,
      partition: -1,
      positions,
      assertActive: async () => undefined,
    };
    expect(
      await applyMetricStreamEventsToClickHouse(observed, events, batch, context.database),
    ).toBe(0);
    expect(rawRequests).toBe(0);
    const raw = await client.query({
      query: `SELECT count() AS count FROM ${METRIC_STREAM_TABLE} WHERE id IN {ids:Array(UUID)}`,
      query_params: { ids: events.map((event) => event.id) },
      format: "JSONEachRow",
    });
    expect(await raw.json()).toEqual([{ count: 0 }]);
    expect(await loadAnalyticsStreamState(context.database, stream)).toMatchObject({
      processed: positions[1],
      pending: null,
      completedGroup: {
        memberCount: 2,
        positionsDigest: pending.descriptor.positionsDigest,
        ingestedAt: pending.times[0],
      },
    });
  }, 30_000);

  it("excludes a CH-fenced account from a provider-only delete while deleting its active peer", async () => {
    const userA = randomUUID(),
      userB = randomUUID(),
      providerId = `provider-fence-${randomUUID()}`;
    const events = [userA, userB].map((userId) =>
      createCurrentMetricStreamEvent(
        {
          id: randomUUID(),
          userId,
          providerId,
          sourceType: "sensor",
          channel: "heart_rate",
          recordedAt: "2026-11-05T01:00:00.123456Z",
          scalar: 72,
        },
        "1000000000000200",
      ),
    );
    expect(await applyEvents(client, events)).toBe(2);
    await withAnalyticsQueryOwner(
      context.database,
      client,
      {
        resourceId: ANALYTICS_PUBLICATION_RESOURCE,
        intentId: `fixture:${randomUUID()}`,
      },
      (owner) => fenceClickHouseAccount(owner.client, userA, []),
    );
    const deletion = createCurrentMetricStreamDeletedEvent({ providerId }, "1000000000000201");
    expect(await applyEvents(client, [deletion])).toBe(0);
    const history = await client.query({
      query: `SELECT toString(user_id) AS user_id,count() AS count FROM ${METRIC_STREAM_TABLE} WHERE provider_id={provider:String} GROUP BY user_id ORDER BY toString(user_id)`,
      query_params: { provider: providerId },
      format: "JSONEachRow",
    });
    expect(await history.json()).toEqual(
      [
        { user_id: userA, count: 1 },
        { user_id: userB, count: 2 },
      ].sort((left, right) => left.user_id.localeCompare(right.user_id)),
    );
    const raw = await client.query({
      query: `SELECT toString(user_id) AS user_id,is_deleted,toString(version) AS version FROM ${METRIC_STREAM_TABLE} FINAL WHERE provider_id={provider:String} ORDER BY toString(user_id)`,
      query_params: { provider: providerId },
      format: "JSONEachRow",
    });
    expect(await raw.json()).toEqual(
      [
        { user_id: userA, is_deleted: 0, version: "2000000000000401" },
        { user_id: userB, is_deleted: 1, version: "2000000000000402" },
      ].sort((left, right) => left.user_id.localeCompare(right.user_id)),
    );
  }, 30_000);

  it("rejects conflicting physical payload ties at the current rank", async () => {
    const stream = {
      ...context.stream,
      epoch: randomUUID(),
      topic: `persistent://public/default/tied-${randomUUID()}`,
    };
    const position = analyticsPosition(stream, 1n);
    const event = metricStreamEventV1Schema.parse({
      version: 1,
      id: randomUUID(),
      userId: testUserId,
      providerId: "physical-tie",
      generation: 0,
      sourceType: "sensor",
      channel: "heart_rate",
      activityId: null,
      recordedAt: "2026-11-05T01:00:00.123456Z",
      scalar: 72,
    });
    const pending = await admitPendingGroup([position]);
    const reserved = pending.times[0];
    if (!reserved) throw new Error("Fixture reservation missing");
    await client.command({ query: `SYSTEM STOP MERGES ${METRIC_STREAM_TABLE}` });
    try {
      await withAnalyticsQueryOwner(
        context.database,
        client,
        {
          resourceId: ANALYTICS_PUBLICATION_RESOURCE,
          intentId: analyticsDeliveryGroupIntentId(pending.descriptor),
        },
        async (owner) => {
          await owner.reuseIngestionReservation({
            ...pending.descriptor,
            ingestedAt: reserved,
            intentId: analyticsDeliveryGroupIntentId(pending.descriptor),
          });
          if (!owner.client.insert) throw new Error("Fixture requires insert");
          const row = mapMetricStreamEventToClickHouseRow(event, reserved);
          await owner.client.insert({
            table: METRIC_STREAM_TABLE,
            format: "JSONEachRow",
            values: [
              { ...row, point: row.point ?? "" },
              { ...row, point: row.point ?? "", scalar: 90 },
            ],
            clickhouse_settings: {
              date_time_input_format: "best_effort",
              // Keep both same-rank physical rows; STOP MERGES does not disable insert merges.
              optimize_on_insert: 0,
              insert_deduplicate: 0,
            },
          });
        },
      );
      await expect(
        applyMetricStreamEventsToClickHouse(
          client,
          [event],
          {
            topic: stream.topic,
            partition: -1,
            positions: [position],
            assertActive: async () => undefined,
          },
          context.database,
        ),
      ).rejects.toThrow(/conflicting.*payload/i);
      const raw = await client.query({
        query: `SELECT count() AS count FROM ${METRIC_STREAM_TABLE} WHERE id={id:UUID}`,
        query_params: { id: event.id },
        format: "JSONEachRow",
      });
      expect(await raw.json()).toEqual([{ count: 2 }]);
      expect(await loadAnalyticsStreamState(context.database, stream)).toMatchObject({
        processed: null,
        pending: position,
        pendingGroup: { ingestedAt: reserved },
      });
    } finally {
      await client.command({ query: `SYSTEM START MERGES ${METRIC_STREAM_TABLE}` });
    }
  }, 30_000);

  it.each([1, 500])(
    "finite native group %s preserves raw rows and exact PG frontier",
    async (count) => {
      const events = Array.from({ length: count }, (_value, index) =>
        createCurrentMetricStreamEvent({
          id: randomUUID(),
          userId: testUserId,
          providerId: "native-group-fixture",
          externalId: `sample-${index}-${count}`,
          sourceType: "sensor",
          channel: "heart_rate",
          recordedAt: new Date(Date.UTC(2026, 10, 3) + index * 1000).toISOString(),
          scalar: 70 + (index % 5),
          metadata: { device: "fixture", source: "native sink" },
        }),
      );
      const positions = events.map(() => analyticsPosition(context.stream, nextEntry++));
      const batch = {
        topic: context.stream.topic,
        partition: -1,
        positions,
        assertActive: async () => undefined,
      };
      expect(
        await applyMetricStreamEventsToClickHouse(client, events, batch, context.database),
      ).toBe(count);
      const state = await loadAnalyticsStreamState(context.database, context.stream);
      expect(state?.processed).toEqual(positions.at(-1));
      expect(state?.pending).toBeNull();
      expect(state?.completedGroup).toMatchObject({
        memberCount: count,
        first: positions[0],
        last: positions.at(-1),
      });
      const raw = await client.query({
        query: `SELECT id,scalar,metadata FROM ${METRIC_STREAM_TABLE} FINAL WHERE id IN {ids:Array(UUID)} ORDER BY toString(id)`,
        query_params: { ids: events.map((event) => event.id) },
        format: "JSONEachRow",
      });
      const rows = z
        .array(z.object({ id: z.string(), scalar: z.number(), metadata: z.string() }))
        .parse(await raw.json());
      expect(rows).toEqual(
        events
          .map((event) => ({
            id: event.id,
            scalar: event.scalar,
            metadata: JSON.stringify(event.metadata),
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      );
    },
  );

  it("finite native delete and marker recover completed redelivery without repeating raw mutation", async () => {
    const event = createCurrentMetricStreamEvent({
      id: randomUUID(),
      userId: testUserId,
      providerId: "native-control-fixture",
      externalId: "source",
      sourceType: "sensor",
      channel: "heart_rate",
      scalar: 72,
      recordedAt: "2026-11-03T01:00:00.000Z",
    });
    await applyEvents(client, [event]);
    const deletion = createCurrentMetricStreamDeletedEvent(
      { userId: testUserId, providerId: event.providerId, externalId: "source" },
      "1000000000000010",
    );
    const marker = createMetricStreamBatchCompletedEvent(
      { operationId: randomUUID(), batchId: randomUUID(), datasetKeys: ["metric_stream"] },
      1,
    );
    const events = [deletion, marker];
    const positions = events.map(() => analyticsPosition(context.stream, nextEntry++));
    const batch = {
      topic: context.stream.topic,
      partition: -1,
      positions,
      assertActive: async () => undefined,
    };
    await applyMetricStreamEventsToClickHouse(client, events, batch, context.database);
    const versions = async () => {
      const result = await client.query({
        query: `SELECT count() AS count FROM ${METRIC_STREAM_TABLE} WHERE id={id:UUID}`,
        query_params: { id: event.id },
        format: "JSONEachRow",
      });
      return z.array(z.object({ count: z.coerce.number() })).parse(await result.json());
    };
    const originalVersions = await versions();
    await applyMetricStreamEventsToClickHouse(client, events, batch, context.database);
    expect(await versions()).toEqual(originalVersions);
    const raw = await client.query({
      query: `SELECT is_deleted FROM ${METRIC_STREAM_TABLE} FINAL WHERE id={id:UUID}`,
      query_params: { id: event.id },
      format: "JSONEachRow",
    });
    expect(z.array(z.object({ is_deleted: z.number() })).parse(await raw.json())).toEqual([
      { is_deleted: 1 },
    ]);
    const acknowledgement = await client.query({
      query: `SELECT marker_offset,marker_transport,marker_epoch,marker_message_id FROM ${METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE} FINAL WHERE operation_id={operation:UUID} AND batch_id={batch:String}`,
      query_params: { operation: marker.operationId, batch: marker.batchId },
      format: "JSONEachRow",
    });
    expect(await acknowledgement.json()).toEqual([
      {
        marker_offset: null,
        marker_transport: "pulsar",
        marker_epoch: context.stream.epoch,
        marker_message_id: positions[1]?.serializedMessageId,
      },
    ]);
    const state = await loadAnalyticsStreamState(context.database, context.stream);
    expect(state?.processed).toEqual(positions[1]);
    expect(state?.pending).toBeNull();
  });

  it("retains Zepp vectors and units, distinct same-millisecond records, and deduplicated retries", async () => {
    await applyEvents(client, zeppSamples);
    await applyEvents(client, zeppSamples);

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

    await applyEvents(client, [event]);

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
      await applyEvents(client, [...clamped, ...raw]);
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
    await applyEvents(client, [event, event, event, event]);

    await applyLegacyScope({
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
    // Controls without a revision intentionally retain main's current-row semantics.
    const newer = createCurrentMetricStreamEvent(
      {
        id: event.id,
        recordedAt: event.recordedAt,
        userId: event.userId,
        providerId: event.providerId,
        externalId: event.externalId,
        sourceType: event.sourceType,
        channel: event.channel,
        scalar: 85,
      },
      "1000000000000010",
    );
    await applyEvents(client, [newer]);
    await applyLegacyScope({ userId: testUserId, providerId: "withings" });
    const repeated = await client.query({
      query: `SELECT is_deleted,toString(version) AS version FROM ${METRIC_STREAM_TABLE} FINAL WHERE id={id:UUID}`,
      query_params: { id: testEventId },
      format: "JSONEachRow",
    });
    expect(await repeated.json()).toEqual([{ is_deleted: 1, version: "2000000000000022" }]);
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
        ...mapMetricStreamEventToClickHouseRow(matchingEvent, "2026-06-08T14:36:12.000Z"),
        ingested_at: "2026-06-08T14:36:12.000Z",
        version: 1,
      };
      const latestRow = {
        ...mapMetricStreamEventToClickHouseRow(latestEvent, "2026-06-08T14:36:13.000Z"),
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

      await applyLegacyScope({
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
    await applyEvents(client, [event]);

    await applyLegacyScope({
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
    await applyEvents(client, [
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

    await applyEvents(client, [firstDelete, secondDelete]);

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
    await applyEvents(client, [initialEvent]);

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

    await applyEvents(client, [
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
    } satisfies Omit<MetricStreamRowInput, "scalar">;
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

    await applyEvents(client, [historyDelete, historyReplacement]);
    expect(await readCurrentRow()).toEqual([
      { is_deleted: 0, scalar: 70, version: "2000000000000003" },
    ]);

    await applyEvents(client, [liveDelete, liveReplacement]);
    expect(await readCurrentRow()).toEqual([
      { is_deleted: 0, scalar: 75, version: "2000000000000007" },
    ]);

    await applyEvents(client, [lateHistoryDelete, lateHistoryReplacement]);
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
      await applyEvents(client, [createCurrentMetricStreamDeletedEvent(scope, "103"), liveA]);
      await applyEvents(client, [
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
    const profiledClient: ClickHouseClient = {
      exec: (options) => client.exec(options),
      command: (options) => client.command(options),
      insert: (options) => client.insert(options),
      query: (options) => {
        const queryId = options.query_id ?? randomUUID();
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

      await applyEvents(profiledClient, rows);
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

  it("retains the legacy zero revision when pruning scopes for mixed V1 and V2 rows", async () => {
    const userId = randomUUID();
    const scope = { userId, providerId: "legacy-mixed-revision-test" };
    const row = {
      ...scope,
      recordedAt: "2026-06-11T14:36:12.000Z",
      sourceType: "api",
      channel: "heart_rate",
      scalar: 75,
    };
    await applyEvents(client, [
      createCurrentMetricStreamDeletedEvent(scope, "10"),
      createCurrentMetricStreamEvent({ ...row, externalId: "current" }, "20"),
      { ...row, id: randomUUID(), generation: 0, version: 1, externalId: "legacy" },
    ]);
    const result = await client.query({
      query: `SELECT external_id,is_deleted,toString(version) AS version
        FROM ${METRIC_STREAM_TABLE} FINAL WHERE user_id={userId:UUID} ORDER BY external_id`,
      query_params: { userId },
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      { external_id: "current", is_deleted: 0, version: "41" },
      { external_id: "legacy", is_deleted: 1, version: "20" },
    ]);
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
      await applyEvents(client, [
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

  it("applies individual native delete controls before their replacement row", async () => {
    const ids = longDeleteTestEventIds;
    const scopeIndexes = [0, 100, 349];
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
    await applyEvents(client, rows);
    const revision = "1000000000000003";
    const deletes = [0, 100, 349, 350].map((index) =>
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
        externalId: "bounded-delete-349",
        sourceType: "file",
        channel: "heart_rate",
        scalar: 99,
      },
      revision,
    );

    let httpCalls = 0;
    const measuredClient: ClickHouseClient = {
      exec: (options) => {
        httpCalls++;
        return client.exec(options);
      },
      command: (options) => {
        httpCalls++;
        return client.command(options);
      },
      insert: (options) => {
        httpCalls++;
        return client.insert(options);
      },
      query: (options) => {
        httpCalls++;
        return client.query(options);
      },
    };
    const positions = deletes.map(() => analyticsPosition(context.stream, nextEntry++));
    const startedAt = performance.now();
    for (const [index, deletion] of deletes.entries()) {
      const position = positions[index];
      if (!position) throw new Error("Native control fixture position missing");
      await applyMetricStreamEventsToClickHouse(
        measuredClient,
        [deletion],
        {
          topic: context.stream.topic,
          partition: -1,
          positions: [position],
          assertActive: async () => undefined,
        },
        context.database,
      );
    }
    process.stdout.write(
      `${JSON.stringify({
        event: "native-control-fixture",
        controls: deletes.length,
        elapsedMs: performance.now() - startedAt,
        httpCalls,
      })}\n`,
    );
    await applyEvents(client, [replacement]);

    const result = await client.query({
      query: `SELECT external_id, is_deleted, scalar, toString(version) AS version FROM ${METRIC_STREAM_TABLE} FINAL
        WHERE id IN {ids:Array(UUID)} ORDER BY external_id`,
      query_params: { ids },
      format: "JSONEachRow",
    });
    const rowsSchema = z.array(
      z.object({
        external_id: z.string(),
        is_deleted: z.number(),
        scalar: z.number(),
        version: z.string(),
      }),
    );
    expect(rowsSchema.parse(await result.json())).toEqual([
      { external_id: "bounded-delete-0", is_deleted: 1, scalar: 94, version: "2000000000000006" },
      { external_id: "bounded-delete-100", is_deleted: 1, scalar: 94, version: "2000000000000006" },
      { external_id: "bounded-delete-349", is_deleted: 0, scalar: 99, version: "2000000000000007" },
    ]);
    const acknowledgements = await client.query({
      query: `SELECT count() AS count FROM ${METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE} FINAL
        WHERE event_id IN {ids:Array(UUID)}`,
      query_params: { ids: deletes.map((event) => event.eventId) },
      format: "JSONEachRow",
    });
    const countSchema = z.array(z.object({ count: z.coerce.number() }));
    expect(countSchema.parse(await acknowledgements.json())).toEqual([{ count: 4 }]);
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
      await applyEvents(client, [createCurrentMetricStreamDeletedEvent(scope, newerRevision)]);
      await applyEvents(client, fixtures);
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

    await applyEvents(client, [deletedEvent]);

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
