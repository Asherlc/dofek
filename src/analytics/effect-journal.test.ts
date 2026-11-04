import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { appendAnalyticsEffects } from "./effect-journal.ts";
import { analyticsEffect, analyticsPosition } from "./test-helpers.ts";

const client: ClickHouseClient = {
  command: async () => {
    throw new Error("Unexpected external I/O");
  },
  query: async () => {
    throw new Error("Unexpected external I/O");
  },
  insert: async () => {
    throw new Error("Unexpected external I/O");
  },
};
const stream = { epoch: "epoch-1", topic: "persistent://public/default/test", partition: -1 };
describe("analytics effect validation", () => {
  it("rejectsNegativeActualEffectOrdinalsBeforeWriting", async () => {
    const effect = analyticsEffect(analyticsPosition(stream, 0n), -1n, randomUUID());
    await expect(appendAnalyticsEffects(client, [effect])).rejects.toThrow(/effectOrdinal/);
  });
  it("rejectsAReplacementOwnedByAnotherAccountBeforeWriting", async () => {
    const effect = analyticsEffect(analyticsPosition(stream, 0n), 0n, randomUUID());
    if (!effect.after) throw new Error("Missing owned source fixture");
    const otherUserId = randomUUID();
    await expect(
      appendAnalyticsEffects(client, [
        {
          ...effect,
          before: effect.after,
          after: {
            ...effect.after,
            userId: otherUserId,
            key: { ...effect.after.key, userId: otherUserId },
          },
        },
      ]),
    ).rejects.toThrow(/ownership/);
  });
});
