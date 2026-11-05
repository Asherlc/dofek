import { randomUUID } from "node:crypto";
import { ClickHouseError } from "@clickhouse/client";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { assertPostgresAccountErasureCoverage } from "../account-erasure/postgres-erasure.ts";
import { createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { executeWithSchema } from "../db/typed-sql.ts";
import {
  analyticsDeliveryGroupIngestionTimes,
  analyticsDeliveryGroupIntentId,
  describeAnalyticsDeliveryGroup,
} from "./analytics-delivery-group.ts";
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

  it("admits erasure after a terminal failed group while retaining its original reservation", async () => {
    const clickhouse = createClickHouseClientFromEnv();
    const resourceId = `fixture:${randomUUID()}`;
    const failedStream = { ...stream, topic: `persistent://public/default/${randomUUID()}` };
    const positions = [analyticsPosition(failedStream, 1n), analyticsPosition(failedStream, 2n)];
    const group = describeAnalyticsDeliveryGroup(positions, 500);
    let ingestedAt = "";
    try {
      await expect(
        withAnalyticsQueryOwner(
          context.db,
          clickhouse,
          { resourceId, intentId: analyticsDeliveryGroupIntentId(group) },
          async (owner) => {
            ingestedAt = owner.ingestedAt;
            const streamOwner = randomUUID();
            await claimAnalyticsStream(context.db, {
              stream: failedStream,
              ownerId: streamOwner,
              expectedOwnerId: null,
            });
            await beginAnalyticsDeliveryGroup(context.db, {
              stream: failedStream,
              ownerId: streamOwner,
              positions,
              maximum: 500,
              expected: null,
              ingestedAt,
            });
            const through = analyticsDeliveryGroupIngestionTimes(ingestedAt, 2).at(-1);
            if (!through) throw new Error("Missing fixture reservation");
            await owner.reserveIngestionThrough(through);
            await owner.client.command({
              query: "SELECT throwIf(1, 'fixture terminal source failure')",
              clickhouse_settings: { max_memory_usage: "134217728" },
            });
          },
        ),
      ).rejects.toBeInstanceOf(ClickHouseError);
      const beforeErasure = await loadAnalyticsStreamState(context.db, failedStream);
      expect(beforeErasure).toMatchObject({
        processed: null,
        pendingGroup: { ...group, ingestedAt },
      });
      await expect(
        withAnalyticsQueryOwner(
          context.db,
          clickhouse,
          { resourceId, intentId: `account-erasure:${randomUUID()}:erase:initial` },
          async (owner) => {
            const result = await owner.client.query({
              query: "SELECT toUInt8(1) AS value",
              format: "JSONEachRow",
              clickhouse_settings: { max_memory_usage: "134217728" },
            });
            expect(await result.json()).toEqual([{ value: 1 }]);
          },
        ),
      ).resolves.toBeUndefined();
      expect(await loadAnalyticsStreamState(context.db, failedStream)).toEqual(beforeErasure);
      const reservation = beforeErasure?.pendingGroup;
      if (!reservation) throw new Error("Missing durable fixture reservation");
      const originalTimes = analyticsDeliveryGroupIngestionTimes(ingestedAt, positions.length);
      let replayAllocation = "";
      await withAnalyticsQueryOwner(
        context.db,
        clickhouse,
        { resourceId, intentId: analyticsDeliveryGroupIntentId(group) },
        async (owner) => {
          replayAllocation = owner.ingestedAt;
          const readHighWatermark = () =>
            executeWithSchema(
              context.db,
              z.object({ value: z.string() }),
              sql`SELECT to_char(ingested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS value
                  FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
            );
          const highWatermark = await readHighWatermark();
          await expect(
            owner.reuseIngestionReservation({
              ...reservation,
              memberCount: reservation.memberCount + 1,
            }),
          ).rejects.toThrow(/reservation/);
          await owner.reuseIngestionReservation(reservation);
          expect(await readHighWatermark()).toEqual(highWatermark);
          expect(
            analyticsDeliveryGroupIngestionTimes(reservation.ingestedAt, reservation.memberCount),
          ).toEqual(originalTimes);
        },
      );
      await withAnalyticsQueryOwner(
        context.db,
        clickhouse,
        { resourceId, intentId: "fixture:next-allocation" },
        async (owner) => {
          expect(owner.ingestedAt > replayAllocation).toBe(true);
          expect(owner.ingestedAt > (originalTimes.at(-1) ?? "")).toBe(true);
        },
      );
    } finally {
      await clickhouse.close();
    }
  });

  it.each([
    { label: "missing descriptor", persist: false },
    { label: "unreserved final slot", persist: true },
  ])("keeps failed work blocked with a $label", async ({ persist }) => {
    const clickhouse = createClickHouseClientFromEnv();
    const resourceId = `fixture:${randomUUID()}`;
    const failedStream = { ...stream, topic: `persistent://public/default/${randomUUID()}` };
    const positions = [analyticsPosition(failedStream, 1n), analyticsPosition(failedStream, 2n)];
    const intentId = analyticsDeliveryGroupIntentId(describeAnalyticsDeliveryGroup(positions, 500));
    try {
      await expect(
        withAnalyticsQueryOwner(context.db, clickhouse, { resourceId, intentId }, async (owner) => {
          if (persist) {
            const streamOwner = randomUUID();
            await claimAnalyticsStream(context.db, {
              stream: failedStream,
              ownerId: streamOwner,
              expectedOwnerId: null,
            });
            await beginAnalyticsDeliveryGroup(context.db, {
              stream: failedStream,
              ownerId: streamOwner,
              positions,
              maximum: 500,
              expected: null,
              ingestedAt: owner.ingestedAt,
            });
          }
          await owner.client.command({
            query: "SELECT throwIf(1, 'fixture incomplete source reservation')",
            clickhouse_settings: { max_memory_usage: "134217728" },
          });
        }),
      ).rejects.toBeInstanceOf(ClickHouseError);
      await expect(
        withAnalyticsQueryOwner(
          context.db,
          clickhouse,
          { resourceId, intentId: `account-erasure:${randomUUID()}:erase:initial` },
          async () => {
            throw new Error("Incomplete work must not admit another writer");
          },
        ),
      ).rejects.toThrow(/has pending intent/);
    } finally {
      await clickhouse.close();
    }
  });
});
