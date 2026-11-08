import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import {
  analyticsDeliveryGroupIngestionTimes,
  analyticsDeliveryGroupIntentId,
  describeAnalyticsDeliveryGroup,
} from "./analytics-delivery-group.ts";
import { withAnalyticsQueryOwner } from "./analytics-query-owner.ts";

describe("analytics query owner database boundaries", () => {
  let context: TestContext;
  let client: ClickHouseClient;
  beforeAll(async () => {
    context = await setupTestDatabase();
    client = createClickHouseClientFromEnv();
  });
  afterAll(async () => {
    await client?.close?.();
    await context?.cleanup();
  });

  it.each(["valid", "missing", "insufficient", "multiple"] as const)(
    "clears a failed source intent only with one complete persisted reservation: %s",
    async (scenario) => {
      const first = {
        transport: "kafka" as const,
        epoch: randomUUID(),
        topic: "sensor",
        partition: 0,
        offset: "9",
      };
      const group = describeAnalyticsDeliveryGroup([first, { ...first, offset: "10" }], 500);
      const intentId = analyticsDeliveryGroupIntentId(group);
      const resourceId = randomUUID();
      await expect(
        withAnalyticsQueryOwner(context.db, client, { resourceId, intentId }, async (owner) => {
          const through = analyticsDeliveryGroupIngestionTimes(owner.ingestedAt, 2)[1];
          if (!through) throw new Error("Missing fixture reservation");
          if (scenario !== "insufficient") await owner.reserveIngestionThrough(through);
          const count = scenario === "missing" ? 0 : scenario === "multiple" ? 2 : 1;
          for (let index = 0; index < count; index += 1) {
            await context.db.execute(sql`INSERT INTO fitness.analytics_stream_state (
            transport,epoch,topic,partition,owner_id,pending,group_state,
            group_first_position,group_last_position,group_member_count,group_positions_digest,group_first_ingested_at
          ) VALUES ('kafka',${`${first.epoch}-${index}`},${first.topic},0,${randomUUID()}::uuid,
            ${JSON.stringify(group.last)}::jsonb,'pending',${JSON.stringify(group.first)}::jsonb,
            ${JSON.stringify(group.last)}::jsonb,2,${group.positionsDigest},${owner.ingestedAt}::timestamptz)`);
          }
          await owner.client.command({ query: "SELECT throwIf(1)" });
        }),
      ).rejects.toThrow(/non-zero/);
      const rows = await context.db.execute(sql`SELECT intent_id,quiescent,query_terminal
        FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`);
      expect(rows[0]).toMatchObject({
        intent_id: scenario === "valid" ? null : intentId,
        quiescent: true,
        query_terminal: true,
      });
    },
  );

  it("keeps a failing progress-producing command from completing its intent", async () => {
    const resourceId = randomUUID();
    const intentId = randomUUID();
    await expect(
      withAnalyticsQueryOwner(context.db, client, { resourceId, intentId }, async (owner) => {
        await owner.client.command({
          query: "SELECT sleepEachRow(0.01),throwIf(number=20) FROM numbers(30)",
          clickhouse_settings: {
            max_block_size: "1",
            send_progress_in_http_headers: 1,
            http_headers_progress_interval_ms: "1",
          },
        });
      }),
    ).rejects.toThrow();
    const rows = await context.db.execute(
      sql`SELECT intent_id FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
    );
    expect(rows[0]?.intent_id).toBe(intentId);
  });
});
