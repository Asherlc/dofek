import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeAnalyticsDeliveryGroup } from "./analytics-delivery-group.ts";
import { appendAnalyticsDelivery } from "./effect-journal.ts";
import {
  commitAnalyticsDeliveryGroup,
  prepareAnalyticsDeliveryGroup,
  readAnalyticsDeliveryGroupPositions,
  verifyAnalyticsDeliveryReceipts,
} from "./effect-journal-group.ts";
import { analyticsEffect, analyticsPosition, createAnalyticsTestContext } from "./test-helpers.ts";

describe("grouped delivery receipt verification", () => {
  let context: Awaited<ReturnType<typeof createAnalyticsTestContext>>;
  beforeAll(async () => {
    context = await createAnalyticsTestContext();
  });
  afterAll(async () => {
    await context.cleanup();
  });

  function group() {
    const stream = { ...context.stream, epoch: randomUUID() };
    return [9007199254740993n, 9007199254740997n, 9007199254741009n].map((entry) =>
      analyticsPosition(stream, entry),
    );
  }

  it.each([1, 100, 500])(
    "preparesCommitsAndVerifies %i exact members within HTTP parameter bounds",
    async (count) => {
      const stream = { ...context.stream, epoch: randomUUID() };
      const positions = Array.from({ length: count }, (_, index) =>
        analyticsPosition(stream, 9007199254740993n + BigInt(index)),
      );
      const prepared = await prepareAnalyticsDeliveryGroup(context.clickhouse, {
        positions,
        maximum: 500,
        wasPending: false,
        prepare: async () => [],
      });
      await commitAnalyticsDeliveryGroup(context.clickhouse, prepared);
      await expect(
        verifyAnalyticsDeliveryReceipts(context.clickhouse, positions),
      ).resolves.toBeUndefined();
    },
  );

  it("requires every exact native receipt while allowing holes in native coordinates", async () => {
    const positions = group();
    for (const position of positions)
      await appendAnalyticsDelivery(context.clickhouse, {
        position,
        effects: [analyticsEffect(position, 0n, context.userId)],
      });
    await expect(
      verifyAnalyticsDeliveryReceipts(context.clickhouse, positions),
    ).resolves.toBeUndefined();
  });

  it("does not replace a missing member receipt with the groups maximum position", async () => {
    const positions = group();
    for (const position of positions.slice(1))
      await appendAnalyticsDelivery(context.clickhouse, {
        position,
        effects: [analyticsEffect(position, 0n, context.userId)],
      });
    await expect(verifyAnalyticsDeliveryReceipts(context.clickhouse, positions)).rejects.toThrow(
      /receipt.*missing|missing.*receipt/i,
    );
  });

  it("rejects an altered serialized ID even when the ordering coordinates match", async () => {
    const positions = group();
    for (const position of positions)
      await appendAnalyticsDelivery(context.clickhouse, {
        position,
        effects: [analyticsEffect(position, 0n, context.userId)],
      });
    const first = positions[0];
    if (!first) throw new Error("Missing fixture position");
    await expect(
      verifyAnalyticsDeliveryReceipts(context.clickhouse, [
        { ...first, serializedMessageId: "AQ==" },
        ...positions.slice(1),
      ]),
    ).rejects.toThrow(/identity|receipt|mismatch/i);
  });

  it("keeps empty deliveries distinct from missing journal payloads", async () => {
    const positions = group();
    for (const position of positions)
      await appendAnalyticsDelivery(context.clickhouse, { position, effects: [] });
    await expect(
      verifyAnalyticsDeliveryReceipts(context.clickhouse, positions),
    ).resolves.toBeUndefined();
  });

  it("checks every referenced payload before permitting group completion", async () => {
    const positions = group();
    const effects = positions.map((position) => analyticsEffect(position, 0n, context.userId));
    for (const [index, position] of positions.entries()) {
      const effect = effects[index];
      if (!effect) throw new Error("Missing fixture effect");
      await appendAnalyticsDelivery(context.clickhouse, { position, effects: [effect] });
    }
    const removed = effects[1];
    if (!removed) throw new Error("Missing removal target");
    await context.clickhouse.command({
      query:
        "ALTER TABLE analytics.effect_journal DELETE WHERE source_id={id:UUID} SETTINGS mutations_sync=2",
      query_params: { id: removed.sourceId },
    });
    await expect(verifyAnalyticsDeliveryReceipts(context.clickhouse, positions)).rejects.toThrow(
      /missing.*journal|journal.*missing/i,
    );
  });

  it("freshGroupsPublishEveryRealReceiptWithOneArtifactProbeAndNoOwnWriteRereads", async () => {
    const positions = group();
    const effects = positions.map((position) => analyticsEffect(position, 0n, context.userId));
    let reads = 0;
    const client = {
      ...context.clickhouse,
      query: <R extends object>(options: Parameters<typeof context.clickhouse.query>[0]) => {
        reads++;
        return context.clickhouse.query<R>(options);
      },
    };
    const prepared = await prepareAnalyticsDeliveryGroup(client, {
      positions,
      maximum: 500,
      wasPending: false,
      prepare: async () => effects,
    });
    expect(prepared).toMatchObject({ fresh: true, positions, effects });
    expect(reads).toBe(1);
    await commitAnalyticsDeliveryGroup(client, prepared);
    expect(reads).toBe(1);
    await verifyAnalyticsDeliveryReceipts(client, positions);
    expect(reads).toBeLessThanOrEqual(5);
  });

  it("persistedMixedManifestsKeepMultiEffectProofsPagedAtTwenty", async () => {
    const positions = group();
    for (const [index, position] of positions.entries())
      await appendAnalyticsDelivery(context.clickhouse, {
        position,
        effects: Array.from({ length: index === 2 ? 21 : 1 }, (_, ordinal) =>
          analyticsEffect(position, BigInt(ordinal), context.userId),
        ),
      });
    const limits: unknown[] = [];
    const client = {
      query: <R extends object>(options: Parameters<typeof context.clickhouse.query>[0]) => {
        if (options.query.includes("FROM analytics.effect_receipt FINAL"))
          limits.push(options.query_params?.limit);
        return context.clickhouse.query<R>(options);
      },
    };
    await verifyAnalyticsDeliveryReceipts(client, positions);
    expect(limits.length).toBeGreaterThan(1);
    expect(limits.every((limit) => limit === 20)).toBe(true);
  });

  it("reconstructsTheOriginalCompletedMembershipFromItsRetainedDescriptor", async () => {
    const positions = group();
    const effects = positions.map((position) => analyticsEffect(position, 0n, context.userId));
    const prepared = await prepareAnalyticsDeliveryGroup(context.clickhouse, {
      positions,
      maximum: 500,
      wasPending: false,
      prepare: async () => effects,
    });
    await commitAnalyticsDeliveryGroup(context.clickhouse, prepared);
    const descriptor = describeAnalyticsDeliveryGroup(positions, 500);
    expect(await readAnalyticsDeliveryGroupPositions(context.clickhouse, descriptor)).toEqual(
      positions,
    );
    await expect(
      readAnalyticsDeliveryGroupPositions(context.clickhouse, {
        ...descriptor,
        positionsDigest: "0".repeat(64),
      }),
    ).rejects.toThrow(/membership|digest/i);
  });

  it("partialIntentWithoutAnyManifestAlwaysRoutesThroughReplayValidation", async () => {
    const positions = group();
    const effects = positions.map((position) => analyticsEffect(position, 0n, context.userId));
    const insert = context.clickhouse.insert?.bind(context.clickhouse);
    if (!insert) throw new Error("Insert-capable fixture required");
    let fail = true;
    const client = {
      ...context.clickhouse,
      insert: async (options: Parameters<typeof insert>[0]) => {
        if (fail && options.table === "analytics.delivery_receipt") {
          fail = false;
          await context.clickhouse.command({
            query: "SELECT throwIf(1,'fixture prepared manifest failure')",
          });
        }
        return insert(options);
      },
    };
    const input = { positions, maximum: 500, wasPending: false, prepare: async () => effects };
    await expect(prepareAnalyticsDeliveryGroup(client, input)).rejects.toThrow(
      /fixture prepared manifest/,
    );
    const resumed = await prepareAnalyticsDeliveryGroup(client, input);
    expect(resumed.fresh).toBe(false);
    expect(resumed.effects).toEqual(effects);
    await commitAnalyticsDeliveryGroup(client, resumed);
    await verifyAnalyticsDeliveryReceipts(client, positions);
  });
});
