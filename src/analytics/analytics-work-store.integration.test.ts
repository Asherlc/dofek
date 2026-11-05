import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { assertPostgresAccountErasureCoverage } from "../account-erasure/postgres-erasure.ts";
import { createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { executeWithSchema } from "../db/typed-sql.ts";
import { withAnalyticsQueryOwner } from "./analytics-query-owner.ts";
import {
  beginAnalyticsDeliveryGroup,
  claimAnalyticsStream,
  loadAnalyticsStreamState,
} from "./analytics-work-store.ts";
import { analyticsPosition } from "./test-helpers.ts";

describe("native delivery work store", () => {
  let context: TestContext;
  const stream = {
    transport: "pulsar",
    epoch: "fixture-epoch",
    topic: "persistent://public/default/fixture",
    partition: -1,
  } as const;

  beforeAll(async () => {
    context = await setupTestDatabase();
  });
  afterAll(async () => {
    await context?.cleanup();
  });

  it("persists exact pending membership and rejects stale owners or replacement membership", async () => {
    await assertPostgresAccountErasureCoverage(context.db);
    const ownerId = randomUUID();
    const positions = [analyticsPosition(stream, 1n), analyticsPosition(stream, 2n)] as const;
    const ingestedAt = "2026-11-05T00:00:00.000001Z";
    await claimAnalyticsStream(context.db, { stream, ownerId, expectedOwnerId: null });
    await beginAnalyticsDeliveryGroup(context.db, {
      stream,
      ownerId,
      positions,
      maximum: 500,
      expected: null,
      ingestedAt,
    });
    expect(await loadAnalyticsStreamState(context.db, stream)).toMatchObject({
      owner_id: ownerId,
      processed: null,
      pending: positions[1],
      pendingGroup: { first: positions[0], last: positions[1], memberCount: 2, ingestedAt },
    });
    await expect(
      beginAnalyticsDeliveryGroup(context.db, {
        stream,
        ownerId: randomUUID(),
        positions,
        maximum: 500,
        expected: null,
        ingestedAt,
      }),
    ).rejects.toThrow(/owner is stale/);
    await expect(
      beginAnalyticsDeliveryGroup(context.db, {
        stream,
        ownerId,
        positions: [positions[0]],
        maximum: 500,
        expected: null,
        ingestedAt,
      }),
    ).rejects.toThrow(/membership changed/);
    const replacementOwner = randomUUID();
    await expect(
      claimAnalyticsStream(context.db, {
        stream,
        ownerId: replacementOwner,
        expectedOwnerId: randomUUID(),
      }),
    ).rejects.toThrow(/owner changed/);
    await claimAnalyticsStream(context.db, {
      stream,
      ownerId: replacementOwner,
      expectedOwnerId: ownerId,
    });
    expect(await loadAnalyticsStreamState(context.db, stream)).toMatchObject({
      owner_id: replacementOwner,
      pendingGroup: { first: positions[0], last: positions[1], memberCount: 2, ingestedAt },
    });
  });

  it("releases the persisted owner only after consuming the real ClickHouse response", async () => {
    const clickhouse = createClickHouseClientFromEnv();
    const resourceId = `fixture:${randomUUID()}`;
    try {
      await withAnalyticsQueryOwner(
        context.db,
        clickhouse,
        { resourceId, intentId: "source-group:fixture" },
        async (owner) => {
          const result = await owner.client.query({
            query: "SELECT toUInt8(1) AS value",
            format: "JSONEachRow",
            clickhouse_settings: { max_memory_usage: 128 * 1024 * 1024 },
          });
          expect(await result.json()).toEqual([{ value: 1 }]);
          await owner.assertActive();
        },
      );
      expect(
        await executeWithSchema(
          context.db,
          z.object({
            quiescent: z.boolean(),
            intent_id: z.string().nullable(),
            query_terminal: z.boolean(),
          }),
          sql`
        SELECT quiescent,intent_id,query_terminal FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}
      `,
        ),
      ).toEqual([{ quiescent: true, intent_id: null, query_terminal: true }]);
    } finally {
      await clickhouse.close();
    }
  });
});
