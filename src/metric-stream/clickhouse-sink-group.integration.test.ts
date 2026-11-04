import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAnalyticsStreamState } from "../analytics/analytics-work-store.ts";
import { analyticsPosition } from "../analytics/test-helpers.ts";
import { applyMetricStreamEventsToClickHouse } from "./clickhouse-sink.ts";
import { createMetricStreamEvent } from "./events.ts";
import { createMetricStreamAnalyticsTestContext } from "./test-helpers.ts";

describe("grouped metric sink application path", () => {
  let context: Awaited<ReturnType<typeof createMetricStreamAnalyticsTestContext>>;
  beforeAll(async () => {
    context = await createMetricStreamAnalyticsTestContext();
  });
  afterAll(async () => {
    await context.cleanup();
  });

  it("publishesTwentyDistinctMessagesWithSetBasedRequestsAndOneRealFrontier", async () => {
    const stream = { ...context.stream, epoch: randomUUID() };
    const events = Array.from({ length: 20 }, (_, index) =>
      createMetricStreamEvent(
        {
          id: randomUUID(),
          userId: context.userId,
          providerId: "group-fixture",
          recordedAt: `2026-01-01T00:00:00.${String(index).padStart(6, "0")}Z`,
          sourceType: "sensor",
          channel: "heart_rate",
          scalar: 100 + index,
        },
        "1",
      ),
    );
    const positions = events.map((_, index) => analyticsPosition(stream, BigInt(index + 1)));
    const insert = context.client.insert?.bind(context.client);
    if (!insert) throw new Error("Insert-capable fixture required");
    let requests = 0;
    const client = {
      query: <R extends object>(options: Parameters<typeof context.client.query>[0]) => {
        requests++;
        return context.client.query<R>(options);
      },
      command: (options: Parameters<typeof context.client.command>[0]) => {
        requests++;
        return context.client.command(options);
      },
      insert: (options: Parameters<typeof insert>[0]) => {
        requests++;
        return insert(options);
      },
    };
    expect(
      await applyMetricStreamEventsToClickHouse(
        client,
        events,
        {
          topic: stream.topic,
          partition: stream.partition,
          positions,
          assertActive: async () => {},
        },
        context.database,
      ),
    ).toBe(20);
    expect(requests).toBeLessThanOrEqual(20);
    const result = await context.client.query({
      query:
        "SELECT count() AS rows,uniqExact(ingested_at) AS ingestion_times FROM ingest.metric_stream FINAL WHERE id IN {ids:Array(UUID)}",
      query_params: { ids: events.map((event) => event.id) },
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([{ rows: 20, ingestion_times: 20 }]);
    const state = await loadAnalyticsStreamState(context.database, stream);
    expect(state?.processed).toEqual(positions.at(-1));
    expect(state?.completedGroup?.memberCount).toBe(20);
  });
});
