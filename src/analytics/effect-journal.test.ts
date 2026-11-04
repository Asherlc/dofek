import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { appendAnalyticsDelivery, appendAnalyticsEffects } from "./effect-journal.ts";
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
const stream = {
  transport: "pulsar" as const,
  epoch: "epoch-1",
  topic: "persistent://public/default/test",
  partition: -1,
};
describe("analytics effect validation", () => {
  it.each(["identical", "conflicting"] as const)(
    "rejectsDuplicateBatchIdentitiesBeforeAnyIo: %s",
    async (kind) => {
      const position = analyticsPosition(stream, 0n);
      const effect = analyticsEffect(position, 0n, randomUUID());
      if (!effect.after) throw new Error("Missing source fixture");
      const duplicate =
        kind === "identical"
          ? effect
          : {
              ...effect,
              sourceVersion: "9007199254740994",
              after: { ...effect.after, sourceVersion: "9007199254740994" },
            };
      const batch = [analyticsEffect(position, 1n, randomUUID()), effect, duplicate];
      await expect(appendAnalyticsEffects(client, batch)).rejects.toThrow(
        /duplicate effect identit/i,
      );
      await expect(appendAnalyticsDelivery(client, { position, effects: batch })).rejects.toThrow(
        /duplicate effect identit/i,
      );
    },
  );
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
