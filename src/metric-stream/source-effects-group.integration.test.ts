import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AnalyticsQueryOwner,
  withAnalyticsQueryOwner,
} from "../analytics/analytics-query-owner.ts";
import type { AnalyticsEffect } from "../analytics/effect-journal.ts";
import { mapMetricStreamEventToClickHouseRow } from "./clickhouse-row.ts";
import { createMetricStreamEvent, type MetricStreamEventV2 } from "./events.ts";
import { prepareMetricStreamSourceEffects } from "./source-effects.ts";
import {
  applyMetricStreamSourceEffectsGroup,
  type MetricStreamSourceEffectsGroupInput,
  prepareMetricStreamSourceEffectsGroup,
} from "./source-effects-group.ts";
import { createMetricStreamAnalyticsTestContext } from "./test-helpers.ts";

describe("grouped normal metric source effects", () => {
  let context: Awaited<ReturnType<typeof createMetricStreamAnalyticsTestContext>>;
  beforeAll(async () => {
    context = await createMetricStreamAnalyticsTestContext();
  });
  afterAll(async () => {
    await context?.cleanup();
  });

  function input(
    index: number,
    overrides: Partial<MetricStreamEventV2> = {},
  ): MetricStreamSourceEffectsGroupInput & { event: MetricStreamEventV2 } {
    return {
      event: {
        ...createMetricStreamEvent(
          {
            id: randomUUID(),
            userId: randomUUID(),
            providerId: `group-${randomUUID()}`,
            channel: "heart_rate",
            sourceType: "api",
            recordedAt: "2026-11-03T02:00:00.123456789+02:00",
            scalar: 75.123456789,
          },
          "4503599627370497",
        ),
        ...overrides,
      },
      position: {
        transport: "pulsar",
        epoch: "group-test",
        topic: "metric-group",
        partition: 0,
        serializedMessageId: Buffer.from(`group-native-${index}`).toString("base64"),
        delivery: { major: "1", minor: String(index), batch: -1 },
      },
      ingestedAt: `2026-11-04T00:00:00.${String(index).padStart(9, "0")}Z`,
    };
  }
  function owned<T>(operation: (owner: AnalyticsQueryOwner) => Promise<T>) {
    return withAnalyticsQueryOwner(
      context.database,
      context.client,
      { resourceId: randomUUID(), intentId: randomUUID() },
      operation,
    );
  }
  async function seedRow(row: MetricStreamSourceEffectsGroupInput) {
    if (!context.client.insert) throw new Error("Fixture requires insert");
    const mapped = mapMetricStreamEventToClickHouseRow(row.event, row.ingestedAt);
    await context.client.insert({
      table: "ingest.metric_stream",
      format: "JSONEachRow",
      values: [{ ...mapped, point: mapped.point ?? "" }],
    });
  }
  async function seedGeneration(row: MetricStreamSourceEffectsGroupInput, generation: number) {
    if (!context.client.insert) throw new Error("Fixture requires insert");
    await context.client.insert({
      table: "ingest.provider_data_generation",
      format: "JSONEachRow",
      values: [{ user_id: row.event.userId, provider_id: row.event.providerId, generation }],
    });
  }
  async function erase(row: MetricStreamSourceEffectsGroupInput) {
    if (!context.client.insert) throw new Error("Fixture requires insert");
    await context.client.insert({
      table: "ingest.account_erasure_fence",
      format: "JSONEachRow",
      values: [{ user_hash: createHash("sha256").update(row.event.userId).digest("hex") }],
    });
  }

  it("groupedPreparationMatchesSingleEventPolicySemantics", async () => {
    const missing = input(1, { scalar: null, vector: null, point: null, metadata: null });
    const current = input(2, {
      generation: 2,
      activityId: randomUUID(),
      externalId: "present",
      deviceId: "device",
      vector: [0.1, -1.2],
      point: "SRID=4326;POINT(12.3 45.6)",
    });
    const stale = input(3);
    const oldScope = input(4);
    const newScope = input(5);
    const moved = input(6);
    const erased = input(7);
    const newest = input(8, { operationRevision: "4611686018427387903" });
    await seedGeneration(current, 2);
    await seedGeneration(stale, 1);
    await erase(erased);
    await seedRow({
      ...moved,
      event: {
        ...moved.event,
        providerId: "former",
        recordedAt: "2026-11-02T00:00:00Z",
        operationRevision: "1",
      },
    });
    if (!context.client.insert) throw new Error("Fixture requires insert");
    await context.client.insert({
      table: "ingest.metric_stream_delete_scope",
      format: "JSONEachRow",
      values: [oldScope, newScope].map((row, index) => ({
        user_id: row.event.userId,
        provider_id: row.event.providerId,
        activity_id: null,
        channel: "heart_rate",
        external_id_set: 1,
        external_id: null,
        recorded_at_start: "2026-11-03 00:00:00.123456",
        recorded_at_end: "2026-11-03 00:00:00.123457",
        operation_revision: index === 0 ? "1" : "4503599627370498",
      })),
    });
    const inputs = [missing, current, stale, oldScope, newScope, moved, erased, newest];
    await owned(async (owner) => {
      const expected: AnalyticsEffect[] = [];
      for (const row of inputs)
        for await (const page of prepareMetricStreamSourceEffects(owner, row.event, row.position))
          expected.push(...page);
      const effects = await prepareMetricStreamSourceEffectsGroup(owner, inputs);
      expect(effects).toEqual(expected);
      expect(
        effects.map((effect) => [effect.sourceId, effect.sourceVersion, effect.after?.deleted]),
      ).toEqual([
        [missing.event.id, "9007199254740995", false],
        [current.event.id, "9007199254740995", false],
        [stale.event.id, "9007199254740996", true],
        [oldScope.event.id, "9007199254740995", false],
        [newScope.event.id, "9007199254740996", true],
        [moved.event.id, "9007199254740995", false],
        [newest.event.id, "9223372036854775807", false],
      ]);
      await applyMetricStreamSourceEffectsGroup(owner, inputs, effects);
    });
    const stored = await context.client.query<{
      id: string;
      exact_ingestion: number;
      nullable: number;
    }>({
      query: `SELECT id,toUInt8(ingested_at=parseDateTime64BestEffort({ingested:String},9)) AS exact_ingestion,
        toUInt8(scalar IS NULL AND empty(vector) AND point='' AND metadata='null'
          AND activity_id IS NULL AND external_id IS NULL AND device_id IS NULL) AS nullable
        FROM ingest.metric_stream WHERE id={id:UUID}`,
      query_params: { id: missing.event.id, ingested: missing.ingestedAt },
      format: "JSONEachRow",
    });
    expect(await stored.json()).toEqual([
      { id: missing.event.id, exact_ingestion: 1, nullable: 1 },
    ]);
  });

  it("groupedInsertRechecksPerRowAccountAndGenerationFences", async () => {
    const rows = Array.from({ length: 6 }, (_, index) => input(index + 1));
    const [stale, current, missing, tombstone, erasedLive, erasedTombstone] = rows;
    if (!stale || !current || !missing || !tombstone || !erasedLive || !erasedTombstone)
      throw new Error("Missing fixture row");
    await owned(async (owner) => {
      const effects = await prepareMetricStreamSourceEffectsGroup(owner, rows);
      for (const row of [tombstone, erasedTombstone]) {
        const prepared = effects.find((effect) => effect.sourceId === row.event.id);
        if (!prepared?.after) throw new Error("Missing prepared tombstone");
        prepared.after.deleted = true;
      }
      await seedGeneration(stale, 1);
      await seedGeneration(current, 0);
      await seedGeneration(tombstone, 1);
      await erase(erasedLive);
      await erase(erasedTombstone);
      if (!context.client.insert) throw new Error("Fixture requires insert");
      await context.client.insert({
        table: "ingest.provider_data_generation",
        format: "JSONEachRow",
        values: rows.flatMap(({ event }) => [
          { user_id: event.userId, provider_id: `other-${event.providerId}`, generation: 99 },
          { user_id: randomUUID(), provider_id: event.providerId, generation: 99 },
        ]),
      });
      await applyMetricStreamSourceEffectsGroup(owner, rows, effects);
    });
    const stored = await context.client.query<{ id: string }>({
      query: "SELECT id FROM ingest.metric_stream WHERE id IN {ids:Array(UUID)} ORDER BY id",
      query_params: { ids: rows.map(({ event }) => event.id) },
      format: "JSONEachRow",
    });
    expect((await stored.json()).map(({ id }) => id).sort()).toEqual(
      [current.event.id, missing.event.id, tombstone.event.id].sort(),
    );
  });

  it("groupedVersionZeroPreservesPerMessageNanosecondIngestion", async () => {
    const row = input(1);
    if (row.event.version !== 2) throw new Error("Fixture expects v2 event");
    const { operationRevision: _revision, ...legacy } = row.event;
    const first = { ...row, event: { ...legacy, version: 1 as const } };
    const second = { ...first, position: input(2).position, ingestedAt: input(2).ingestedAt };
    await owned(async (owner) => {
      const before = await prepareMetricStreamSourceEffectsGroup(owner, [first]);
      expect(before[0]?.sourceVersion).toBe("0");
      await applyMetricStreamSourceEffectsGroup(owner, [first], before);
      const next = await prepareMetricStreamSourceEffectsGroup(owner, [second]);
      expect(next[0]?.before?.sourceVersion).toBe("0");
      expect(next[0]?.sourceVersion).toBe("0");
      await applyMetricStreamSourceEffectsGroup(owner, [second], next);
    });
    const result = await context.client.query<{ matches: number }>({
      query: `SELECT toUInt8(max(ingested_at)=parseDateTime64BestEffort({ingested:String},9) AND max(version)=0) AS matches
        FROM ingest.metric_stream WHERE id={id:UUID}`,
      query_params: { id: row.event.id, ingested: second.ingestedAt },
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([{ matches: 1 }]);
  });

  it("groupedPreparationRejectsConflictingGlobalOwners", async () => {
    const row = input(1);
    await seedRow({ ...row, event: { ...row.event, userId: randomUUID() } });
    await owned(async (owner) => {
      await expect(prepareMetricStreamSourceEffectsGroup(owner, [row])).rejects.toThrow(
        /conflicting account owners/,
      );
    });
  });
});
