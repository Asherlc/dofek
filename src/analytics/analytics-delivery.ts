import { randomUUID } from "node:crypto";
import type { MetricStreamPosition } from "../metric-stream/transport-position.ts";
import { compareMetricStreamPositions } from "../metric-stream/transport-position.ts";
import {
  analyticsDeliveryGroupIngestionTimes,
  analyticsDeliveryGroupIntentId,
  describeAnalyticsDeliveryGroup,
} from "./analytics-delivery-group.ts";
import {
  type AnalyticsQueryOwner,
  withAnalyticsQueryOwner,
  withAnalyticsReceiptQueryOwner,
} from "./analytics-query-owner.ts";
import {
  beginAnalyticsDeliveryGroup,
  claimAnalyticsStream,
  completeAnalyticsDeliveryGroup,
  loadAnalyticsStreamState,
} from "./analytics-work-store.ts";
import {
  type AnalyticsEffect,
  type AnalyticsJournalClient,
  commitPreparedAnalyticsDelivery,
  hasCompleteAnalyticsDeliveryReceipt,
  prepareAnalyticsDelivery,
  readPreparedAnalyticsEffectPages,
} from "./effect-journal.ts";
import {
  commitAnalyticsDeliveryGroup,
  prepareAnalyticsDeliveryGroup,
  readAnalyticsDeliveryGroupPositions,
  verifyAnalyticsDeliveryReceipts,
} from "./effect-journal-group.ts";
import { metricStreamPositionIdentity } from "./journal-position.ts";

const SOURCE_RESOURCE = "metric-stream-source";

async function coordinateAnalyticsPublicationGroup(
  journal: AnalyticsJournalClient,
  input: {
    positions: readonly MetricStreamPosition[];
    maximum: number;
    assertActive(): Promise<void>;
    publish(
      owner: AnalyticsQueryOwner,
      positions: readonly MetricStreamPosition[],
      ingestedAts: readonly string[],
      wasPending: boolean,
    ): Promise<void>;
  },
): Promise<void> {
  const original = describeAnalyticsDeliveryGroup(input.positions, input.maximum);
  await input.assertActive();
  const observed = await loadAnalyticsStreamState(journal.database, original.stream);
  const processed = observed?.processed;
  const covered = processed
    ? input.positions.filter((position) => compareMetricStreamPositions(position, processed) <= 0)
    : [];
  if (covered.length) {
    await withAnalyticsReceiptQueryOwner(
      journal.database,
      journal.clickhouse,
      { resourceId: SOURCE_RESOURCE },
      async (owner) => {
        await input.assertActive();
        const state = await loadAnalyticsStreamState(journal.database, original.stream);
        const last = covered.at(-1);
        if (!state?.processed || !last || compareMetricStreamPositions(last, state.processed) > 0)
          throw new Error("Processed analytics frontier no longer covers replayed group members");
        await verifyAnalyticsDeliveryReceipts(owner.client, covered);
        if (state.completedGroup) {
          const members = await readAnalyticsDeliveryGroupPositions(
            owner.client,
            state.completedGroup,
          );
          await verifyAnalyticsDeliveryReceipts(owner.client, members);
          await input.assertActive();
          return { completedIntentId: state.completedGroup.intentId };
        }
        await input.assertActive();
        return {
          completedIntentId: analyticsDeliveryGroupIntentId(
            describeAnalyticsDeliveryGroup(covered, input.maximum),
          ),
        };
      },
    );
  }
  const positions = input.positions.slice(covered.length);
  if (!positions.length) return;
  const group = describeAnalyticsDeliveryGroup(positions, input.maximum);
  await withAnalyticsQueryOwner(
    journal.database,
    journal.clickhouse,
    { resourceId: SOURCE_RESOURCE, intentId: analyticsDeliveryGroupIntentId(group) },
    async (owner) => {
      await input.assertActive();
      const state = await loadAnalyticsStreamState(journal.database, group.stream);
      const base = state?.pendingGroup?.ingestedAt ?? owner.ingestedAt;
      const times = analyticsDeliveryGroupIngestionTimes(base, group.memberCount);
      const through = times.at(-1);
      if (!through) throw new Error("Group ingestion reservation is empty");
      const ownerId = randomUUID();
      await claimAnalyticsStream(journal.database, {
        stream: group.stream,
        ownerId,
        expectedOwnerId: state?.owner_id ?? null,
      });
      await beginAnalyticsDeliveryGroup(journal.database, {
        stream: group.stream,
        ownerId,
        positions,
        maximum: input.maximum,
        expected: state?.processed ?? null,
        ingestedAt: base,
      });
      await owner.reserveIngestionThrough(through);
      await input.publish(owner, positions, times, Boolean(state?.pendingGroup));
      await input.assertActive();
      await completeAnalyticsDeliveryGroup(journal.database, owner.client, {
        stream: group.stream,
        ownerId,
        positions,
        maximum: input.maximum,
      });
      await input.assertActive();
    },
  );
}

