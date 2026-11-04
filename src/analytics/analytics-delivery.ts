import { randomUUID } from "node:crypto";
import type { MetricStreamPosition } from "../metric-stream/transport-position.ts";
import { compareMetricStreamPositions } from "../metric-stream/transport-position.ts";
import {
  type AnalyticsQueryOwner,
  withAnalyticsQueryOwner,
  withAnalyticsReceiptQueryOwner,
} from "./analytics-query-owner.ts";
import {
  beginAnalyticsDelivery,
  claimAnalyticsStream,
  completeAnalyticsDelivery,
  loadAnalyticsStreamState,
} from "./analytics-work-store.ts";
import {
  type AnalyticsEffect,
  type AnalyticsJournalClient,
  commitPreparedAnalyticsDelivery,
  hasCompleteAnalyticsDeliveryReceipt,
  prepareAnalyticsDelivery,
  readPreparedAnalyticsEffectPages,
  verifyAnalyticsDeliveryReceipt,
} from "./effect-journal.ts";
import { metricStreamPositionIdentity } from "./journal-position.ts";

const SOURCE_RESOURCE = "metric-stream-source";

/** Shared publication ownership for live/history source-delivery handlers. */
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
  const { position } = input;
  const stream = {
    transport: position.transport,
    epoch: position.epoch,
    topic: position.topic,
    partition: position.partition,
  };
  await input.assertActive();
  const observed = await loadAnalyticsStreamState(journal.database, stream);
  if (observed?.processed && compareMetricStreamPositions(position, observed.processed) <= 0) {
    await withAnalyticsReceiptQueryOwner(
      journal.database,
      journal.clickhouse,
      { resourceId: SOURCE_RESOURCE },
      async (owner) => {
        await input.assertActive();
        const state = await loadAnalyticsStreamState(journal.database, stream);
        if (!state?.processed || compareMetricStreamPositions(position, state.processed) > 0)
          throw new Error("Processed analytics frontier does not cover this exact receipt replay");
        // A maximum alone is never evidence: verify this delivery, including its
        // original native serialized message ID and every referenced effect.
        await verifyAnalyticsDeliveryReceipt(owner.client, position);
        await input.assertActive();
      },
    );
    return;
  }
  await withAnalyticsQueryOwner(
    journal.database,
    journal.clickhouse,
    {
      resourceId: SOURCE_RESOURCE,
      intentId: JSON.stringify([stream, metricStreamPositionIdentity(position)]),
    },
    async (owner) => {
      await input.assertActive();
      const state = await loadAnalyticsStreamState(journal.database, stream);
      const ownerId = randomUUID();
      await claimAnalyticsStream(journal.database, {
        stream,
        ownerId,
        expectedOwnerId: state?.owner_id ?? null,
      });
      await beginAnalyticsDelivery(journal.database, {
        stream,
        ownerId,
        position,
        expected: state?.processed ?? null,
      });
      if (await hasCompleteAnalyticsDeliveryReceipt(owner.client, position)) {
        await input.acknowledgeEffects(owner);
        await input.assertActive();
        await completeAnalyticsDelivery(journal.database, owner.client, {
          stream,
          ownerId,
          position,
        });
        return;
      }
      await prepareAnalyticsDelivery(owner.client, { position, pages: () => input.prepare(owner) });
      await input.applyControl(owner);
      for await (const effects of readPreparedAnalyticsEffectPages(owner.client, position)) {
        await input.assertActive();
        await input.apply(owner, effects);
      }
      await input.assertActive();
      await commitPreparedAnalyticsDelivery(owner.client, position);
      // Legacy delete/processing acknowledgments cannot outrun durable effects.
      await input.acknowledgeEffects(owner);
      await input.assertActive();
      await completeAnalyticsDelivery(journal.database, owner.client, {
        stream,
        ownerId,
        position,
      });
      await input.assertActive();
    },
  );
}
