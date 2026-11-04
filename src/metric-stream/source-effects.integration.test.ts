import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { withAnalyticsQueryOwner } from "../analytics/analytics-query-owner.ts";
import type { AnalyticsEffect } from "../analytics/effect-journal.ts";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { createMetricStreamEvent } from "./events.ts";
import {
  applyMetricStreamSourceEffects,
  prepareMetricStreamSourceEffects,
} from "./source-effects.ts";
import { createMetricStreamAnalyticsTestContext } from "./test-helpers.ts";

describe("raw metric input", () => {
  let context: Awaited<ReturnType<typeof createMetricStreamAnalyticsTestContext>>;
  beforeAll(async () => {
    context = await createMetricStreamAnalyticsTestContext();
    await context.client.command({
      query: `INSERT INTO ingest.provider_data_generation (user_id,provider_id,generation)
        SELECT generateUUIDv4(),concat('unrelated-',toString(number)),99 FROM numbers(20000)`,
    });
  });
  afterAll(async () => {
    await context?.cleanup();
  });

  function event() {
    return createMetricStreamEvent(
      {
        id: randomUUID(),
        userId: randomUUID(),
        providerId: `raw-private-${randomUUID()}`,
        recordedAt: "2026-11-03T02:00:00.123456789+02:00",
        channel: "heart_rate",
        scalar: 73.123456789,
        vector: [0.1, -123.987654321],
        point: "SRID=4326;POINT(-122.1234567 37.7654321)",
        sourceType: "api",
        metadata: { opaque: 'analytics.secret ingest.secret Unicode 水 "quoted"\nnew line' },
      },
      "4503599627370497",
    );
  }

  async function apply(
    row: ReturnType<typeof event>,
    change?: (effects: AnalyticsEffect[]) => Promise<void>,
  ) {
    const queryIds: string[] = [];
    let insertQuery = "";
    let insertParams: Record<string, unknown> | undefined;
    const client: ClickHouseClient = {
      ...context.client,
      command: (options) => {
        if (options.query.startsWith("INSERT INTO ingest.metric_stream (")) {
          if (!options.query_id) throw new Error("Missing owned query ID");
          queryIds.push(options.query_id);
          insertQuery = options.query;
          insertParams = options.query_params;
        }
        return context.client.command(options);
      },
    };
    let ingestedAt = "";
    await withAnalyticsQueryOwner(
      context.database,
      client,
      { resourceId: randomUUID(), intentId: randomUUID() },
      async (owner) => {
        ingestedAt = owner.ingestedAt;
        const effects: AnalyticsEffect[] = [];
        const position = {
          transport: "kafka" as const,
          epoch: randomUUID(),
          topic: "raw-input",
          partition: 0,
          offset: "1",
        };
        for await (const page of prepareMetricStreamSourceEffects(owner, row, position))
          effects.push(...page);
        if (change) await change(effects);
        await applyMetricStreamSourceEffects(owner, row, effects);
      },
    );
    return { queryIds, ingestedAt, insertQuery, insertParams };
  }

  test("raw input payload stays out of retained owned INSERT text while identity remains visible", async () => {
    const row = event();
    const { queryIds, ingestedAt } = await apply(row);
    expect(queryIds).toHaveLength(1);
    const stored = await context.client.query<{ matches: number }>({
      query: `SELECT toUInt8(activity_id IS NULL AND external_id IS NULL AND device_id IS NULL
        AND scalar=toFloat32(73.123456789) AND vector=[toFloat32(0.1),toFloat32(-123.987654321)]
        AND recorded_at=parseDateTime64BestEffort({recorded:String},6)
        AND ingested_at=parseDateTime64BestEffort({ingested:String},9)
        AND version=9007199254740995 AND generation=0 AND is_deleted=0
        AND point={point:String} AND metadata={metadata:String}) AS matches
        FROM ingest.metric_stream WHERE id={id:UUID}`,
      query_params: {
        id: row.id,
        recorded: row.recordedAt,
        ingested: ingestedAt,
        point: JSON.stringify({ type: "Point", coordinates: [-122.1234567, 37.7654321] }),
        metadata: JSON.stringify(row.metadata),
      },
      format: "JSONEachRow",
    });
    expect(await stored.json()).toEqual([{ matches: 1 }]);
    await context.client.command({ query: "SYSTEM FLUSH LOGS" });
    const logs = await context.client.query<{
      count: string;
      leaked: string;
      written: string;
      statistics: number;
      identity_visible: string;
    }>({
      query: `SELECT toString(count()) AS count,
        toString(countIf(arrayExists(marker -> position(query,marker)>0 OR position(formatted_query,marker)>0,{markers:Array(String)}))) AS leaked,
        toString(countIf(position(query,{user:String})>0 AND position(query,{provider:String})>0)) AS identity_visible,
        toString(sum(written_rows)) AS written, toUInt8(sum(memory_usage)>0 AND sum(query_duration_ms)>=0) AS statistics
        FROM system.query_log WHERE query_id IN {ids:Array(String)} AND type='QueryFinish'`,
      query_params: {
        ids: queryIds,
        user: row.userId,
        provider: row.providerId,
        markers: [
          row.id,
          row.recordedAt,
          "9007199254740995",
          "analytics.secret",
          "ingest.secret",
          "73.123456789",
          "-123.987654321",
          "-122.1234567",
        ],
      },
      format: "JSONEachRow",
    });
    expect(await logs.json()).toEqual([
      { count: "1", leaked: "0", written: "2", statistics: 1, identity_visible: "1" },
    ]);
  });

  test("nullable payloads and optional identity fields preserve mapped storage semantics", async () => {
    const row = {
      ...event(),
      scalar: null,
      vector: null,
      point: null,
      metadata: null,
      activityId: randomUUID(),
      externalId: "external-analytics.private",
      deviceId: "device-ingest.private",
    };
    await apply(row);
    const stored = await context.client.query<{ matches: number }>({
      query: `SELECT toUInt8(scalar IS NULL AND empty(vector) AND point='' AND metadata='null'
        AND activity_id={activity:UUID} AND external_id={external:String} AND device_id={device:String}) AS matches
        FROM ingest.metric_stream WHERE id={id:UUID}`,
      query_params: {
        id: row.id,
        activity: row.activityId,
        external: row.externalId,
        device: row.deviceId,
      },
      format: "JSONEachRow",
    });
    expect(await stored.json()).toEqual([{ matches: 1 }]);
  });

  test.each(["stale", "current", "missing", "tombstone", "erased-live", "erased-tombstone"])(
    "insert-time %s fence survives preparation and unrelated generation history",
    async (state) => {
      const row = event();
      const { queryIds, insertQuery, insertParams } = await apply(row, async (effects) => {
        await context.client.insert?.({
          table: "ingest.provider_data_generation",
          format: "JSONEachRow",
          values: [
            { user_id: row.userId, provider_id: `other-${row.providerId}`, generation: 99 },
            { user_id: randomUUID(), provider_id: row.providerId, generation: 99 },
          ],
        });
        if (state !== "missing" && !state.startsWith("erased")) {
          await context.client.insert?.({
            table: "ingest.provider_data_generation",
            values: [
              {
                user_id: row.userId,
                provider_id: row.providerId,
                generation: state === "current" ? 0 : 1,
              },
            ],
            format: "JSONEachRow",
          });
        }
        if (state.includes("tombstone")) {
          if (!effects[0]?.after) throw new Error("Missing prepared effect");
          effects[0].after.deleted = true;
        }
        if (state.startsWith("erased"))
          await context.client.insert?.({
            table: "ingest.account_erasure_fence",
            values: [{ user_hash: createHash("sha256").update(row.userId).digest("hex") }],
            format: "JSONEachRow",
          });
      });
      const stored = await context.client.query<{ count: string }>({
        query: "SELECT toString(count()) AS count FROM ingest.metric_stream WHERE id={id:UUID}",
        query_params: { id: row.id },
        format: "JSONEachRow",
      });
      expect(await stored.json()).toEqual([
        { count: state === "stale" || state.startsWith("erased") ? "0" : "1" },
      ]);
      await context.client.command({ query: "SYSTEM FLUSH LOGS" });
      const cost = await context.client.query<{
        bounded: number;
        logs: string;
        observed_read_rows: string;
      }>({
        query: `SELECT toUInt8(max(read_rows)<20000) AS bounded,toString(count()) AS logs,toString(max(read_rows)) AS observed_read_rows FROM system.query_log WHERE query_id IN {ids:Array(String)} AND type='QueryFinish'`,
        query_params: { ids: queryIds },
        format: "JSONEachRow",
      });
      const costs = await cost.json();
      const plan = await context.client.query<{ explain: string }>({
        query: `EXPLAIN indexes=1 ${insertQuery.slice(insertQuery.indexOf("SELECT")).replace(/FORMAT JSONEachRow\s*$/, "")}`,
        query_params: insertParams,
        format: "JSONEachRow",
      });
      const planRows = await plan.json();
      expect(planRows.some((row) => row.explain.includes("Join ("))).toBe(false);
      expect(costs.map(({ bounded, logs }) => ({ bounded, logs }))).toEqual([
        { bounded: 1, logs: "1" },
      ]);
    },
  );
});
