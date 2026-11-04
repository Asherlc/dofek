import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../db/index.ts";
import {
  analyticsDeliveryGroupIntentId,
  describeAnalyticsDeliveryGroup,
} from "./analytics-delivery-group.ts";
import {
  beginAnalyticsDelivery,
  beginAnalyticsDeliveryGroup,
  claimAnalyticsStream,
  completeAnalyticsDelivery,
  completeAnalyticsDeliveryGroup,
  loadAnalyticsStreamState,
  sealAnalyticsRun,
} from "./analytics-work-store.ts";
import { appendAnalyticsDelivery } from "./effect-journal.ts";
import { analyticsPosition, createAnalyticsTestContext } from "./test-helpers.ts";

describe("durable analytics delivery group membership", () => {
  let context: Awaited<ReturnType<typeof createAnalyticsTestContext>>;
  beforeAll(async () => {
    context = await createAnalyticsTestContext();
  });
  afterAll(async () => {
    await context?.cleanup();
  });

  async function group() {
    const stream = { ...context.stream, epoch: randomUUID() };
    const ownerId = randomUUID();
    const positions = [
      analyticsPosition(stream, 10n),
      analyticsPosition(stream, 100n),
      analyticsPosition(stream, 1000n),
    ] as const;
    await claimAnalyticsStream(context.database, { stream, ownerId, expectedOwnerId: null });
    return {
      stream,
      ownerId,
      positions,
      maximum: 500,
      expected: null,
      ingestedAt: "2026-11-04T01:02:03.123456Z",
    };
  }

  async function receiptEveryMember(input: Awaited<ReturnType<typeof group>>) {
    for (const position of input.positions)
      await appendAnalyticsDelivery(context.clickhouse, { position, effects: [] });
  }

  it("persistsExactMembershipAcrossClientRestart", async () => {
    const input = await group();
    await beginAnalyticsDeliveryGroup(context.database, input);
    const restarted = createDatabase(context.connectionString);
    try {
      expect(await loadAnalyticsStreamState(restarted, input.stream)).toEqual({
        owner_id: input.ownerId,
        processed: null,
        pending: input.positions[2],
        pendingGroup: {
          ...describeAnalyticsDeliveryGroup(input.positions, input.maximum),
          ingestedAt: "2026-11-04T01:02:03.123456Z",
          intentId: analyticsDeliveryGroupIntentId(
            describeAnalyticsDeliveryGroup(input.positions, input.maximum),
          ),
        },
        completedGroup: null,
      });
      await beginAnalyticsDeliveryGroup(restarted, {
        ...input,
        ingestedAt: "2026-11-04T01:02:04.987654Z",
      });
      expect(
        (await loadAnalyticsStreamState(restarted, input.stream))?.pendingGroup?.ingestedAt,
      ).toBe("2026-11-04T01:02:03.123456Z");
    } finally {
      await restarted.$client.end();
    }
  });

  it("changedReplayMembershipCannotReplacePendingGroup", async () => {
    const input = await group();
    await beginAnalyticsDeliveryGroup(context.database, input);
    const before = await loadAnalyticsStreamState(context.database, input.stream);
    const first = input.positions[0];
    const last = input.positions[2];
    if (!first || !last) throw new Error("Incomplete fixture");
    for (const positions of [
      [first, last],
      [first, analyticsPosition(input.stream, 101n), last],
      [analyticsPosition(input.stream, 9n), input.positions[1], last],
      [first, input.positions[1], analyticsPosition(input.stream, 1001n)],
      [first, input.positions[1], { ...last, serializedMessageId: "CAEQBA==" }],
    ]) {
      await expect(
        beginAnalyticsDeliveryGroup(context.database, { ...input, positions }),
      ).rejects.toThrow(/group|membership/i);
      expect(await loadAnalyticsStreamState(context.database, input.stream)).toEqual(before);
    }
  });

  it("allMemberReceiptsRequiredBeforeAtomicFrontierAdvance", async () => {
    const input = await group();
    await beginAnalyticsDeliveryGroup(context.database, input);
    const before = await loadAnalyticsStreamState(context.database, input.stream);
    const first = input.positions[0];
    const last = input.positions[2];
    if (!first || !last) throw new Error("Incomplete fixture");
    const run = {
      runId: randomUUID(),
      frontiers: [
        {
          operationId: context.operation.id,
          datasetKey: "activity" as const,
          stream: input.stream,
          position: last,
        },
      ],
    };
    await appendAnalyticsDelivery(context.clickhouse, { position: first, effects: [] });
    await expect(
      completeAnalyticsDeliveryGroup(context.database, context.clickhouse, input),
    ).rejects.toThrow(/receipt/i);
    expect(await loadAnalyticsStreamState(context.database, input.stream)).toEqual(before);
    await expect(sealAnalyticsRun(context.database, run)).rejects.toThrow(/receipt|processed/i);
    await receiptEveryMember(input);
    await completeAnalyticsDeliveryGroup(context.database, context.clickhouse, input);
    expect(await loadAnalyticsStreamState(context.database, input.stream)).toEqual({
      owner_id: input.ownerId,
      processed: last,
      pending: null,
      pendingGroup: null,
      completedGroup: {
        ...describeAnalyticsDeliveryGroup(input.positions, input.maximum),
        ingestedAt: "2026-11-04T01:02:03.123456Z",
        intentId: analyticsDeliveryGroupIntentId(
          describeAnalyticsDeliveryGroup(input.positions, input.maximum),
        ),
      },
    });
    const restarted = createDatabase(context.connectionString);
    try {
      const completed = (await loadAnalyticsStreamState(restarted, input.stream))?.completedGroup;
      expect(completed).toMatchObject({
        first,
        last,
        memberCount: 3,
        ingestedAt: "2026-11-04T01:02:03.123456Z",
      });
      expect(completed?.intentId).toBe(
        analyticsDeliveryGroupIntentId(describeAnalyticsDeliveryGroup(input.positions, 500)),
      );
    } finally {
      await restarted.$client.end();
    }
    await sealAnalyticsRun(context.database, run);
    await completeAnalyticsDeliveryGroup(context.database, context.clickhouse, input);
  });

  it("singleMemberGroupRetainsItsCompletedIdentity", async () => {
    const input = await group();
    const single = { ...input, positions: [input.positions[0]], maximum: 1 };
    await beginAnalyticsDeliveryGroup(context.database, single);
    await appendAnalyticsDelivery(context.clickhouse, {
      position: input.positions[0],
      effects: [],
    });
    await completeAnalyticsDeliveryGroup(context.database, context.clickhouse, single);
    const state = await loadAnalyticsStreamState(context.database, input.stream);
    expect(state?.pendingGroup).toBeNull();
    expect(state?.pending).toBeNull();
    expect(state?.processed).toEqual(input.positions[0]);
    expect(state?.completedGroup).toMatchObject({
      first: input.positions[0],
      last: input.positions[0],
      memberCount: 1,
      ingestedAt: "2026-11-04T01:02:03.123456Z",
    });
  });

  it("completedMembershipCanOnlyBeReplacedFromItsExactPredecessor", async () => {
    const input = await group();
    await beginAnalyticsDeliveryGroup(context.database, input);
    await receiptEveryMember(input);
    await completeAnalyticsDeliveryGroup(context.database, context.clickhouse, input);
    const before = await loadAnalyticsStreamState(context.database, input.stream);
    const next = {
      ...input,
      positions: [analyticsPosition(input.stream, 2000n)],
      ingestedAt: "2026-11-04T01:02:04.654321Z",
    };
    await expect(beginAnalyticsDeliveryGroup(context.database, next)).rejects.toThrow(/frontier/i);
    expect(await loadAnalyticsStreamState(context.database, input.stream)).toEqual(before);
    await beginAnalyticsDeliveryGroup(context.database, { ...next, expected: input.positions[2] });
    const state = await loadAnalyticsStreamState(context.database, input.stream);
    expect(state?.completedGroup).toBeNull();
    expect(state?.pendingGroup).toMatchObject({
      first: next.positions[0],
      last: next.positions[0],
      memberCount: 1,
      ingestedAt: "2026-11-04T01:02:04.654321Z",
    });
  });

  it("staleOwnerAndChangedPredecessorCannotAdvanceGroup", async () => {
    const input = await group();
    await expect(
      beginAnalyticsDeliveryGroup(context.database, {
        ...input,
        expected: analyticsPosition(input.stream, 1n),
      }),
    ).rejects.toThrow(/frontier|predecessor/i);
    await beginAnalyticsDeliveryGroup(context.database, input);
    await receiptEveryMember(input);
    await claimAnalyticsStream(context.database, {
      stream: input.stream,
      expectedOwnerId: input.ownerId,
      ownerId: randomUUID(),
    });
    const before = await loadAnalyticsStreamState(context.database, input.stream);
    await expect(beginAnalyticsDeliveryGroup(context.database, input)).rejects.toThrow(/owner/i);
    await expect(
      completeAnalyticsDeliveryGroup(context.database, context.clickhouse, input),
    ).rejects.toThrow(/owner/i);
    expect(await loadAnalyticsStreamState(context.database, input.stream)).toEqual(before);
  });

  it("singularApisCannotClobberPendingGroup", async () => {
    const input = await group();
    await beginAnalyticsDeliveryGroup(context.database, input);
    await receiptEveryMember(input);
    const position = input.positions[2];
    if (!position) throw new Error("Incomplete fixture");
    const before = await loadAnalyticsStreamState(context.database, input.stream);
    await expect(beginAnalyticsDelivery(context.database, { ...input, position })).rejects.toThrow(
      /group/i,
    );
    await expect(
      completeAnalyticsDelivery(context.database, context.clickhouse, { ...input, position }),
    ).rejects.toThrow(/group/i);
    expect(await loadAnalyticsStreamState(context.database, input.stream)).toEqual(before);
  });

  it("malformedStoredDescriptorFailsClosed", async () => {
    const input = await group();
    await beginAnalyticsDeliveryGroup(context.database, input);
    await expect(
      context.database.execute(sql`UPDATE fitness.analytics_stream_state
        SET group_member_count=0 WHERE epoch=${input.stream.epoch}`),
    ).rejects.toMatchObject({
      cause: { code: "23514", constraint: "analytics_stream_state_delivery_group" },
    });
    await expect(
      context.database.execute(sql`UPDATE fitness.analytics_stream_state
        SET group_positions_digest=NULL WHERE epoch=${input.stream.epoch}`),
    ).rejects.toMatchObject({
      cause: { code: "23514", constraint: "analytics_stream_state_delivery_group" },
    });
    await context.database.execute(sql`UPDATE fitness.analytics_stream_state
      SET group_first_position='{"unknown":true}'::jsonb WHERE epoch=${input.stream.epoch}`);
    await expect(loadAnalyticsStreamState(context.database, input.stream)).rejects.toThrow();
    await expect(beginAnalyticsDeliveryGroup(context.database, input)).rejects.toThrow();
  });

  it("wrongNativeIdReceiptCannotAdvanceGroup", async () => {
    const input = await group();
    await beginAnalyticsDeliveryGroup(context.database, input);
    await receiptEveryMember(input);
    const before = await loadAnalyticsStreamState(context.database, input.stream);
    const first = input.positions[0];
    if (!first) throw new Error("Incomplete fixture");
    await context.clickhouse.command({
      query: `ALTER TABLE analytics.delivery_receipt
        UPDATE serialized_message_id='CAEQBA=='
        WHERE epoch={epoch:String} AND minor={minor:UInt64}
        SETTINGS mutations_sync=2`,
      query_params: { epoch: input.stream.epoch, minor: first.delivery.minor },
    });
    await expect(
      completeAnalyticsDeliveryGroup(context.database, context.clickhouse, input),
    ).rejects.toThrow(/receipt|identity|message/i);
    expect(await loadAnalyticsStreamState(context.database, input.stream)).toEqual(before);
  });

  it("completedGroupReplayPreservesLaterPendingGroup", async () => {
    const input = await group();
    await beginAnalyticsDeliveryGroup(context.database, input);
    await receiptEveryMember(input);
    await completeAnalyticsDeliveryGroup(context.database, context.clickhouse, input);
    const later = {
      ...input,
      positions: [analyticsPosition(input.stream, 2000n), analyticsPosition(input.stream, 3000n)],
      expected: input.positions[2],
    };
    await beginAnalyticsDeliveryGroup(context.database, later);
    const before = await loadAnalyticsStreamState(context.database, input.stream);
    await expect(
      completeAnalyticsDeliveryGroup(context.database, context.clickhouse, input),
    ).rejects.toThrow(/group|membership/i);
    expect(await loadAnalyticsStreamState(context.database, input.stream)).toEqual(before);
  });
});
