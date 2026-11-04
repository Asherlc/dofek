import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAnalyticsRunFrontier } from "./analytics-run-frontier.ts";
import {
  beginAnalyticsDelivery,
  checkpointAnalyticsPage,
  claimAnalyticsRunOwnership,
  claimAnalyticsStream,
  completeAnalyticsDelivery,
  sealAnalyticsRun,
} from "./analytics-work-store.ts";
import { appendAnalyticsDelivery } from "./effect-journal.ts";
import { analyticsEffect, analyticsPosition, createAnalyticsTestContext } from "./test-helpers.ts";

describe("analytics work store", () => {
  let context: Awaited<ReturnType<typeof createAnalyticsTestContext>>;
  beforeAll(async () => {
    context = await createAnalyticsTestContext();
  });
  afterAll(async () => {
    await context?.cleanup();
  });

  async function delivery() {
    const stream = { ...context.stream, epoch: randomUUID() };
    const position = analyticsPosition(stream, 999999n);
    const ownerId = randomUUID();
    await claimAnalyticsStream(context.database, { stream, ownerId, expectedOwnerId: null });
    await beginAnalyticsDelivery(context.database, { stream, ownerId, expected: null, position });
    const runId = randomUUID();
    const frontiers = [
      { operationId: context.operation.id, datasetKey: "activity" as const, stream, position },
    ];
    return { stream, position, ownerId, runId, frontiers };
  }

  it("cannotSealPastIncompleteReceipt", async () => {
    const input = await delivery();
    await expect(sealAnalyticsRun(context.database, input)).rejects.toThrow(/processed|receipt/i);
    await expect(
      completeAnalyticsDelivery(context.database, context.clickhouse, input),
    ).rejects.toThrow(/receipt/i);
    const effects = [analyticsEffect(input.position, 0n, context.userId)];
    await appendAnalyticsDelivery(context.clickhouse, { position: input.position, effects });
    await context.clickhouse.command({
      query:
        "ALTER TABLE analytics.effect_journal DELETE WHERE epoch={epoch:String} SETTINGS mutations_sync=2",
      query_params: { epoch: input.stream.epoch },
    });
    await expect(
      completeAnalyticsDelivery(context.database, context.clickhouse, input),
    ).rejects.toThrow(/receipt|effects/i);
    await expect(sealAnalyticsRun(context.database, input)).rejects.toThrow(/processed|receipt/i);
    await appendAnalyticsDelivery(context.clickhouse, { position: input.position, effects });
    await completeAnalyticsDelivery(context.database, context.clickhouse, input);
    await sealAnalyticsRun(context.database, input);
    expect(await loadAnalyticsRunFrontier(context.database, input)).toEqual(input.position);
  });

  it("cursorCompareAndSetRejectsStaleOwner", async () => {
    const input = await delivery();
    await appendAnalyticsDelivery(context.clickhouse, {
      position: input.position,
      effects: [
        analyticsEffect(input.position, 0n, context.userId),
        analyticsEffect(input.position, 1n, context.userId),
      ],
    });
    await completeAnalyticsDelivery(context.database, context.clickhouse, input);
    await sealAnalyticsRun(context.database, input);
    const writerOwnerId = randomUUID();
    await claimAnalyticsRunOwnership(context.database, {
      runId: input.runId,
      expectedOwnerId: null,
      ownerId: writerOwnerId,
    });
    const writer = { ...input, ownerId: writerOwnerId };
    const first = { delivery: input.position.delivery, effectOrdinal: "0" };
    const second = { delivery: input.position.delivery, effectOrdinal: "1" };
    await expect(
      checkpointAnalyticsPage(context.database, {
        ...writer,
        stage: "scalar",
        expected: first,
        next: second,
      }),
    ).rejects.toThrow(/cursor|stale/i);
    await checkpointAnalyticsPage(context.database, {
      ...writer,
      stage: "scalar",
      expected: null,
      next: first,
    });
    await expect(
      checkpointAnalyticsPage(context.database, {
        ...writer,
        stage: "scalar",
        expected: null,
        next: second,
      }),
    ).rejects.toThrow(/cursor|stale/i);
    await checkpointAnalyticsPage(context.database, {
      ...writer,
      stage: "scalar",
      expected: first,
      next: second,
    });
    const replacement = randomUUID();
    await claimAnalyticsStream(context.database, {
      ...input,
      expectedOwnerId: input.ownerId,
      ownerId: replacement,
    });
    await expect(
      beginAnalyticsDelivery(context.database, {
        ...input,
        expected: input.position,
        position: analyticsPosition(input.stream, 1000000n),
      }),
    ).rejects.toThrow(/owner/i);
  });

  it("emptyFrontierVectorDoesNotCompleteOperation", async () => {
    await expect(
      sealAnalyticsRun(context.database, { runId: randomUUID(), frontiers: [] }),
    ).rejects.toThrow(/frontier/i);
  });

  it("runOwnershipHandoffFencesTheOldWriterAtAnUnchangedCursor", async () => {
    const input = await delivery();
    await appendAnalyticsDelivery(context.clickhouse, {
      position: input.position,
      effects: [
        analyticsEffect(input.position, 0n, context.userId),
        analyticsEffect(input.position, 1n, context.userId),
      ],
    });
    await completeAnalyticsDelivery(context.database, context.clickhouse, input);
    await sealAnalyticsRun(context.database, input);
    const ownerA = randomUUID(),
      ownerB = randomUUID();
    await claimAnalyticsRunOwnership(context.database, {
      runId: input.runId,
      expectedOwnerId: null,
      ownerId: ownerA,
    });
    const first = { delivery: input.position.delivery, effectOrdinal: "0" };
    const second = { delivery: input.position.delivery, effectOrdinal: "1" };
    await checkpointAnalyticsPage(context.database, {
      ...input,
      ownerId: ownerA,
      stage: "scalar",
      expected: null,
      next: first,
    });
    await claimAnalyticsRunOwnership(context.database, {
      runId: input.runId,
      expectedOwnerId: ownerA,
      ownerId: ownerB,
    });
    await expect(
      checkpointAnalyticsPage(context.database, {
        ...input,
        ownerId: ownerA,
        stage: "scalar",
        expected: first,
        next: second,
      }),
    ).rejects.toThrow(/owner|stale/i);
    await checkpointAnalyticsPage(context.database, {
      ...input,
      ownerId: ownerB,
      stage: "scalar",
      expected: first,
      next: second,
    });
  });

  it("sealingTheSameFiniteVectorIsReplaySafeAndCannotBeExtended", async () => {
    const input = await delivery();
    await appendAnalyticsDelivery(context.clickhouse, { position: input.position, effects: [] });
    await completeAnalyticsDelivery(context.database, context.clickhouse, input);
    await sealAnalyticsRun(context.database, input);
    await sealAnalyticsRun(context.database, input);
    await expect(
      sealAnalyticsRun(context.database, {
        ...input,
        frontiers: [
          {
            ...input.frontiers[0],
            operationId: context.operation.id,
            datasetKey: "activity",
            stream: input.stream,
            position: analyticsPosition(input.stream, 1000000n),
          },
        ],
      }),
    ).rejects.toThrow(/sealed|immutable/i);
  });

  it("sparseCoordinatesAndExplicitZeroEffectReceiptAreContiguousProcessedDeliveries", async () => {
    const input = await delivery();
    await appendAnalyticsDelivery(context.clickhouse, { position: input.position, effects: [] });
    await completeAnalyticsDelivery(context.database, context.clickhouse, input);
    const next = analyticsPosition(input.stream, 1000000000n);
    await beginAnalyticsDelivery(context.database, {
      ...input,
      expected: input.position,
      position: next,
    });
    await appendAnalyticsDelivery(context.clickhouse, { position: next, effects: [] });
    await completeAnalyticsDelivery(context.database, context.clickhouse, {
      ...input,
      position: next,
    });
    await sealAnalyticsRun(context.database, input);
    expect(await loadAnalyticsRunFrontier(context.database, input)).toEqual(input.position);
  });
});
