import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { analyticsPosition, completedExecResult } from "../analytics/test-helpers.ts";
import {
  applyMetricStreamSourceEffectsGroup,
  prepareMetricStreamSourceEffectsGroup,
} from "./source-effects-group.ts";
import { sourceEvent, sourceIngestedAt, sourceOwner, sourcePosition } from "./test-helpers.ts";

const second = { ...sourceEvent, id: "10000000-0000-4000-8000-000000000002", scalar: 73 };
const inputs = [
  { event: sourceEvent, position: sourcePosition, ingestedAt: sourceIngestedAt },
  {
    event: second,
    position: analyticsPosition(sourcePosition, 2n),
    ingestedAt: "2026-11-03T01:00:00.123457Z",
  },
] as const;
function policyFixture() {
  return sourceOwner([
    [],
    [],
    inputs.map(({ event }) => ({
      source_id: event.id,
      generation: "1",
      recorded_at: event.recordedAt,
    })),
    [],
  ]);
}

describe("grouped source effects", () => {
  it.each(["missing", "0", "invalid", "-1", "1.5"])(
    "rejects missing, malformed or under-count completed written_rows %s",
    async (count) => {
      const fixture = sourceOwner([
        [],
        [],
        [{ source_id: sourceEvent.id, generation: "1", recorded_at: sourceEvent.recordedAt }],
        [],
      ]);
      const effects = await prepareMetricStreamSourceEffectsGroup(fixture.owner, [inputs[0]]);
      const result = completedExecResult(count === "missing" ? "1" : count);
      if (count === "missing") delete result.summary;
      vi.spyOn(fixture.owner.client, "exec").mockResolvedValue(result);
      await expect(
        applyMetricStreamSourceEffectsGroup(fixture.owner, [inputs[0]], effects),
      ).rejects.toThrow(/written_rows|write summary/i);
    },
  );
  it("accepts a completed summary that includes materialized-view writes", async () => {
    const fixture = sourceOwner([
      [],
      [],
      [{ source_id: sourceEvent.id, generation: "1", recorded_at: sourceEvent.recordedAt }],
      [],
    ]);
    const effects = await prepareMetricStreamSourceEffectsGroup(fixture.owner, [inputs[0]]);
    vi.spyOn(fixture.owner.client, "exec").mockResolvedValue(completedExecResult("2"));
    await expect(
      applyMetricStreamSourceEffectsGroup(fixture.owner, [inputs[0]], effects),
    ).resolves.toBe(1);
  });

  it.each([
    { generation: "1", guard: "0", version: "9007199254740993", deleted: false },
    { generation: "2", guard: "0", version: "9007199254740994", deleted: true },
    { generation: "1", guard: "9007199254741000", version: "9007199254741000", deleted: true },
  ])("freezes source version and placement before applying policy %j", async (policy) => {
    const fixture = sourceOwner([
      [],
      [],
      [
        {
          source_id: sourceEvent.id,
          generation: policy.generation,
          recorded_at: sourceEvent.recordedAt,
        },
      ],
      policy.guard === "0" ? [] : [{ source_id: sourceEvent.id, version: policy.guard }],
    ]);
    const effects = await prepareMetricStreamSourceEffectsGroup(fixture.owner, [inputs[0]]);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      position: sourcePosition,
      cursor: { delivery: sourcePosition.delivery, effectOrdinal: "0" },
      sourceVersion: policy.version,
      before: null,
      after: {
        sourceVersion: policy.version,
        deleted: policy.deleted,
        key: {
          userId: sourceEvent.userId,
          channel: sourceEvent.channel,
          recordedAt: sourceEvent.recordedAt,
        },
      },
    });
    expect(await applyMetricStreamSourceEffectsGroup(fixture.owner, [inputs[0]], effects)).toBe(
      policy.deleted ? 0 : 1,
    );
    expect(fixture.rows[0]).toMatchObject({
      version: policy.version,
      is_deleted: policy.deleted ? 1 : 0,
      ingested_at: sourceIngestedAt,
    });
  });

  it("does not prepare or apply raw work for an erased account", async () => {
    const fixture = sourceOwner([
      [],
      [{ user_hash: createHash("sha256").update(sourceEvent.userId).digest("hex") }],
      inputs.map(({ event }) => ({
        source_id: event.id,
        generation: "1",
        recorded_at: event.recordedAt,
      })),
      [],
    ]);
    const effects = await prepareMetricStreamSourceEffectsGroup(fixture.owner, inputs);
    expect(effects).toEqual([]);
    expect(await applyMetricStreamSourceEffectsGroup(fixture.owner, inputs, effects)).toBe(0);
    expect(fixture.executions).toEqual([]);
  });

  it("prepares exact ordered scalar members and applies their frozen row times and versions", async () => {
    const fixture = policyFixture();
    const effects = await prepareMetricStreamSourceEffectsGroup(fixture.owner, inputs);
    expect(
      effects.map((effect) => ({
        sourceId: effect.sourceId,
        position: effect.position,
        version: effect.sourceVersion,
      })),
    ).toEqual(
      inputs.map(({ event, position }) => ({
        sourceId: event.id,
        position,
        version: "9007199254740993",
      })),
    );
    expect(await applyMetricStreamSourceEffectsGroup(fixture.owner, inputs, effects)).toBe(2);
    expect(fixture.executions).toHaveLength(1);
    expect(fixture.executions[0]?.clickhouse_settings).toMatchObject({ insert_deduplicate: 0 });
    expect(fixture.rows).toMatchObject([
      {
        id: sourceEvent.id,
        scalar: 72,
        ingested_at: sourceIngestedAt,
        version: "9007199254740993",
      },
      {
        id: second.id,
        scalar: 73,
        ingested_at: inputs[1]?.ingestedAt,
        version: "9007199254740993",
      },
    ]);
  });

  it("rejects duplicate source identity before any policy query", async () => {
    const fixture = sourceOwner();
    await expect(
      prepareMetricStreamSourceEffectsGroup(fixture.owner, [
        inputs[0],
        { ...inputs[1], event: sourceEvent },
      ]),
    ).rejects.toThrow(/distinct source/i);
    expect(fixture.requests).toEqual([]);
  });

  it("rejects reversed native order before any policy query", async () => {
    const fixture = sourceOwner();
    await expect(
      prepareMetricStreamSourceEffectsGroup(fixture.owner, [...inputs].reverse()),
    ).rejects.toThrow(/increasing native positions/i);
    expect(fixture.requests).toEqual([]);
  });

  it("fails an incomplete generation policy without creating raw work", async () => {
    const fixture = sourceOwner([
      [],
      [],
      [{ source_id: sourceEvent.id, generation: "1", recorded_at: sourceEvent.recordedAt }],
    ]);
    await expect(prepareMetricStreamSourceEffectsGroup(fixture.owner, inputs)).rejects.toThrow(
      /generation policy is incomplete/i,
    );
    expect(fixture.executions).toEqual([]);
  });

  it("refuses changed native identity before dispatching prepared raw work", async () => {
    const fixture = policyFixture();
    const effects = await prepareMetricStreamSourceEffectsGroup(fixture.owner, inputs);
    const first = effects[0];
    if (!first) throw new Error("Missing prepared source fixture");
    await expect(
      applyMetricStreamSourceEffectsGroup(fixture.owner, inputs, [
        { ...first, position: analyticsPosition(sourcePosition, 3n) },
      ]),
    ).rejects.toThrow(/mismatched prepared source effects/i);
    expect(fixture.executions).toEqual([]);
  });
});
