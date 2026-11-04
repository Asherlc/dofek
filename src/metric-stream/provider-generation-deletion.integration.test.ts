import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { verifyAnalyticsDeliveryReceipt } from "../analytics/effect-journal.ts";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { mapMetricStreamEventToClickHouseRow } from "./clickhouse-row.ts";
import { applyMetricStreamEventsToClickHouse as applySink } from "./clickhouse-sink.ts";
import { providerDeletionAcknowledgementUpgradeStatements } from "./clickhouse-table.ts";
import type { MetricStreamConsumerBatchContext } from "./consumer-context.ts";
import {
  createMetricStreamEvent,
  createMetricStreamProviderGenerationDeletedEvent,
} from "./events.ts";
import {
  readProviderDeletionAcknowledgement,
  readProviderDeletionSourcePage,
} from "./provider-generation-deletion.ts";
import { createMetricStreamAnalyticsTestContext } from "./test-helpers.ts";

describe("canonical provider generation deletion", () => {
  let context: Awaited<ReturnType<typeof createMetricStreamAnalyticsTestContext>>;
  let admission: AbortController;
  const inFlight = new Set<ReturnType<typeof applySink>>();
  beforeEach(async () => {
    admission = new AbortController();
    context = await createMetricStreamAnalyticsTestContext();
  });
  afterEach(async () => {
    admission.abort(new Error("Provider deletion fixture stopped admitting requests"));
    const settlements = await Promise.allSettled([...inFlight]);
    await context?.cleanup();
    const unexpected = settlements.flatMap((settlement) =>
      settlement.status === "rejected" && settlement.reason !== admission.signal.reason
        ? [settlement.reason]
        : [],
    );
    if (unexpected.length)
      throw new AggregateError(
        unexpected,
        "Provider deletion fixture requests failed during cleanup",
      );
  });
  function applyMetricStreamEventsToClickHouse(...args: Parameters<typeof applySink>) {
    const pending = applySink(...args);
    inFlight.add(pending);
    // Observe settlement without replacing the rejection returned to each test.
    void pending.then(
      () => inFlight.delete(pending),
      () => inFlight.delete(pending),
    );
    return pending;
  }
  function batch(count: number): MetricStreamConsumerBatchContext {
    const topic = `fixture-${randomUUID()}`,
      epoch = randomUUID();
    return {
      topic,
      partition: 0,
      positions: Array.from({ length: count }, (_, index) => ({
        transport: "kafka",
        epoch,
        topic,
        partition: 0,
        offset: String(index),
      })),
      assertActive: async () => admission.signal.throwIfAborted(),
    };
  }
  function fence(providerId = `provider-${randomUUID()}`, generation = 2) {
    return createMetricStreamProviderGenerationDeletedEvent({
      commandId: randomUUID(),
      deletionEventId: randomUUID(),
      userId: context.userId,
      providerId,
      generation,
      sourceIds: [],
      complete: false,
      previousCommandId: null,
    });
  }
  function source(providerId: string) {
    return createMetricStreamEvent(
      {
        id: randomUUID(),
        userId: context.userId,
        providerId,
        recordedAt: "2026-11-03T00:00:00Z",
        channel: "heart_rate",
        sourceType: "api",
        scalar: 72,
      },
      "1",
    );
  }
  async function apply(
    events: Parameters<typeof applyMetricStreamEventsToClickHouse>[1],
    delivery = batch(events.length),
  ) {
    await applyMetricStreamEventsToClickHouse(context.client, events, delivery, context.database);
    return delivery;
  }
  async function rows(id: string) {
    const result = await context.client.query({
      query:
        "SELECT id,provider_id,scalar,is_deleted,toString(generation) AS generation FROM ingest.metric_stream FINAL WHERE id={id:UUID}",
      query_params: { id },
      format: "JSONEachRow",
    });
    return result.json();
  }
  test("fenceCommitPrecedesEnumerationAndLateOldWritesCannotEscapeNewGenerations", async () => {
    const providerId = `provider-${randomUUID()}`;
    const original = createMetricStreamEvent(
      {
        id: randomUUID(),
        userId: context.userId,
        providerId,
        recordedAt: "2026-11-03T00:00:00Z",
        channel: "heart_rate",
        sourceType: "api",
        scalar: 72,
      },
      "1",
    );
    const deletable = { ...original, id: randomUUID() };
    const staleLow = {
      ...original,
      id: "00000000-0000-4000-8000-000000000001",
      operationRevision: "2",
    };
    const current = { ...original, generation: 2, operationRevision: "2", scalar: 93 };
    const deletionEventId = randomUUID();
    const fence = createMetricStreamProviderGenerationDeletedEvent({
      commandId: randomUUID(),
      deletionEventId,
      userId: context.userId,
      providerId,
      generation: 2,
      sourceIds: [],
      complete: false,
      previousCommandId: null,
    });
    const page = createMetricStreamProviderGenerationDeletedEvent({
      ...fence,
      commandId: randomUUID(),
      sourceIds: [original.id, deletable.id, staleLow.id],
      previousCommandId: fence.commandId,
    });
    const terminal = createMetricStreamProviderGenerationDeletedEvent({
      ...page,
      commandId: randomUUID(),
      sourceIds: [],
      complete: true,
      previousCommandId: page.commandId,
    });
    const delivery = batch(7);
    await applyMetricStreamEventsToClickHouse(
      context.client,
      [original, deletable, fence, staleLow, current, page, terminal],
      delivery,
      context.database,
    );
    const raw = await context.client.query<{
      id: string;
      generation: string;
      is_deleted: number;
      scalar: number;
    }>({
      query:
        "SELECT id,toString(generation) AS generation,is_deleted,scalar FROM ingest.metric_stream FINAL WHERE id IN {ids:Array(UUID)} ORDER BY id",
      query_params: { ids: [original.id, deletable.id, staleLow.id] },
      format: "JSONEachRow",
    });
    expect(await raw.json()).toEqual(
      expect.arrayContaining([
        { id: original.id, generation: "2", is_deleted: 0, scalar: 93 },
        { id: deletable.id, generation: "0", is_deleted: 1, scalar: 72 },
        { id: staleLow.id, generation: "0", is_deleted: 1, scalar: 72 },
      ]),
    );
    for (const position of delivery.positions)
      await verifyAnalyticsDeliveryReceipt(context.client, position);
    const acknowledgements = await context.client.query<{
      event_id: string;
      command_id: string;
      position: string;
    }>({
      query:
        "SELECT event_id,command_id,position FROM ingest.metric_stream_delete_acknowledgement FINAL WHERE event_id IN {ids:Array(UUID)} ORDER BY event_id",
      query_params: { ids: [fence.commandId, page.commandId, terminal.commandId, deletionEventId] },
      format: "JSONEachRow",
    });
    const rows = await acknowledgements.json();
    expect(rows).toHaveLength(4);
    expect(rows.find((row) => row.event_id === deletionEventId)?.command_id).toBe(
      terminal.commandId,
    );
    expect(
      JSON.parse(rows.find((row) => row.event_id === fence.commandId)?.position ?? "null"),
    ).toEqual(delivery.positions[2]);
  });

  test("terminalCommandACKCannotCompleteDriverBeforeOriginalDeletionACKAndGapReplay", async () => {
    const providerId = `empty-${randomUUID()}`,
      deletionEventId = randomUUID();
    const fence = createMetricStreamProviderGenerationDeletedEvent({
      commandId: randomUUID(),
      deletionEventId,
      userId: context.userId,
      providerId,
      generation: 2,
      sourceIds: [],
      complete: false,
      previousCommandId: null,
    });
    const terminal = createMetricStreamProviderGenerationDeletedEvent({
      ...fence,
      commandId: randomUUID(),
      previousCommandId: fence.commandId,
      complete: true,
    });
    const delivery = batch(2);
    let fail = true;
    const fault = {
      ...context.client,
      command: async (options: Parameters<ClickHouseClient["command"]>[0]) => {
        if (
          fail &&
          options.query.startsWith("INSERT INTO ingest.metric_stream_delete_acknowledgement") &&
          options.query_params?.event === deletionEventId
        ) {
          fail = false;
          await context.client.command({
            query_id: options.query_id,
            query: "SELECT throwIf(1,'final deletion ACK boundary')",
          });
        }
        return context.client.command(options);
      },
    };
    await expect(
      applyMetricStreamEventsToClickHouse(fault, [fence, terminal], delivery, context.database),
    ).rejects.toThrow("final deletion ACK boundary");
    expect(await readProviderDeletionAcknowledgement(context.client, terminal)).toBeNull();
    await applyMetricStreamEventsToClickHouse(
      context.client,
      [fence, terminal],
      delivery,
      context.database,
    );
    expect(await readProviderDeletionAcknowledgement(context.client, terminal)).toMatchObject({
      effectCount: 0n,
      position: delivery.positions[1],
    });
  });

  test("duplicateNewDeliveryRetainsReplacementAndOriginalCommandReceipt", async () => {
    const first = fence(),
      old = source(first.providerId);
    const page = createMetricStreamProviderGenerationDeletedEvent({
      ...first,
      commandId: randomUUID(),
      previousCommandId: first.commandId,
      sourceIds: [old.id],
    });
    const replacement = { ...old, generation: 2, operationRevision: "5", scalar: 99 };
    const deliveries = batch(5);
    await apply([old, first, page, replacement, page], deliveries);
    expect(await rows(old.id)).toEqual([
      { id: old.id, provider_id: first.providerId, scalar: 99, is_deleted: 0, generation: "2" },
    ]);
    expect(await readProviderDeletionAcknowledgement(context.client, page)).toMatchObject({
      effectCount: 1n,
      position: deliveries.positions[2],
    });
    const replayPosition = deliveries.positions[4];
    if (!replayPosition) throw new Error("Fixture requires replay position");
    expect(await verifyAnalyticsDeliveryReceipt(context.client, replayPosition)).toEqual({
      effectCount: 0n,
    });
    await expect(
      readProviderDeletionAcknowledgement(context.client, { ...page, sourceIds: [randomUUID()] }),
    ).rejects.toThrow("immutable page content changed");
  });

  test("committedPredecessorRejectsDifferentSuccessorWithoutWritingItsACK", async () => {
    const first = fence(),
      old = source(first.providerId);
    const page = createMetricStreamProviderGenerationDeletedEvent({
      ...first,
      commandId: randomUUID(),
      previousCommandId: first.commandId,
      sourceIds: [old.id],
    });
    const fork = { ...page, commandId: randomUUID() };
    await expect(apply([old, first, page, fork])).rejects.toThrow(
      "different identity or successor",
    );
    expect(await readProviderDeletionAcknowledgement(context.client, fork)).toBeNull();
    expect(await rows(old.id)).toMatchObject([{ is_deleted: 1 }]);
  });

  test("missingPredecessorCannotEstablishCommandReceipt", async () => {
    const first = fence();
    const page = createMetricStreamProviderGenerationDeletedEvent({
      ...first,
      commandId: randomUUID(),
      previousCommandId: randomUUID(),
      sourceIds: [randomUUID()],
    });
    await expect(apply([page])).rejects.toThrow("predecessor has no committed");
    expect(await readProviderDeletionAcknowledgement(context.client, page)).toBeNull();
  });

  test("predecessorFromDifferentDeletionCannotAuthorizeTerminal", async () => {
    const first = fence();
    const other = createMetricStreamProviderGenerationDeletedEvent({
      ...first,
      commandId: randomUUID(),
      deletionEventId: randomUUID(),
      previousCommandId: first.commandId,
      complete: true,
    });
    await expect(apply([first, other])).rejects.toThrow("matching typed operation identity");
    expect(await readProviderDeletionAcknowledgement(context.client, other)).toBeNull();
  });

  test("ACKMetadataWithoutPredecessorReceiptCannotAuthorizeTerminal", async () => {
    const first = fence();
    const delivery = batch(2);
    await apply([first], { ...delivery, positions: delivery.positions.slice(0, 1) });
    await context.client.command({ query: "TRUNCATE TABLE analytics.delivery_receipt" });
    const terminal = createMetricStreamProviderGenerationDeletedEvent({
      ...first,
      commandId: randomUUID(),
      previousCommandId: first.commandId,
      complete: true,
    });
    await expect(
      apply([terminal], { ...delivery, positions: delivery.positions.slice(1) }),
    ).rejects.toThrow("delivery receipt is missing or mismatched");
    expect(await readProviderDeletionAcknowledgement(context.client, terminal)).toBeNull();
  });

  test("rawTombstoneServerRejectionReplaysSavedEffectsBeforeCommandACK", async () => {
    const first = fence(),
      old = source(first.providerId);
    const page = createMetricStreamProviderGenerationDeletedEvent({
      ...first,
      commandId: randomUUID(),
      previousCommandId: first.commandId,
      sourceIds: [old.id],
    });
    const delivery = batch(3);
    let fail = true;
    const fault = {
      ...context.client,
      command: async (options: Parameters<ClickHouseClient["command"]>[0]) => {
        if (
          fail &&
          options.query.startsWith("INSERT INTO ingest.metric_stream (") &&
          options.query_params?.ids
        ) {
          fail = false;
          return context.client.command({
            query_id: options.query_id,
            query: "SELECT throwIf(1,'raw tombstone boundary')",
          });
        }
        return context.client.command(options);
      },
    };
    await expect(
      applyMetricStreamEventsToClickHouse(fault, [old, first, page], delivery, context.database),
    ).rejects.toThrow("raw tombstone boundary");
    expect(await rows(old.id)).toMatchObject([{ is_deleted: 0 }]);
    expect(await readProviderDeletionAcknowledgement(context.client, page)).toBeNull();
    await apply([old, first, page], delivery);
    expect(await rows(old.id)).toMatchObject([{ is_deleted: 1 }]);
    expect(await readProviderDeletionAcknowledgement(context.client, page)).toMatchObject({
      effectCount: 1n,
      position: delivery.positions[2],
    });
  });

  test("terminalBooleanCannotSkipLiveResidualSource", async () => {
    const first = fence(),
      old = source(first.providerId);
    const terminal = createMetricStreamProviderGenerationDeletedEvent({
      ...first,
      commandId: randomUUID(),
      previousCommandId: first.commandId,
      complete: true,
    });
    await expect(apply([old, first, terminal])).rejects.toThrow(
      "found live old-generation sources",
    );
    expect(await readProviderDeletionAcknowledgement(context.client, terminal)).toBeNull();
    expect(await rows(old.id)).toMatchObject([{ is_deleted: 0 }]);
  });

  test("knownAccountFenceCancelsBeforeMissingPredecessorAndDoesNotPoisonOtherDelivery", async () => {
    const first = fence();
    await context.client.command({
      query: "INSERT INTO ingest.account_erasure_fence (user_hash) VALUES ({hash:String})",
      query_params: { hash: createHash("sha256").update(context.userId).digest("hex") },
    });
    const cancelled = createMetricStreamProviderGenerationDeletedEvent({
      ...first,
      commandId: randomUUID(),
      previousCommandId: randomUUID(),
      complete: true,
    });
    const other = { ...source("other"), userId: randomUUID() };
    const delivery = await apply([cancelled, other]);
    const cancelledPosition = delivery.positions[0];
    if (!cancelledPosition) throw new Error("Fixture requires cancelled position");
    expect(await verifyAnalyticsDeliveryReceipt(context.client, cancelledPosition)).toEqual({
      effectCount: 0n,
    });
    expect(await readProviderDeletionAcknowledgement(context.client, cancelled)).toBeNull();
    const disposition = await context.client.query({
      query:
        "SELECT user_id,is_empty FROM analytics.effect_receipt FINAL WHERE epoch={epoch:String} AND topic={topic:String} AND kafka_offset=0",
      query_params: { epoch: cancelledPosition.epoch, topic: cancelledPosition.topic },
      format: "JSONEachRow",
    });
    expect(await disposition.json()).toEqual([{ user_id: null, is_empty: 1 }]);
    const generations = await context.client.query({
      query:
        "SELECT count() AS count FROM ingest.provider_data_generation WHERE user_id={user:UUID}",
      query_params: { user: first.userId },
      format: "JSONEachRow",
    });
    expect(await generations.json()).toEqual([{ count: 0 }]);
    expect(await rows(other.id)).toMatchObject([{ is_deleted: 0 }]);
  });

  test("staleGenerationCannotDowngradeFenceOrDeleteGloballyMovedSources", async () => {
    const first = fence(undefined, 3),
      stale = fence(first.providerId, 2);
    const old = source(first.providerId),
      moved = { ...old, providerId: "moved-provider", operationRevision: "2", scalar: 88 };
    const page = createMetricStreamProviderGenerationDeletedEvent({
      ...stale,
      commandId: randomUUID(),
      previousCommandId: stale.commandId,
      sourceIds: [old.id],
    });
    const terminal = createMetricStreamProviderGenerationDeletedEvent({
      ...page,
      commandId: randomUUID(),
      previousCommandId: page.commandId,
      sourceIds: [],
      complete: true,
    });
    await apply([old, moved, first, stale, page, terminal]);
    const generations = await context.client.query({
      query:
        "SELECT toString(max(generation)) AS generation FROM ingest.provider_data_generation WHERE user_id={user:UUID} AND provider_id={provider:String}",
      query_params: { user: first.userId, provider: first.providerId },
      format: "JSONEachRow",
    });
    expect(await generations.json()).toEqual([{ generation: "3" }]);
    expect(await rows(old.id)).toMatchObject([
      { provider_id: "moved-provider", scalar: 88, is_deleted: 0 },
    ]);
    expect(await readProviderDeletionAcknowledgement(context.client, terminal)).toMatchObject({
      effectCount: 0n,
    });
  });

  test("fortyOneRealEffectsRetainStructuralPreimagesAcrossThreeBoundedWrites", async () => {
    const first = fence();
    const events = Array.from({ length: 41 }, () => source(first.providerId));
    const insert = context.client.insert;
    if (!insert) throw new Error("Fixture requires insert");
    await insert({
      table: "ingest.metric_stream",
      values: events.map((event) =>
        mapMetricStreamEventToClickHouseRow(event, "2026-11-03T01:00:00Z"),
      ),
      format: "JSONEachRow",
    });
    const effectPages: number[] = [];
    const client = {
      ...context.client,
      insert: async (options: Parameters<typeof insert>[0]) => {
        if (options.table === "analytics.effect_journal" && Array.isArray(options.values))
          effectPages.push(options.values.length);
        return insert(options);
      },
    };
    const page = createMetricStreamProviderGenerationDeletedEvent({
      ...first,
      commandId: randomUUID(),
      previousCommandId: first.commandId,
      sourceIds: events.map((event) => event.id),
    });
    const terminal = createMetricStreamProviderGenerationDeletedEvent({
      ...page,
      commandId: randomUUID(),
      previousCommandId: page.commandId,
      sourceIds: [],
      complete: true,
    });
    await applyMetricStreamEventsToClickHouse(
      client,
      [first, page, terminal],
      batch(3),
      context.database,
    );
    expect(effectPages).toEqual([20, 20, 1]);
    expect(await readProviderDeletionAcknowledgement(context.client, page)).toMatchObject({
      effectCount: 41n,
    });
    const effects = await context.client.query<{ before: string; after: string }>({
      query:
        "SELECT before,after FROM analytics.effect_journal FINAL WHERE source_id IN {ids:Array(UUID)}",
      query_params: { ids: events.map((event) => event.id) },
      format: "JSONEachRow",
    });
    const records = await effects.json();
    expect(records).toHaveLength(41);
    for (const record of records) {
      const before = JSON.parse(record.before),
        after = JSON.parse(record.after);
      expect(before).toMatchObject({ deleted: false, generation: "0", sourceVersion: "3" });
      expect(after).toEqual({ ...before, deleted: true, sourceVersion: "4" });
    }
  });

  test("structural1001SourceContinuationAndTwentyEffectWrites", async () => {
    const first = fence();
    const events = Array.from({ length: 1001 }, () => source(first.providerId));
    if (!context.client.insert) throw new Error("Fixture requires insert");
    await context.client.insert({
      table: "ingest.metric_stream",
      values: events.map((event) =>
        mapMetricStreamEventToClickHouseRow(event, "2026-11-03T01:00:00Z"),
      ),
      format: "JSONEachRow",
    });
    const delivery = batch(4);
    const effectPages: number[] = [];
    const client = {
      ...context.client,
      insert: async (options: Parameters<NonNullable<ClickHouseClient["insert"]>>[0]) => {
        if (options.table === "analytics.effect_journal" && Array.isArray(options.values))
          effectPages.push(options.values.length);
        return context.client.insert?.(options);
      },
    };
    await applyMetricStreamEventsToClickHouse(
      client,
      [first],
      { ...delivery, positions: delivery.positions.slice(0, 1) },
      context.database,
    );
    const keys = await readProviderDeletionSourcePage(context.client, first, null, 1000);
    expect(keys).toHaveLength(1000);
    const rest = await readProviderDeletionSourcePage(
      context.client,
      first,
      keys.at(-1) ?? null,
      1000,
    );
    expect(rest).toHaveLength(1);
    expect(
      await readProviderDeletionSourcePage(context.client, first, rest.at(-1) ?? null, 1000),
    ).toEqual([]);
    const page = createMetricStreamProviderGenerationDeletedEvent({
      ...first,
      commandId: randomUUID(),
      previousCommandId: first.commandId,
      sourceIds: keys.map((key) => key.id),
    });
    const tail = createMetricStreamProviderGenerationDeletedEvent({
      ...page,
      commandId: randomUUID(),
      previousCommandId: page.commandId,
      sourceIds: rest.map((key) => key.id),
    });
    const terminal = createMetricStreamProviderGenerationDeletedEvent({
      ...tail,
      commandId: randomUUID(),
      previousCommandId: tail.commandId,
      sourceIds: [],
      complete: true,
    });
    await applyMetricStreamEventsToClickHouse(
      client,
      [page, tail, terminal],
      { ...delivery, positions: delivery.positions.slice(1) },
      context.database,
    );
    expect(effectPages.length).toBeGreaterThan(0);
    expect(Math.max(...effectPages)).toBeLessThanOrEqual(20);
    expect(effectPages.reduce((sum, count) => sum + count, 0)).toBe(1001);
    expect(await readProviderDeletionAcknowledgement(context.client, page)).toMatchObject({
      effectCount: 1000n,
    });
    expect(await readProviderDeletionAcknowledgement(context.client, tail)).toMatchObject({
      effectCount: 1n,
    });
    expect(await readProviderDeletionAcknowledgement(context.client, terminal)).toMatchObject({
      effectCount: 0n,
    });
    const raw = await context.client.query({
      query:
        "SELECT countIf(is_deleted=0) AS live,count() AS total FROM ingest.metric_stream FINAL",
      format: "JSONEachRow",
    });
    expect(await raw.json()).toEqual([{ live: 0, total: 1001 }]);
  });

  test("forwardACKUpgradeRetainsLegacyScopeRowsAndRejectsIncompleteTypedMetadata", async () => {
    await context.client.command({
      query: "DROP TABLE ingest.metric_stream_delete_acknowledgement",
    });
    await context.client.command({
      query:
        "CREATE TABLE ingest.metric_stream_delete_acknowledgement (event_id UUID,applied_at DateTime64(9) DEFAULT now64(9)) ENGINE=ReplacingMergeTree(applied_at) ORDER BY event_id",
    });
    const legacyId = randomUUID();
    await context.client.command({
      query:
        "INSERT INTO ingest.metric_stream_delete_acknowledgement (event_id) VALUES ({id:UUID})",
      query_params: { id: legacyId },
    });
    for (const query of providerDeletionAcknowledgementUpgradeStatements())
      await context.client.command({ query });
    const old = await context.client.query({
      query:
        "SELECT event_id,command_id,deletion_event_id FROM ingest.metric_stream_delete_acknowledgement FINAL",
      format: "JSONEachRow",
    });
    expect(await old.json()).toEqual([
      { event_id: legacyId, command_id: null, deletion_event_id: null },
    ]);
    await expect(
      context.client.command({
        query:
          "INSERT INTO ingest.metric_stream_delete_acknowledgement (event_id,command_id) VALUES ({event:UUID},{command:UUID})",
        query_params: { event: randomUUID(), command: randomUUID() },
      }),
    ).rejects.toThrow("Constraint");
    const first = fence();
    await apply([first]);
    expect(await readProviderDeletionAcknowledgement(context.client, first)).toMatchObject({
      effectCount: 0n,
    });
  });
});
