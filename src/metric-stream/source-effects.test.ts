import { describe, expect, it, vi } from "vitest";
import {
  createMetricStreamDeletedEvent,
  type MetricStreamBatchCompletedEventV1,
} from "./events.ts";
import {
  applyMetricStreamSourceEffects,
  metricStreamSourceEffect,
  prepareMetricStreamSourceEffects,
} from "./source-effects.ts";
import {
  sourceOwner as createSourceOwner,
  sourceEvent,
  sourceIngestedAt,
  sourcePosition,
} from "./test-helpers.ts";

vi.mock("../analytics/effect-journal.ts", async (original) => ({
  ...(await original<typeof import("../analytics/effect-journal.ts")>()),
  recordAnalyticsEffectOutcomes: vi.fn(async () => undefined),
}));
function sourceOwner(rows: readonly (readonly object[])[] = []) {
  return createSourceOwner([...rows, []]);
}

describe("streaming source control effects", () => {
  it("applies only prepared tombstone versions under the frozen owner time", async () => {
    const fixture = sourceOwner();
    const placement = {
      sourceId: sourceEvent.id,
      userId: sourceEvent.userId,
      providerId: sourceEvent.providerId,
      sourceVersion: "9007199254740994",
      generation: "1",
      key: {
        userId: sourceEvent.userId,
        channel: sourceEvent.channel,
        recordedAt: sourceEvent.recordedAt,
      },
      activityId: null,
      deleted: true,
    };
    const event = createMetricStreamDeletedEvent(
      { userId: sourceEvent.userId },
      "4503599627370496",
    );
    const effect = metricStreamSourceEffect(sourcePosition, 0n, placement, placement);
    expect(await applyMetricStreamSourceEffects(fixture.owner, event, [effect])).toBe(0);
    expect(fixture.commands).toHaveLength(1);
    expect(fixture.commands[0]?.query_params).toEqual({
      ids: [sourceEvent.id],
      versions: ["9007199254740994"],
      ingested: sourceIngestedAt,
    });
  });

  it("refuses a prepared deletion without a terminal tombstone", async () => {
    const fixture = sourceOwner();
    const placement = {
      sourceId: sourceEvent.id,
      userId: sourceEvent.userId,
      providerId: sourceEvent.providerId,
      sourceVersion: "9007199254740994",
      generation: "1",
      key: {
        userId: sourceEvent.userId,
        channel: sourceEvent.channel,
        recordedAt: sourceEvent.recordedAt,
      },
      activityId: null,
      deleted: false,
    };
    const event = createMetricStreamDeletedEvent(
      { userId: sourceEvent.userId },
      "4503599627370496",
    );
    await expect(
      applyMetricStreamSourceEffects(fixture.owner, event, [
        metricStreamSourceEffect(sourcePosition, 0n, placement, placement),
      ]),
    ).rejects.toThrow(/terminal tombstone/i);
    expect(fixture.commands).toEqual([]);
  });

  it("leaves an already acknowledged deletion without new source work", async () => {
    const event = createMetricStreamDeletedEvent(
      { userId: sourceEvent.userId },
      "4503599627370496",
    );
    const fixture = sourceOwner([[{ event_id: event.eventId }]]);
    const effects = [];
    for await (const page of prepareMetricStreamSourceEffects(fixture.owner, event, sourcePosition))
      effects.push(...page);
    expect(effects).toEqual([]);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.commands).toEqual([]);
  });

  it("prepares an ownerless completion marker as an empty durable delivery", async () => {
    const fixture = sourceOwner();
    const marker: MetricStreamBatchCompletedEventV1 = {
      version: 1,
      eventType: "metric_stream_batch_completed",
      operationId: "00000000-0000-4000-8000-000000000002",
      batchId: "batch",
      datasetKeys: ["metric_stream"],
      expectedEventCount: 1,
      partitionKey: "batch",
    };
    const effects = [];
    for await (const page of prepareMetricStreamSourceEffects(
      fixture.owner,
      marker,
      sourcePosition,
    ))
      effects.push(...page);
    expect(effects).toEqual([]);
    expect(await applyMetricStreamSourceEffects(fixture.owner, marker, effects)).toBe(0);
    expect(fixture.requests).toEqual([]);
    expect(fixture.commands).toEqual([]);
  });

  it("rejects a completion marker carrying mutation effects before dispatch", async () => {
    const fixture = sourceOwner();
    const marker: MetricStreamBatchCompletedEventV1 = {
      version: 1,
      eventType: "metric_stream_batch_completed",
      operationId: "00000000-0000-4000-8000-000000000002",
      batchId: "batch",
      datasetKeys: ["metric_stream"],
      expectedEventCount: 1,
      partitionKey: "batch",
    };
    const placement = {
      sourceId: sourceEvent.id,
      userId: sourceEvent.userId,
      providerId: sourceEvent.providerId,
      sourceVersion: "9007199254740994",
      generation: "1",
      key: {
        userId: sourceEvent.userId,
        channel: sourceEvent.channel,
        recordedAt: sourceEvent.recordedAt,
      },
      activityId: null,
      deleted: true,
    };
    const effect = metricStreamSourceEffect(sourcePosition, 0n, placement, placement);
    await expect(applyMetricStreamSourceEffects(fixture.owner, marker, [effect])).rejects.toThrow(
      /completion marker.*mutation effects/i,
    );
    expect(fixture.commands).toEqual([]);
  });

  it("fails explicitly when a scoped delete finds raw IDs missing from the placement index", async () => {
    const fixture = sourceOwner([[], [{ id: sourceEvent.id }], []]);
    const event = createMetricStreamDeletedEvent(
      { userId: sourceEvent.userId },
      "4503599627370496",
    );
    const prepare = async () => {
      for await (const _page of prepareMetricStreamSourceEffects(
        fixture.owner,
        event,
        sourcePosition,
      )) {
        throw new Error("Unexpected effects before bootstrap readiness");
      }
    };
    await expect(prepare()).rejects.toThrow(/placement index is incomplete.*bootstrap/i);
    expect(fixture.commands).toEqual([]);
  });
});
