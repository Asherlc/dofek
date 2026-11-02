import { randomUUID } from "node:crypto";
import { createClickHouseClientFromEnv } from "dofek/db/clickhouse";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { routeMapPreview } from "../lib/map-preview.ts";
import { buildTestAnalyticsTableStatement } from "../routers/clickhouse-integration-test-models.ts";
import { getActivityRoutePreviews } from "./activity-route-preview.ts";

describe("route preview index filtering", () => {
  const client = createClickHouseClientFromEnv();
  const database = `route_preview_${randomUUID().replaceAll("-", "")}`;
  const userId = "10000000-0000-4000-8000-000000000001";
  const requestedId = "20000000-0000-4000-8000-000000000001";

  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: `${buildTestAnalyticsTableStatement("analytics.activity_location_sample").replaceAll(
        "analytics.",
        `${database}.`,
      )} SETTINGS index_granularity = 64`,
    });
    await client.command({
      query: `INSERT INTO ${database}.activity_location_sample
        (user_id, activity_id, recorded_at, recorded_date, source_metric_stream_id, lat, lng)
        SELECT toUUID('${userId}'),
          if(number < 3, toUUID('${requestedId}'),
            toUUID(concat('30000000-0000-4000-8000-', leftPad(toString(intDiv(number,64)),12,'0')))),
          toDateTime64('2026-10-02 12:00:00',6) + toIntervalSecond(number),
          toDate('2026-10-02'), generateUUIDv4(),
          if(number < 3, 40 + number, 0),
          if(number < 3, -105 + number, 0)
        FROM numbers(8192)`,
    });
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close?.();
  });

  it("reads only the requested route's index range and preserves its ordered preview", async () => {
    const store = {
      async query<TSchema extends z.ZodType>(
        schema: TSchema,
        query: string,
        params?: Record<string, unknown>,
      ): Promise<z.infer<TSchema>[]> {
        const result = await client.query<Record<string, unknown>>({
          query: query.replaceAll("analytics.", `${database}.`),
          format: "JSONEachRow",
          query_params: params,
          clickhouse_settings: { max_rows_to_read: 1024 },
        });
        return (await result.json()).map((row) => schema.parse(row));
      },
    };

    expect(await getActivityRoutePreviews(store, userId, [requestedId])).toEqual(
      new Map([
        [
          requestedId,
          routeMapPreview([
            { lat: 40, lng: -105 },
            { lat: 41, lng: -104 },
            { lat: 42, lng: -103 },
          ]),
        ],
      ]),
    );
  });
});
