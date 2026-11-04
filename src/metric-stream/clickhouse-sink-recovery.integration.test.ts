import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { HttpResponse, http, passthrough } from "msw";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { verifyAnalyticsDeliveryReceipt } from "../analytics/effect-journal.ts";
import { createAnalyticsTestContext } from "../analytics/test-helpers.ts";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { createIntegrationMswFixture } from "../test/early-msw-lifecycle.ts";
import { applyMetricStreamEventsToClickHouse } from "./clickhouse-sink.ts";
import {
  buildAccountErasureFenceTableSql,
  buildAccountErasureOperationFenceTableSql,
  buildIngestMetricStreamCreateTableSql,
  buildMetricStreamDeleteAcknowledgementTableSql,
  buildMetricStreamDeleteScopeTableSql,
  buildMetricStreamProcessingAcknowledgementTableSql,
  buildMetricStreamSourcePlacementIngestSql,
  buildProviderDataGenerationTableSql,
} from "./clickhouse-table.ts";
import type { MetricStreamConsumerBatchContext } from "./consumer-context.ts";
import {
  createMetricStreamBatchCompletedEvent,
  createMetricStreamDeletedEvent,
  createMetricStreamEvent,
  metricStreamDeletedEventV2Schema,
} from "./events.ts";
import { createMetricStreamAnalyticsTestContext } from "./test-helpers.ts";
import { type MetricStreamPosition, metricStreamPositionSchema } from "./transport-position.ts";

