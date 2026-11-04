import { describe, expect, it } from "vitest";
import { deriveAnalyticsPageScope } from "./analytics-page-scope.ts";
import type { AnalyticsEffect, AnalyticsEffectPage } from "./effect-journal.ts";

const stream = {
  transport: "kafka" as const,
  epoch: "sensor-epoch",
  topic: "sensor",
  partition: 0,
};
const userId = "00000000-0000-4000-8000-000000000001";
const sourceId = "00000000-0000-4000-8000-000000000002";
const cursor = { delivery: { offset: "9007199254740993" }, effectOrdinal: "0" };
const effect: AnalyticsEffect = {
  stream,
  position: { ...stream, offset: "9007199254740993" },
  cursor,
  stage: "scalar",
  operationId: null,
  sourceId,
  sourceVersion: "9007199254740993",
  generation: "1",
  before: null,
  after: {
    sourceId,
    userId,
    providerId: "reported",
    sourceVersion: "9007199254740993",
    generation: "1",
    key: { userId, channel: "rr_interval_ms", recordedAt: "2026-01-01T00:00:00.123456789Z" },
    activityId: null,
    deleted: false,
  },
};
const input = {
  runId: userId,
  stage: "scalar" as const,
  stream,
  after: null,
  publicationRevision: "18446744073709551615",
};
function page(effects: AnalyticsEffect[] = [effect]): AnalyticsEffectPage {
  return { effects, next: cursor, exhausted: false };
}
describe("validated analytics page scope", () => {
  it("preserves both normalized keys and lossless source/cursor/publication values", () => {
    if (!effect.after) throw new Error("Missing fixture placement");
    const before = {
      ...effect.after,
      key: { ...effect.after.key, channel: "power", recordedAt: "2025-12-31T23:59:59.999999999Z" },
    };
    const result = deriveAnalyticsPageScope({
      ...input,
      page: page([
        { ...effect, before },
        { ...effect, before },
      ]),
    });
    expect(result?.vars.analytics_source_ids).toEqual([sourceId]);
    expect(result?.vars.analytics_keys).toEqual([
      { userId, channel: "power", recordedAt: "2025-12-31T23:59:59.999999999Z" },
      { userId, channel: "heart_rate", recordedAt: "2026-01-01T00:00:00.123456789Z" },
    ]);
    expect(result?.vars.analytics_publication_revision).toBe("18446744073709551615");
    expect(result?.next).toEqual(cursor);
  });
  it.each([undefined, "", "0", "01", "-1", "1.0", "18446744073709551616"])(
    "rejects publication %s",
    (publicationRevision) => {
      expect(() =>
        deriveAnalyticsPageScope({ ...input, publicationRevision, page: page() }),
      ).toThrow(/publication/i);
    },
  );
  it("keeps an advancing empty-receipt page with no source keys", () => {
    const next = { delivery: { offset: "9007199254740994" }, effectOrdinal: "-1" };
    const result = deriveAnalyticsPageScope({
      ...input,
      after: cursor,
      page: { effects: [], next, exhausted: false },
    });
    expect(result).toMatchObject({
      next,
      exhausted: false,
      vars: { analytics_source_ids: [], analytics_keys: [] },
    });
  });
  it("returns no compilable page when capture has not advanced", () => {
    expect(
      deriveAnalyticsPageScope({
        ...input,
        after: cursor,
        page: { effects: [], next: cursor, exhausted: true },
      }),
    ).toBeNull();
  });
  it("rejects a captured next from another transport", () => {
    expect(() =>
      deriveAnalyticsPageScope({
        ...input,
        page: {
          ...page(),
          next: { delivery: { major: "1", minor: "2", batch: -1 }, effectOrdinal: "0" },
        },
      }),
    ).toThrow(/transport/i);
  });
  it("rejects an effect outside its captured stage", () => {
    expect(() =>
      deriveAnalyticsPageScope({ ...input, page: page([{ ...effect, stage: "dedup" }]) }),
    ).toThrow(/stage/i);
  });
});
