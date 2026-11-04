import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AnalyticsQueryOwner } from "../analytics/analytics-query-owner.ts";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { createMetricStreamEvent } from "./events.ts";
import {
  applyMetricStreamSourceEffectsGroup,
  prepareMetricStreamSourceEffectsGroup,
} from "./source-effects-group.ts";

const id = (value: number) => `10000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const userId = id(9999);
const input = (index: number) => ({
  event: createMetricStreamEvent(
    {
      id: id(index),
      userId,
      providerId: "reported",
      channel: "heart_rate",
      sourceType: "api",
      recordedAt: "2026-11-03T00:00:00.123456Z",
      scalar: 80,
    },
    "4503599627370497",
  ),
  position: {
    transport: "pulsar" as const,
    epoch: "epoch",
    topic: "metric",
    partition: 0,
    serializedMessageId: Buffer.from(`native-${index}`).toString("base64"),
    delivery: { major: "1", minor: String(index), batch: -1 },
  },
  ingestedAt: `2026-11-04T00:00:00.${String(index).padStart(9, "0")}Z`,
});

function fixture(
  options: {
    erased?: boolean;
    generation?: string;
    guard?: string;
    beforeVersion?: string;
    conflict?: boolean;
  } = {},
) {
  const queries: Parameters<ClickHouseClient["query"]>[0][] = [];
  const commands: { options: Parameters<ClickHouseClient["command"]>[0]; rows: unknown[] }[] = [];
  const client: ClickHouseClient = {
    async query<TRow extends object>(request: Parameters<ClickHouseClient["query"]>[0]) {
      queries.push(request);
      let rows: unknown[] = [];
      const params = request.query_params ?? {};
      if (request.query.includes("groupUniqArrayArray")) {
        const ids = Array.isArray(params.ids) ? params.ids : [];
        if (options.beforeVersion)
          rows = ids.map((source_id) => ({
            source_id,
            owners: [options.conflict ? id(8888) : userId],
            placements: [
              [
                options.conflict ? id(8888) : userId,
                "former-provider",
                options.beforeVersion,
                "0",
                "heart_rate",
                "2026-11-02T00:00:00.000000Z",
                null,
                0,
              ],
            ],
          }));
      } else if (request.query.includes("account_erasure_fence")) {
        rows = options.erased
          ? [{ user_hash: createHash("sha256").update(userId).digest("hex") }]
          : [];
      } else if (request.query.includes("provider_data_generation")) {
        const ids = Array.isArray(params.ids) ? params.ids : [];
        rows = ids.map((source_id) => ({
          source_id,
          generation: options.generation ?? "0",
          recorded_at: "2026-11-03T00:00:00.123456Z",
        }));
      } else if (request.query.includes("metric_stream_delete_scope")) {
        const ids = Array.isArray(params.ids) ? params.ids : [];
        rows = options.guard ? ids.map((source_id) => ({ source_id, version: options.guard })) : [];
      } else throw new Error("Unexpected policy query");
      return {
        async json() {
          return z.array(z.custom<TRow>()).parse(rows);
        },
      };
    },
    async command(request) {
      const rows: unknown[] = [];
      if (request.values)
        for await (const chunk of request.values) {
          for (const line of String(chunk).trim().split("\n")) rows.push(JSON.parse(line));
        }
      commands.push({ options: request, rows });
    },
  };
  const owner: AnalyticsQueryOwner = {
    client,
    ingestedAt: "MUST NOT USE GROUP TIMESTAMP",
    assertActive: vi.fn(async () => {}),
    reserveIngestionThrough: vi.fn().mockResolvedValue(undefined),
  };
  return { owner, queries, commands };
}

describe("metric-stream source-effect groups", () => {
  it("prepares500 unique rows with one placement read and three set policy reads", async () => {
    const context = fixture();
    const inputs = Array.from({ length: 500 }, (_, index) => input(index + 1));
    const effects = await prepareMetricStreamSourceEffectsGroup(context.owner, inputs);
    expect(effects).toHaveLength(500);
    expect(context.queries).toHaveLength(4);
    expect(context.queries[0]?.query_params?.ids).toEqual(inputs.map(({ event }) => event.id));
    expect(
      effects.map((effect) => [effect.sourceVersion, effect.cursor.effectOrdinal, effect.position]),
    ).toEqual(inputs.map(({ position }) => ["9007199254740995", "0", position]));
  });

  it.each(["duplicate", "reversed", "mixed-stream", "control", "oversized"])(
    "rejects%s before policy reads or writes",
    async (kind) => {
      const context = fixture();
      const first = input(1);
      const second = input(2);
      const inputs =
        kind === "oversized"
          ? Array.from({ length: 501 }, (_, index) => input(index + 1))
          : [first, second];
      if (kind === "duplicate") second.event.id = first.event.id;
      if (kind === "reversed") inputs.reverse();
      if (kind === "mixed-stream") second.position.topic = "other";
      const invalid =
        kind === "control"
          ? [{ ...first, event: { ...first.event, eventType: "metric_stream_deleted" } }]
          : inputs;
      await expect(prepareMetricStreamSourceEffectsGroup(context.owner, invalid)).rejects.toThrow();
      await expect(
        applyMetricStreamSourceEffectsGroup(context.owner, invalid, []),
      ).rejects.toThrow();
      expect(context.queries).toHaveLength(0);
      expect(context.commands).toHaveLength(0);
    },
  );

  it("preserves old placement and creates generation/delete tombstones without rounding versions", async () => {
    const context = fixture({
      beforeVersion: "9007199254740993",
      generation: "2",
      guard: "9007199254741000",
    });
    const effects = await prepareMetricStreamSourceEffectsGroup(context.owner, [input(1)]);
    expect(effects[0]?.before?.providerId).toBe("former-provider");
    expect(effects[0]?.after).toMatchObject({
      sourceVersion: "9007199254741000",
      deleted: true,
      generation: "0",
    });
  });

  it.each([
    { generation: "0", guard: "4", expected: "9007199254740995", deleted: false },
    { generation: "1", guard: "4", expected: "9007199254740996", deleted: true },
    { generation: "0", guard: "9007199254740996", expected: "9007199254740996", deleted: true },
  ])(
    "preserves missing/current generation and older/newer scope semantics %j",
    async ({ generation, guard, expected, deleted }) => {
      const context = fixture({ generation, guard });
      const effects = await prepareMetricStreamSourceEffectsGroup(context.owner, [input(1)]);
      expect(effects[0]?.after).toMatchObject({ sourceVersion: expected, deleted });
    },
  );

  it("omits erased, imu and strictly older events and rejects owner conflicts", async () => {
    expect(
      await prepareMetricStreamSourceEffectsGroup(fixture({ erased: true }).owner, [input(1)]),
    ).toEqual([]);
    expect(
      await prepareMetricStreamSourceEffectsGroup(
        fixture({ beforeVersion: "9007199254740996" }).owner,
        [input(1)],
      ),
    ).toEqual([]);
    const imu = input(1);
    imu.event.channel = "imu";
    const context = fixture();
    expect(await prepareMetricStreamSourceEffectsGroup(context.owner, [imu])).toEqual([]);
    expect(context.queries).toHaveLength(0);
    await expect(
      prepareMetricStreamSourceEffectsGroup(fixture({ beforeVersion: "0", conflict: true }).owner, [
        input(1),
      ]),
    ).rejects.toThrow(/conflicting account owners/);
  });

  it("maps distinct timestamps and nullable payloads into one finite raw insert", async () => {
    const context = fixture();
    const first = input(1);
    const second = input(2);
    second.event.scalar = null;
    second.event.vector = null;
    second.event.point = null;
    second.event.metadata = null;
    const inputs = [first, second];
    const effects = await prepareMetricStreamSourceEffectsGroup(context.owner, inputs);
    expect(await applyMetricStreamSourceEffectsGroup(context.owner, inputs, effects)).toBe(2);
    expect(context.commands).toHaveLength(1);
    expect(context.commands[0]?.rows).toMatchObject([
      { id: first.event.id, ingested_at: first.ingestedAt, version: "9007199254740995" },
      {
        id: second.event.id,
        ingested_at: second.ingestedAt,
        scalar: null,
        vector: [],
        point: "",
        metadata: "null",
      },
    ]);
    expect(context.commands[0]?.options.values).toBeInstanceOf(Readable);
  });

  it("rejects mismatched prepared effects before a raw write", async () => {
    const context = fixture();
    const effects = await prepareMetricStreamSourceEffectsGroup(context.owner, [input(1)]);
    const effect = effects[0];
    if (!effect) throw new Error("Missing prepared effect");
    await expect(
      applyMetricStreamSourceEffectsGroup(context.owner, [input(2)], [effect]),
    ).rejects.toThrow();
    expect(context.commands).toHaveLength(0);
  });
});
