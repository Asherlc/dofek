import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { resolveSourcePlacements } from "./source-placement.ts";
import { createAnalyticsTestContext } from "./test-helpers.ts";

describe("source placement history", () => {
  let context: Awaited<ReturnType<typeof createAnalyticsTestContext>>;
  beforeAll(async () => {
    context = await createAnalyticsTestContext();
  });
  afterAll(async () => {
    await context?.cleanup();
  });

  function placement(sourceId: string, version: string, channel = "heart_rate") {
    return {
      source_id: sourceId,
      user_id: context.userId,
      provider_id: "test",
      source_version: version,
      generation: "0",
      channel,
      recorded_at: "2026-11-03 00:00:00.123456789",
      ingested_at: "2026-11-03 01:00:00.000000001",
      activity_id: null,
      deleted: 0,
    };
  }
  async function insert(values: readonly object[]) {
    if (!context.clickhouse.insert) throw new Error("Fixture requires insert");
    await context.clickhouse.insert({
      table: "analytics.source_placement",
      values,
      format: "JSONEachRow",
    });
  }

  test("newestVersionOutsideOldKeyIsResolved", async () => {
    const sourceId = randomUUID();
    await insert([
      placement(sourceId, "1"),
      {
        ...placement(sourceId, "3", "power"),
        provider_id: "corrected-provider",
        recorded_at: "2026-11-04 00:00:00.123456789",
        activity_id: randomUUID(),
        deleted: 1,
      },
    ]);
    const result = await resolveSourcePlacements(context.clickhouse, [sourceId]);
    expect(result).toMatchObject([
      {
        sourceId,
        userId: context.userId,
        providerId: "corrected-provider",
        sourceVersion: "3",
        key: { channel: "power", recordedAt: "2026-11-04T00:00:00.123456789Z" },
        deleted: true,
      },
    ]);
  });

  test("sourceMovesTwiceBeforeProjectionRetainBothFormerKeys", async () => {
    const sourceId = randomUUID();
    await insert([
      placement(sourceId, "1"),
      placement(sourceId, "3", "power"),
      placement(sourceId, "5", "cadence"),
    ]);
    await context.clickhouse.command({ query: "OPTIMIZE TABLE analytics.source_placement FINAL" });
    const history = await context.clickhouse.query<{ channel: string }>({
      query:
        "SELECT channel FROM analytics.source_placement WHERE source_id={id:UUID} ORDER BY source_version",
      query_params: { id: sourceId },
      format: "JSONEachRow",
    });
    expect(await history.json()).toEqual([
      { channel: "heart_rate" },
      { channel: "power" },
      { channel: "cadence" },
    ]);
    expect(await resolveSourcePlacements(context.clickhouse, [sourceId])).toMatchObject([
      { sourceId, sourceVersion: "5", key: { channel: "cadence" } },
    ]);
  });

  test("crossOwnerUuidCollisionFailsEvenWhenOldOwnerIsDeleted", async () => {
    const sourceId = randomUUID();
    await insert([
      { ...placement(sourceId, "1"), deleted: 1 },
      { ...placement(sourceId, "3"), user_id: randomUUID() },
    ]);
    await expect(resolveSourcePlacements(context.clickhouse, [sourceId])).rejects.toThrow(
      "conflicting account owners",
    );
  });

  test("versionZeroUsesOriginalNanosecondIngestionOrder", async () => {
    const sourceId = randomUUID();
    await insert([
      { ...placement(sourceId, "0", "power"), ingested_at: "2026-11-03 01:00:00.000000002" },
      placement(sourceId, "0"),
    ]);
    expect(await resolveSourcePlacements(context.clickhouse, [sourceId])).toMatchObject([
      { sourceId, sourceVersion: "0", key: { channel: "power" } },
    ]);
  });

  test("ambiguousStructuralWinnerFailsInsteadOfChoosingArbitrarily", async () => {
    const sourceId = randomUUID();
    await insert([placement(sourceId, "3"), placement(sourceId, "3", "power")]);
    await expect(resolveSourcePlacements(context.clickhouse, [sourceId])).rejects.toThrow(
      "ambiguous structural placement",
    );
  });

  test("boundedIdsReturnMissingAsAbsentAndRejectOversizedInput", async () => {
    expect(await resolveSourcePlacements(context.clickhouse, [])).toEqual([]);
    expect(await resolveSourcePlacements(context.clickhouse, [randomUUID()])).toEqual([]);
    await expect(
      resolveSourcePlacements(
        context.clickhouse,
        Array.from({ length: 501 }, () => randomUUID()),
      ),
    ).rejects.toThrow("at most 500 source IDs");
  });
});
