import { randomUUID } from "node:crypto";
import { withAccountErasureDeliveryFence } from "../db/account-erasure-delivery-fence.ts";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import type { Database } from "../db/index.ts";
import type { MetricStreamPosition } from "../metric-stream/transport-position.ts";
import { compareMetricStreamPositions } from "../metric-stream/transport-position.ts";
import {
  analyticsDeliveryGroupIngestionTimes,
  analyticsDeliveryGroupIntentId,
  describeAnalyticsDeliveryGroup,
} from "./analytics-delivery-group.ts";
import {
  ANALYTICS_PUBLICATION_RESOURCE,
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

export async function coordinateAnalyticsDeliveryGroup(
  journal: { database: Database; clickhouse: ClickHouseClient },
  input: {
    positions: readonly MetricStreamPosition[];
    maximum: number;
    userIds: readonly string[];
    assertActive(): Promise<void>;
    publish(
      owner: AnalyticsQueryOwner,
      positions: readonly MetricStreamPosition[],
      ingestedAts: readonly string[],
      fencedUserIds: ReadonlySet<string>,
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
      { resourceId: ANALYTICS_PUBLICATION_RESOURCE },
      async () => {
        await input.assertActive();
        const state = await loadAnalyticsStreamState(journal.database, original.stream);
        const last = covered.at(-1);
        if (!state?.processed || !last || compareMetricStreamPositions(last, state.processed) > 0)
          throw new Error("Processed analytics frontier no longer covers replayed group members");
        if (!state.completedGroup)
          throw new Error("Processed analytics frontier has no completed group descriptor");
        await input.assertActive();
        return { completedIntentId: state.completedGroup.intentId };
      },
    );
  }
  const positions = input.positions.slice(covered.length);
  if (!positions.length) return;
  const group = describeAnalyticsDeliveryGroup(positions, input.maximum);
  await withAnalyticsQueryOwner(
    journal.database,
    journal.clickhouse,
    { resourceId: ANALYTICS_PUBLICATION_RESOURCE, intentId: analyticsDeliveryGroupIntentId(group) },
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
      if (state?.pendingGroup) await owner.reuseIngestionReservation(state.pendingGroup);
      else await owner.reserveIngestionThrough(through);
      await withAccountErasureDeliveryFence(
        journal.database,
        input.userIds,
        async (fenced, connection) => {
          await input.publish(owner, positions, times, fenced);
          await input.assertActive();
          await owner.assertActive();
          await completeAnalyticsDeliveryGroup(connection, {
            stream: group.stream,
            ownerId,
            positions,
            maximum: input.maximum,
          });
          await input.assertActive();
        },
      );
      await input.assertActive();
    },
  );
}
