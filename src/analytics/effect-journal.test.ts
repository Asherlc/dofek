import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import {
  appendAnalyticsDelivery,
  appendAnalyticsEffects,
  readAnalyticsEffectPage,
} from "./effect-journal.ts";
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

describe("analytics page capture input boundary", () => {
  const valid = {
    runId: "00000000-0000-4000-8000-000000000001",
    stage: "scalar" as const,
    stream: { transport: "kafka" as const, epoch: "epoch", topic: "sensor", partition: 0 },
    after: { delivery: { offset: "9007199254740993" }, effectOrdinal: "0" },
    limit: 20,
  };
  const database = {
    execute: async () => {
      throw new Error("Unexpected frontier I/O");
    },
  };
  it.each([
    { name: "invalid run", input: { ...valid, runId: "not-a-run" }, error: /UUID/ },
    {
      name: "empty epoch",
      input: { ...valid, stream: { ...valid.stream, epoch: "" } },
      error: /epoch/,
    },
    {
      name: "negative Kafka partition",
      input: { ...valid, stream: { ...valid.stream, partition: -1 } },
      error: /partition/,
    },
    {
      name: "cursor transport mismatch",
      input: {
        ...valid,
        after: { delivery: { major: "1", minor: "2", batch: -1 }, effectOrdinal: "0" },
      },
      error: /transport/,
    },
    {
      name: "extra cursor field",
      input: { ...valid, after: { ...valid.after, stray: true } },
      error: /Unrecognized/,
    },
  ])("rejects $name before frontier or receipt reads", async ({ input, error }) => {
    await expect(readAnalyticsEffectPage({ clickhouse: client, database }, input)).rejects.toThrow(
      error,
    );
  });
});
