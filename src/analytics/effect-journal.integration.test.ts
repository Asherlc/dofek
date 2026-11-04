import { randomUUID } from "node:crypto";
import Pulsar from "pulsar-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { metricStreamPosition } from "../metric-stream/transport-position.ts";
import {
  beginAnalyticsDelivery,
  checkpointAnalyticsPage,
  claimAnalyticsRunOwnership,
  claimAnalyticsStream,
  completeAnalyticsDelivery,
  sealAnalyticsRun,
} from "./analytics-work-store.ts";
import {
  appendAnalyticsDelivery,
  appendAnalyticsEffects,
  readAnalyticsEffectPage,
} from "./effect-journal.ts";
import {
  analyticsEffect,
  analyticsPosition,
  createAnalyticsTestContext,
  seedAnalyticsKeysetFixture,
} from "./test-helpers.ts";

describe("analytics effect journal", () => {
  let context: Awaited<ReturnType<typeof createAnalyticsTestContext>>;
  beforeAll(async () => {
    context = await createAnalyticsTestContext();
  });
  afterAll(async () => {
    await context?.cleanup();
  });

  it("directAppendPreservesEveryStorageIdentityComponent", async () => {
    const stream = { ...context.stream, epoch: randomUUID() };
    const position = analyticsPosition(stream, 0n);
    const effect = analyticsEffect(position, 0n, context.userId);
    const alternateEpoch = { ...stream, epoch: randomUUID() };
    const alternateTopic = { ...stream, topic: `${stream.topic}-other` };
    const native = (hex: string, partition = -1) =>
      metricStreamPosition(
        { ...stream, partition },
        Pulsar.MessageId.deserialize(Buffer.from(hex, "hex")),
      );
    const effects = [
      effect,
      analyticsEffect(analyticsPosition(alternateEpoch, 0n), 0n, context.userId),
      analyticsEffect(analyticsPosition(alternateTopic, 0n), 0n, context.userId),
      analyticsEffect(native("080a10001800", 0), 0n, context.userId),
      analyticsEffect(native("080b1000"), 0n, context.userId),
      analyticsEffect(analyticsPosition(stream, 1n), 0n, context.userId),
      analyticsEffect(native("080a10002000"), 0n, context.userId),
      analyticsEffect(position, 1n, context.userId),
      { ...effect, stage: "dedup" as const },
    ];
    await appendAnalyticsEffects(context.clickhouse, effects);
    for (const table of ["effect_journal", "effect_receipt"]) {
      const result = await context.clickhouse.query<{ row_count: string; identity_count: string }>({
        query: `SELECT toString(count()) AS row_count,toString(uniqExact((epoch,topic,partition,major,minor,batch,effect_ordinal,stage))) AS identity_count FROM analytics.${table} FINAL WHERE epoch IN {epochs:Array(String)}`,
        query_params: { epochs: [stream.epoch, alternateEpoch.epoch] },
        format: "JSONEachRow",
      });
      expect(await result.json()).toEqual([{ row_count: "9", identity_count: "9" }]);
    }
  });

  it.each(["identical", "conflicting"] as const)(
    "directAppendRejectsDuplicateIdentitiesWithoutPersistingAnyWork: %s",
    async (kind) => {
      const stream = { ...context.stream, epoch: randomUUID() };
      const position = analyticsPosition(stream, 0n);
      const effect = analyticsEffect(position, 0n, context.userId);
      if (!effect.after) throw new Error("Missing source fixture");
      const duplicate =
        kind === "identical"
          ? effect
          : {
              ...effect,
              sourceVersion: "9007199254740994",
              after: { ...effect.after, sourceVersion: "9007199254740994" },
            };
      await expect(
        appendAnalyticsEffects(context.clickhouse, [
          analyticsEffect(position, 1n, context.userId),
          effect,
          duplicate,
        ]),
      ).rejects.toThrow(/duplicate effect identit/i);
      for (const table of ["effect_journal", "effect_receipt"]) {
        const result = await context.clickhouse.query<{ row_count: string }>({
          query: `SELECT toString(count()) AS row_count FROM analytics.${table} WHERE epoch={epoch:String}`,
          query_params: { epoch: stream.epoch },
          format: "JSONEachRow",
        });
        expect(await result.json()).toEqual([{ row_count: "0" }]);
      }
    },
  );

  async function sealDelivery(count: number, firstOrdinal = 0n) {
    const stream = { ...context.stream, epoch: randomUUID() };
    const position = analyticsPosition(stream, 1000n);
    const ownerId = randomUUID();
    await claimAnalyticsStream(context.database, { stream, ownerId, expectedOwnerId: null });
    await beginAnalyticsDelivery(context.database, { stream, ownerId, expected: null, position });
    const effects = Array.from({ length: count }, (_, index) =>
      analyticsEffect(position, firstOrdinal + BigInt(index), context.userId),
    );
    await appendAnalyticsDelivery(context.clickhouse, { position, effects });
    await completeAnalyticsDelivery(context.database, context.clickhouse, {
      stream,
      ownerId,
      position,
    });
    const runId = randomUUID();
    await sealAnalyticsRun(context.database, {
      runId,
      frontiers: [{ operationId: context.operation.id, datasetKey: "activity", stream, position }],
    });
    return { effects, runId, stream, position, ownerId };
  }

  it("limitsEffectsBeforeDistinctKeys", async () => {
    const { runId, stream, effects } = await sealDelivery(25);
    const page = await readAnalyticsEffectPage(context, {
      runId,
      stage: "scalar",
      stream,
      after: null,
      limit: 20,
    });
    expect(page.effects).toEqual(effects.slice(0, 20));
    expect(new Set(page.effects.map((effect) => effect.after?.key.recordedAt)).size).toBe(1);
    expect(page.exhausted).toBe(false);
    expect(page.next?.effectOrdinal).toBe("19");
    const next = await readAnalyticsEffectPage(context, {
      runId,
      stage: "scalar",
      stream,
      after: page.next,
      limit: 20,
    });
    expect(next.effects).toEqual(effects.slice(20));
    expect(next.exhausted).toBe(true);
  });

  it("replaysDuplicateDeliveryWithoutMissingEffects", async () => {
    const { runId, stream, effects, position } = await sealDelivery(25);
    await appendAnalyticsDelivery(context.clickhouse, { position, effects });
    const first = await readAnalyticsEffectPage(context, {
      runId,
      stage: "scalar",
      stream,
      after: null,
      limit: 20,
    });
    const second = await readAnalyticsEffectPage(context, {
      runId,
      stage: "scalar",
      stream,
      after: first.next,
      limit: 20,
    });
    expect([...first.effects, ...second.effects]).toEqual(effects);
    const recreated = context.makeClient();
    try {
      expect(
        await readAnalyticsEffectPage(
          { database: context.database, clickhouse: recreated },
          { runId, stage: "scalar", stream, after: first.next, limit: 20 },
        ),
      ).toEqual(second);
    } finally {
      await recreated.close?.();
    }
  });

  it("laterDeliveryCannotEnterAnAlreadySealedPrefix", async () => {
    const { runId, stream, position, ownerId, effects } = await sealDelivery(1);
    const later = analyticsPosition(stream, 1000000n);
    const laterEffects = [analyticsEffect(later, 0n, context.userId)];
    await beginAnalyticsDelivery(context.database, {
      stream,
      ownerId,
      expected: position,
      position: later,
    });
    await appendAnalyticsDelivery(context.clickhouse, { position: later, effects: laterEffects });
    await completeAnalyticsDelivery(context.database, context.clickhouse, {
      stream,
      ownerId,
      position: later,
    });
    await expect(
      beginAnalyticsDelivery(context.database, { stream, ownerId, expected: later, position }),
    ).rejects.toThrow(/order/i);
    await expect(
      appendAnalyticsDelivery(context.clickhouse, {
        position,
        effects: [...effects, analyticsEffect(position, 1n, context.userId)],
      }),
    ).rejects.toThrow(/receipt/i);
    const page = await readAnalyticsEffectPage(context, {
      runId,
      stage: "scalar",
      stream,
      after: null,
      limit: 20,
    });
    expect(page.effects).toEqual(effects);
    expect(page.exhausted).toBe(true);
  });

  it("missingAllEffectsOfAnEarlierReceiptedDeliveryCannotBecomeExhausted", async () => {
    const { stream, position, ownerId } = await sealDelivery(1);
    const later = analyticsPosition(stream, 1000000n);
    await beginAnalyticsDelivery(context.database, {
      stream,
      ownerId,
      expected: position,
      position: later,
    });
    await appendAnalyticsDelivery(context.clickhouse, {
      position: later,
      effects: [analyticsEffect(later, 0n, context.userId)],
    });
    await completeAnalyticsDelivery(context.database, context.clickhouse, {
      stream,
      ownerId,
      position: later,
    });
    const runId = randomUUID();
    await sealAnalyticsRun(context.database, {
      runId,
      frontiers: [
        { operationId: context.operation.id, datasetKey: "activity", stream, position: later },
      ],
    });
    await context.clickhouse.command({
      query:
        "ALTER TABLE analytics.effect_journal DELETE WHERE epoch={epoch:String} AND minor=1000 SETTINGS mutations_sync=2",
      query_params: { epoch: stream.epoch },
    });
    const ownership = await context.clickhouse.query<{ user_id: string }>({
      query:
        "SELECT user_id FROM analytics.effect_receipt FINAL WHERE epoch={epoch:String} AND minor=1000",
      query_params: { epoch: stream.epoch },
      format: "JSONEachRow",
    });
    expect(await ownership.json()).toEqual([{ user_id: context.userId }]);
    await expect(
      readAnalyticsEffectPage(context, { runId, stage: "scalar", stream, after: null, limit: 20 }),
    ).rejects.toThrow(/receipt|missing|identity/i);
  });

  it("zeroEffectReceiptAdvancesANoncollidingDurableCursor", async () => {
    const { runId, stream, position } = await sealDelivery(0);
    const page = await readAnalyticsEffectPage(context, {
      runId,
      stage: "scalar",
      stream,
      after: null,
      limit: 20,
    });
    expect(page.effects).toEqual([]);
    expect(page.next).toEqual({ delivery: position.delivery, effectOrdinal: "-1" });
    expect(page.exhausted).toBe(true);
    if (!page.next) throw new Error("Empty delivery receipt did not progress");
    const writerOwnerId = randomUUID();
    await claimAnalyticsRunOwnership(context.database, {
      runId,
      ownerId: writerOwnerId,
      expectedOwnerId: null,
    });
    await checkpointAnalyticsPage(context.database, {
      ownerId: writerOwnerId,
      runId,
      stage: "scalar",
      stream,
      expected: null,
      next: page.next,
    });
  });

  it("emptyButNotExhaustedPagesAdvanceThroughBoundedReceiptSpans", async () => {
    const stream = { ...context.stream, epoch: randomUUID() };
    const ownerId = randomUUID();
    await claimAnalyticsStream(context.database, { stream, ownerId, expectedOwnerId: null });
    let previous: ReturnType<typeof analyticsPosition> | null = null;
    for (let index = 1; index <= 22; index++) {
      const position = analyticsPosition(stream, BigInt(index) * 1000n);
      await beginAnalyticsDelivery(context.database, {
        stream,
        ownerId,
        expected: previous,
        position,
      });
      await appendAnalyticsDelivery(context.clickhouse, {
        position,
        effects: index === 22 ? [analyticsEffect(position, 0n, context.userId)] : [],
      });
      await completeAnalyticsDelivery(context.database, context.clickhouse, {
        stream,
        ownerId,
        position,
      });
      previous = position;
    }
    if (!previous) throw new Error("Missing finite fixture frontier");
    const runId = randomUUID();
    await sealAnalyticsRun(context.database, {
      runId,
      frontiers: [
        { operationId: context.operation.id, datasetKey: "activity", stream, position: previous },
      ],
    });
    const page = await readAnalyticsEffectPage(context, {
      runId,
      stage: "scalar",
      stream,
      after: null,
      limit: 20,
    });
    expect(page.effects).toEqual([]);
    expect(page.exhausted).toBe(false);
    expect(page.next).toEqual({
      delivery: analyticsPosition(stream, 20000n).delivery,
      effectOrdinal: "-1",
    });
    const next = await readAnalyticsEffectPage(context, {
      runId,
      stage: "scalar",
      stream,
      after: page.next,
      limit: 20,
    });
    expect(next.effects).toHaveLength(1);
    expect(next.exhausted).toBe(true);
    expect(next.next?.effectOrdinal).toBe("0");
  });

  it("largeEffectOrdinalsRoundTripWithoutNumericTruncation", async () => {
    const { runId, stream, effects } = await sealDelivery(2, 9007199254740993n);
    const page = await readAnalyticsEffectPage(context, {
      runId,
      stage: "scalar",
      stream,
      after: null,
      limit: 1,
    });
    expect(page.effects).toEqual(effects.slice(0, 1));
    expect(page.next?.effectOrdinal).toBe("9007199254740993");
    expect(
      (
        await readAnalyticsEffectPage(context, {
          runId,
          stage: "scalar",
          stream,
          after: page.next,
          limit: 1,
        })
      ).next?.effectOrdinal,
    ).toBe("9007199254740994");
  });

  it("missingDiscoveryReceiptSchemaFailsHard", async () => {
    const { runId, stream } = await sealDelivery(1);
    await context.clickhouse.command({
      query: "RENAME TABLE analytics.effect_receipt TO analytics.fixture_receipt_removed",
    });
    try {
      await expect(
        readAnalyticsEffectPage(context, {
          runId,
          stage: "scalar",
          stream,
          after: null,
          limit: 20,
        }),
      ).rejects.toThrow(/effect_receipt|UNKNOWN_TABLE|does not exist/i);
    } finally {
      await context.clickhouse.command({
        query: "RENAME TABLE analytics.fixture_receipt_removed TO analytics.effect_receipt",
      });
    }
  });

  it.each(["one-delivery", "many-deliveries"] as const)(
    "keysetPrunesNativeDeliveryAndOrdinalGranules: %s",
    async (shape) => {
      const input = await seedAnalyticsKeysetFixture(context, shape);
      const queryId = randomUUID();
      let captured: Parameters<ClickHouseClient["query"]>[0] | undefined;
      const clickhouse: ClickHouseClient = {
        ...context.clickhouse,
        query<TRow extends object>(options: Parameters<ClickHouseClient["query"]>[0]) {
          if (options.query.includes("PREWHERE")) {
            captured = { ...options, query_id: queryId };
            return context.clickhouse.query<TRow>(captured);
          }
          return context.clickhouse.query<TRow>(options);
        },
      };
      const page = await readAnalyticsEffectPage(
        { database: context.database, clickhouse },
        { ...input, stage: "scalar", limit: 20 },
      );
      expect(page.effects).toEqual(input.expected);
      if (!captured) throw new Error("Missing captured native page query");
      const plan = await context.clickhouse.query<{ explain: string }>({
        ...captured,
        query_id: undefined,
        query: `EXPLAIN PLAN indexes=1 ${captured.query}`,
      });
      const text = (await plan.json()).map((row) => row.explain).join("\n");
      const condition = text.split("Condition:")[1]?.split("Parts:")[0] ?? "";
      expect(text).toContain("Read type: InOrder");
      for (const coordinate of ["major", "minor", "batch", "effect_ordinal"]) {
        expect(condition).toContain(`${coordinate} in`);
      }
      const granules = /Granules: (\d+)\/(\d+)/.exec(text);
      if (!granules) throw new Error(`Missing native primary-key granule evidence: ${text}`);
      expect(Number(granules[1]), text).toBeLessThan(Number(granules[2]));
      await context.clickhouse.command({ query: "SYSTEM FLUSH LOGS" });
      const statistics = await context.clickhouse.query<{ read_rows: string }>({
        query:
          "SELECT toString(read_rows) AS read_rows FROM system.query_log WHERE query_id={id:String} AND type='QueryFinish' ORDER BY event_time_microseconds DESC LIMIT 1",
        query_params: { id: queryId },
        format: "JSONEachRow",
      });
      const [row] = await statistics.json();
      if (!row) throw new Error("Missing native query read_rows evidence");
      expect(Number(row.read_rows), text).toBeLessThan(input.total);
    },
  );
});