export async function coordinateAnalyticsDeliveryGroup(
  journal: AnalyticsJournalClient,
  input: {
    positions: readonly MetricStreamPosition[];
    maximum: number;
    assertActive(): Promise<void>;
    prepare(
      owner: AnalyticsQueryOwner,
      positions: readonly MetricStreamPosition[],
      ingestedAts: readonly string[],
    ): Promise<readonly AnalyticsEffect[]>;
    apply(
      owner: AnalyticsQueryOwner,
      positions: readonly MetricStreamPosition[],
      effects: readonly AnalyticsEffect[],
      ingestedAts: readonly string[],
    ): Promise<void>;
  },
): Promise<void> {
  await coordinateAnalyticsPublicationGroup(journal, {
    ...input,
    publish: async (owner, positions, times, wasPending) => {
      const prepared = await prepareAnalyticsDeliveryGroup(owner.client, {
        positions,
        maximum: input.maximum,
        wasPending,
        prepare: () => input.prepare(owner, positions, times),
      });
      await input.assertActive();
      const pending: MetricStreamPosition[] = [];
      const pendingTimes: string[] = [];
      for (const [index, position] of positions.entries()) {
        if (!prepared.fresh && (await hasCompleteAnalyticsDeliveryReceipt(owner.client, position)))
          continue;
        pending.push(position);
        const time = times[index];
        if (!time) throw new Error("Group member ingestion time is missing");
        pendingTimes.push(time);
      }
      if (pending.length) {
        const identities = new Set(pending.map(metricStreamPositionIdentity));
        await input.apply(
          owner,
          pending,
          prepared.effects.filter((effect) =>
            identities.has(metricStreamPositionIdentity(effect.position)),
          ),
          pendingTimes,
        );
      }
      await input.assertActive();
      await commitAnalyticsDeliveryGroup(owner.client, prepared);
    },
  });
}

/** Streaming controls use the same owner, group frontier and receipt protocol. */
export async function coordinateAnalyticsDelivery(
  journal: AnalyticsJournalClient,
  input: {
    position: MetricStreamPosition;
    assertActive(): Promise<void>;
    prepare(owner: AnalyticsQueryOwner): AsyncIterable<readonly AnalyticsEffect[]>;
    applyControl(owner: AnalyticsQueryOwner): Promise<void>;
    apply(owner: AnalyticsQueryOwner, effects: readonly AnalyticsEffect[]): Promise<void>;
    acknowledgeEffects(owner: AnalyticsQueryOwner): Promise<void>;
  },
): Promise<void> {
  await coordinateAnalyticsPublicationGroup(journal, {
    positions: [input.position],
    maximum: 1,
    assertActive: input.assertActive,
    publish: async (owner, _positions, times) => {
      const ingestedAt = times[0];
      if (!ingestedAt) throw new Error("Control delivery ingestion reservation is empty");
      const deliveryOwner = { ...owner, ingestedAt };
      if (await hasCompleteAnalyticsDeliveryReceipt(owner.client, input.position)) {
        await input.acknowledgeEffects(deliveryOwner);
        return;
      }
      await prepareAnalyticsDelivery(owner.client, {
        position: input.position,
        pages: () => input.prepare(deliveryOwner),
      });
      await input.applyControl(deliveryOwner);
      for await (const effects of readPreparedAnalyticsEffectPages(owner.client, input.position)) {
        await input.assertActive();
        await input.apply(deliveryOwner, effects);
      }
      await input.assertActive();
      await commitPreparedAnalyticsDelivery(owner.client, input.position);
      await input.acknowledgeEffects(deliveryOwner);
    },
  });
}