describe("metric stream durable recovery", () => {
  let context: Awaited<ReturnType<typeof createAnalyticsTestContext>>;
  let client: ClickHouseClient;
  beforeAll(async () => {
    context = await createAnalyticsTestContext();
    const rewrite = (value: string) => value.replaceAll("ingest.", "analytics.");
    const insert = context.clickhouse.insert?.bind(context.clickhouse);
    if (!insert) throw new Error("Fixture requires insert");
    client = {
      command: (options) =>
        context.clickhouse.command({ ...options, query: rewrite(options.query) }),
      query: (options) => context.clickhouse.query({ ...options, query: rewrite(options.query) }),
      insert: (options) => insert({ ...options, table: rewrite(options.table) }),
    };
    for (const query of [
      buildIngestMetricStreamCreateTableSql(),
      buildAccountErasureFenceTableSql(),
      buildAccountErasureOperationFenceTableSql(),
      buildMetricStreamDeleteAcknowledgementTableSql(),
      buildMetricStreamDeleteScopeTableSql(),
      buildMetricStreamProcessingAcknowledgementTableSql(),
      buildProviderDataGenerationTableSql(),
      buildMetricStreamSourcePlacementIngestSql(),
    ])
      await client.command({ query });
  });
  afterAll(async () => {
    await context?.cleanup();
  });

  function batch(count: number): MetricStreamConsumerBatchContext {
    const epoch = randomUUID();
    const topic = `fixture-${randomUUID()}`;
    return {
      topic,
      partition: 0,
      assertActive: async () => undefined,
      positions: Array.from({ length: count }, (_, index) => ({
        transport: "kafka",
        epoch,
        topic,
        partition: 0,
        offset: String(index),
      })),
    };
  }
  function event(revision = "1") {
    return createMetricStreamEvent(
      {
        id: randomUUID(),
        userId: context.userId,
        providerId: `fixture-${randomUUID()}`,
        recordedAt: "2026-11-03T00:00:00.000Z",
        channel: "heart_rate",
        scalar: 72,
        sourceType: "api",
      },
      revision,
    );
  }
  async function raw(sourceId: string) {
    const result = await client.query({
      query: `SELECT toString(version) AS version,is_deleted,channel,
        toString(ingested_at) AS ingested_at FROM ingest.metric_stream FINAL
        WHERE id={id:UUID} ORDER BY version,ingested_at`,
      query_params: { id: sourceId },
      format: "JSONEachRow",
    });
    return result.json();
  }
  async function frontier(position: MetricStreamPosition) {
    const rows = await context.database.execute<{ processed: MetricStreamPosition | null }>(sql`
      SELECT processed FROM fitness.analytics_stream_state
      WHERE transport=${position.transport} AND epoch=${position.epoch}
        AND topic=${position.topic} AND partition=${position.partition}`);
    return rows[0]?.processed ?? null;
  }

  test.each(["analytics.effect_receipt", "analytics.delivery_receipt"])(
    "journalFailureAfterRawWritePreventsFrontierAndReplayRetainsIntent: %s",
    async (boundary) => {
      const row = event();
      const delivery = batch(1);
      const position = delivery.positions[0];
      if (!position || !client.insert) throw new Error("Fixture position/client missing");
      const insert = client.insert.bind(client);
      let fail = true;
      const failureClient: ClickHouseClient = {
        ...client,
        insert: async (options) => {
          if (
            fail &&
            options.table === boundary &&
            (boundary !== "analytics.delivery_receipt" ||
              options.values.some((value) => "status" in value && value.status === "committed"))
          ) {
            fail = false;
            await client.command({
              query_id: options.query_id,
              query: "SELECT throwIf(1,'fixture journal boundary failure')",
            });
          }
          return insert(options);
        },
      };
      await expect(
        applyMetricStreamEventsToClickHouse(failureClient, [row], delivery, context.database),
      ).rejects.toThrow("fixture journal boundary failure");
      const written = await raw(row.id);
      expect(written).toMatchObject([{ version: "3", is_deleted: 0 }]);
      expect(await frontier(position)).toBeNull();
      await expect(verifyAnalyticsDeliveryReceipt(client, position)).rejects.toThrow();
      await applyMetricStreamEventsToClickHouse(client, [row], delivery, context.database);
      await verifyAnalyticsDeliveryReceipt(client, position);
      expect(await frontier(position)).toEqual(position);
      expect(await raw(row.id)).toEqual(written);
    },
  );

  test("sourceMovesTwiceBeforeProjectionRetractBothFormerKeys", async () => {
    const row = event();
    const delivery = batch(3);
    await applyMetricStreamEventsToClickHouse(
      client,
      [
        row,
        { ...row, operationRevision: "2", channel: "power" },
        { ...row, operationRevision: "3", channel: "cadence" },
      ],
      delivery,
      context.database,
    );
    const result = await client.query<{ before: string | null; after: string }>({
      query: `SELECT before,after FROM analytics.effect_journal FINAL
        WHERE source_id={id:UUID} ORDER BY kafka_offset,effect_ordinal`,
      query_params: { id: row.id },
      format: "JSONEachRow",
    });
    const effects = await result.json();
    expect(
      effects.map((effect) => ({
        before: effect.before === null ? null : JSON.parse(effect.before).key.channel,
        after: JSON.parse(effect.after).key.channel,
      })),
    ).toEqual([
      { before: null, after: "heart_rate" },
      { before: "heart_rate", after: "power" },
      { before: "power", after: "cadence" },
    ]);
  });

  test("scopeDeleteHasDurableEffectsAndQueryVisibleTombstone", async () => {
    const row = event();
    const delivery = batch(2);
    const deletion = createMetricStreamDeletedEvent(
      { userId: row.userId, providerId: row.providerId },
      "4",
    );
    await applyMetricStreamEventsToClickHouse(client, [row, deletion], delivery, context.database);
    const position = delivery.positions[1];
    if (!position) throw new Error("Fixture position missing");
    await verifyAnalyticsDeliveryReceipt(client, position);
    expect(await raw(row.id)).toContainEqual(
      expect.objectContaining({ version: "8", is_deleted: 1 }),
    );
    const result = await client.query<{ before: string; after: string }>({
      query: `SELECT before,after FROM analytics.effect_journal FINAL
        WHERE source_id={id:UUID} AND kafka_offset=1 AND epoch={epoch:String}`,
      query_params: { id: row.id, epoch: position.epoch },
      format: "JSONEachRow",
    });
    const effects = await result.json();
    expect(effects).toHaveLength(1);
    expect(JSON.parse(effects[0]?.after ?? "null")).toMatchObject({
      deleted: true,
      sourceVersion: "8",
    });
  });

  test("microsecondOffsetPlacementsAndHalfOpenScopeBoundariesMatchCanonicalRaw", async () => {
    const row = { ...event(), recordedAt: "2026-11-03T02:00:00.123456+02:00" };
    const delivery = batch(4);
    const excluding = createMetricStreamDeletedEvent(
      {
        userId: row.userId,
        channel: row.channel,
        recordedAtStart: "2026-11-03T02:00:00.123455+02:00",
        recordedAtEnd: "2026-11-03T02:00:00.123456+02:00",
      },
      "2",
    );
    const moved = {
      ...row,
      operationRevision: "3",
      channel: "power",
      recordedAt: "2026-11-03T02:00:00.123457+02:00",
    };
    const including = createMetricStreamDeletedEvent(
      {
        userId: row.userId,
        channel: "power",
        recordedAtStart: "2026-11-03T02:00:00.123457+02:00",
        recordedAtEnd: "2026-11-03T02:00:00.123458+02:00",
      },
      "4",
    );
    await applyMetricStreamEventsToClickHouse(
      client,
      [row, excluding, moved, including],
      delivery,
      context.database,
    );
    const result = await client.query<{ before: string | null; after: string }>({
      query:
        "SELECT before,after FROM analytics.effect_journal FINAL WHERE source_id={id:UUID} ORDER BY kafka_offset,effect_ordinal",
      query_params: { id: row.id },
      format: "JSONEachRow",
    });
    const effects = await result.json();
    expect(
      effects.map((value) => ({
        before: value.before && JSON.parse(value.before).key.recordedAt,
        after: JSON.parse(value.after).key.recordedAt,
        deleted: JSON.parse(value.after).deleted,
      })),
    ).toEqual([
      { before: null, after: "2026-11-03T00:00:00.123456Z", deleted: false },
      {
        before: "2026-11-03T00:00:00.123456000Z",
        after: "2026-11-03T00:00:00.123457Z",
        deleted: false,
      },
      {
        before: "2026-11-03T00:00:00.123457000Z",
        after: "2026-11-03T00:00:00.123457000Z",
        deleted: true,
      },
    ]);
    expect(await raw(row.id)).toContainEqual(
      expect.objectContaining({ version: "8", is_deleted: 1, channel: "power" }),
    );
  });

  test("completedReceiptRepairsFrontierGapBeforeAnyNewRawMutation", async () => {
    const row = event();
    const delivery = batch(1);
    const position = delivery.positions[0];
    if (!position) throw new Error("Fixture position missing");
    await context.database.execute(
      sql.raw(
        `ALTER TABLE fitness.analytics_stream_state ADD CONSTRAINT fixture_frontier_failure CHECK(epoch<>'${position.epoch}' OR processed IS NULL)`,
      ),
    );
    try {
      await expect(
        applyMetricStreamEventsToClickHouse(client, [row], delivery, context.database),
      ).rejects.toThrow();
      await verifyAnalyticsDeliveryReceipt(client, position);
      expect(await frontier(position)).toBeNull();
    } finally {
      await context.database.execute(
        sql`ALTER TABLE fitness.analytics_stream_state DROP CONSTRAINT fixture_frontier_failure`,
      );
    }
    let rawWrites = 0;
    const replay = {
      ...client,
      command: (options: Parameters<ClickHouseClient["command"]>[0]) => {
        if (options.query.startsWith("INSERT INTO ingest.metric_stream (")) rawWrites++;
        return client.command(options);
      },
    };
    await applyMetricStreamEventsToClickHouse(replay, [row], delivery, context.database);
    expect(await frontier(position)).toEqual(position);
    expect(rawWrites).toBe(0);
  });

  test("completedBatchedSiblingCanReplayWhileLaterIntentIsPending", async () => {
    const first = event();
    const second = event();
    const delivery = batch(2);
    const insert = client.insert?.bind(client);
    if (!insert) throw new Error("Fixture insert missing");
    let reject = true;
    const fault = {
      ...client,
      insert: async (options: Parameters<typeof insert>[0]) => {
        if (
          reject &&
          options.table === "analytics.effect_receipt" &&
          options.values.some((value) => "kafka_offset" in value && value.kafka_offset === "1")
        ) {
          reject = false;
          await client.command({
            query_id: options.query_id,
            query: "SELECT throwIf(1,'second delivery boundary')",
          });
        }
        return insert(options);
      },
    };
    await expect(
      applyMetricStreamEventsToClickHouse(fault, [first, second], delivery, context.database),
    ).rejects.toThrow("second delivery boundary");
    const firstState = await raw(first.id);
    await applyMetricStreamEventsToClickHouse(client, [first, second], delivery, context.database);
    expect(await raw(first.id)).toEqual(firstState);
    for (const position of delivery.positions)
      await verifyAnalyticsDeliveryReceipt(client, position);
    expect(await frontier(metricStreamPositionSchema.parse(delivery.positions[1]))).toEqual(
      delivery.positions[1],
    );
  });

  test("markerCannotOutrunPriorEffects", async () => {
    const row = event();
    const marker = createMetricStreamBatchCompletedEvent(
      { operationId: context.operation.id, batchId: randomUUID(), datasetKeys: ["activity"] },
      1,
      "fixture",
    );
    const delivery = batch(2);
    const insert = client.insert?.bind(client);
    if (!insert) throw new Error("Fixture insert missing");
    let reject = true;
    const fault = {
      ...client,
      insert: async (options: Parameters<typeof insert>[0]) => {
        if (reject && options.table === "analytics.effect_receipt") {
          reject = false;
          await client.command({
            query_id: options.query_id,
            query: "SELECT throwIf(1,'prior effects missing')",
          });
        }
        return insert(options);
      },
    };
    await expect(
      applyMetricStreamEventsToClickHouse(fault, [row, marker], delivery, context.database),
    ).rejects.toThrow("prior effects missing");
    const acknowledgements = () =>
      client
        .query<{ count: string }>({
          query:
            "SELECT toString(count()) AS count FROM ingest.metric_stream_processing_acknowledgement WHERE batch_id={batch:String}",
          query_params: { batch: marker.batchId },
          format: "JSONEachRow",
        })
        .then((result) => result.json());
    expect(await acknowledgements()).toEqual([{ count: "0" }]);
    await applyMetricStreamEventsToClickHouse(client, [row, marker], delivery, context.database);
    expect(await acknowledgements()).toEqual([{ count: "1" }]);
  });

  test("activeAccountFenceAndGenerationAndNewerDeleteScopeHaveDurableDispositions", async () => {
    if (!client.insert) throw new Error("Fixture insert missing");
    const erased = { ...event(), userId: randomUUID() };
    await client.insert({
      table: "ingest.account_erasure_fence",
      format: "JSONEachRow",
      values: [{ user_hash: createHash("sha256").update(erased.userId).digest("hex") }],
    });
    const erasedDelivery = batch(1);
    await applyMetricStreamEventsToClickHouse(client, [erased], erasedDelivery, context.database);
    expect(await raw(erased.id)).toEqual([]);
    await verifyAnalyticsDeliveryReceipt(
      client,
      metricStreamPositionSchema.parse(erasedDelivery.positions[0]),
    );

    const stale = { ...event(), providerId: `stale-${randomUUID()}` };
    await client.insert({
      table: "ingest.provider_data_generation",
      format: "JSONEachRow",
      values: [{ user_id: stale.userId, provider_id: stale.providerId, generation: 1 }],
    });
    const staleDelivery = batch(1);
    await applyMetricStreamEventsToClickHouse(client, [stale], staleDelivery, context.database);
    expect(await raw(stale.id)).toMatchObject([{ version: "4", is_deleted: 1 }]);
    await verifyAnalyticsDeliveryReceipt(
      client,
      metricStreamPositionSchema.parse(staleDelivery.positions[0]),
    );

    const guarded = { ...event(), providerId: `guarded-${randomUUID()}` };
    const guardedDelivery = batch(2);
    await applyMetricStreamEventsToClickHouse(
      client,
      [
        createMetricStreamDeletedEvent(
          { userId: guarded.userId, providerId: guarded.providerId },
          "4",
        ),
        guarded,
      ],
      guardedDelivery,
      context.database,
    );
    expect(await raw(guarded.id)).toMatchObject([{ version: "8", is_deleted: 1 }]);
    await verifyAnalyticsDeliveryReceipt(
      client,
      metricStreamPositionSchema.parse(guardedDelivery.positions[1]),
    );
  });

  test("archivedV2DeleteEventIdReplayAtNewPositionKeepsReplacementAndHasEmptyReceipt", async () => {
    const original = event();
    const delivery = batch(4);
    const deletion = metricStreamDeletedEventV2Schema.parse({
      version: 2,
      eventType: "metric_stream_deleted",
      eventId: randomUUID(),
      scope: { userId: original.userId, providerId: original.providerId },
      partitionKey: "fixture",
    });
    const replacement = { ...original, operationRevision: "2", scalar: 93 };
    await applyMetricStreamEventsToClickHouse(
      client,
      [original, deletion, replacement, deletion],
      delivery,
      context.database,
    );
    expect(await raw(original.id)).toMatchObject([{ version: "5", is_deleted: 0 }]);
    const replayPosition = metricStreamPositionSchema.parse(delivery.positions[3]);
    await verifyAnalyticsDeliveryReceipt(client, replayPosition);
    expect(await frontier(replayPosition)).toEqual(replayPosition);
    const receipt = await client.query<{ effect_count: string; status: string }>({
      query:
        "SELECT toString(effect_count) AS effect_count,status FROM analytics.delivery_receipt FINAL WHERE epoch={epoch:String} AND kafka_offset=3 ORDER BY status",
      query_params: { epoch: replayPosition.epoch },
      format: "JSONEachRow",
    });
    expect(await receipt.json()).toEqual([
      { effect_count: "0", status: "prepared" },
      { effect_count: "0", status: "committed" },
    ]);
    const scalar = await client.query<{ scalar: number }>({
      query: "SELECT scalar FROM ingest.metric_stream FINAL WHERE id={id:UUID}",
      query_params: { id: original.id },
      format: "JSONEachRow",
    });
    expect(await scalar.json()).toEqual([{ scalar: 93 }]);
  });
  test.each(["native insert rejection", "nonempty 200"])(
    "raw input %s cannot publish a receipt or frontier",
    async (mode) => {
      const isolated = await createMetricStreamAnalyticsTestContext();
      const client = isolated.client;
      const row = { ...event(), userId: isolated.userId };
      const delivery = batch(1);
      const position = delivery.positions[0];
      if (!position) throw new Error("Missing fixture position");
      const network = createIntegrationMswFixture();
      let rawQueryId: string | null = null;
      if (mode === "nonempty 200") {
        network.activate({ onUnhandledFrame: "bypass" });
        network.use(
          http.post("*", ({ request }) => {
            const url = new URL(request.url);
            if (!url.searchParams.get("query")?.includes(".metric_stream (")) return passthrough();
            rawQueryId = url.searchParams.get("query_id");
            return HttpResponse.text("synthetic unexpected body must remain private");
          }),
        );
      } else
        await client.command({
          query:
            "ALTER TABLE ingest.metric_stream ADD CONSTRAINT reject_synthetic_input CHECK provider_id!={provider:String}",
          query_params: { provider: row.providerId },
        });
      try {
        await expect(
          applyMetricStreamEventsToClickHouse(client, [row], delivery, isolated.database),
        ).rejects.toThrow(
          mode === "nonempty 200"
            ? "Unexpected nonempty ClickHouse input command response"
            : "reject_synthetic_input",
        );
        const rows = await client.query({
          query: "SELECT id FROM ingest.metric_stream WHERE id={id:UUID}",
          query_params: { id: row.id },
          format: "JSONEachRow",
        });
        expect(await rows.json()).toEqual([]);
        const progress = await isolated.database.execute(
          sql`SELECT processed FROM fitness.analytics_stream_state WHERE transport=${position.transport} AND epoch=${position.epoch} AND topic=${position.topic} AND partition=${position.partition}`,
        );
        expect(progress[0]?.processed ?? null).toBeNull();
        await expect(verifyAnalyticsDeliveryReceipt(client, position)).rejects.toThrow();
        if (mode === "nonempty 200") {
          expect(typeof rawQueryId).toBe("string");
          const owner = await isolated.database.execute(
            sql`SELECT query_terminal,intent_id IS NOT NULL AS pending FROM fitness.analytics_query_owner WHERE query_id=${rawQueryId}`,
          );
          expect(owner).toEqual([{ query_terminal: false, pending: true }]);
        }
      } finally {
        network.deactivate();
        await isolated.cleanup();
      }
    },
  );
});
