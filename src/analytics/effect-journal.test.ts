import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateEffectBatch } from "./effect-journal.ts";
import { analyticsEffect, analyticsPosition } from "./test-helpers.ts";

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
      expect(() => validateEffectBatch(batch)).toThrow(/duplicate effect/i);
    },
  );
  it("rejectsNegativeActualEffectOrdinalsBeforeWriting", async () => {
    const effect = analyticsEffect(analyticsPosition(stream, 0n), -1n, randomUUID());
    expect(() => validateEffectBatch([effect])).toThrow(/effectOrdinal/);
  });
  it("rejectsAReplacementOwnedByAnotherAccountBeforeWriting", async () => {
    const effect = analyticsEffect(analyticsPosition(stream, 0n), 0n, randomUUID());
    const after = effect.after;
    if (!after) throw new Error("Missing owned source fixture");
    const otherUserId = randomUUID();
    expect(() =>
      validateEffectBatch([
        {
          ...effect,
          before: after,
          after: {
            ...after,
            userId: otherUserId,
            key: { ...after.key, userId: otherUserId },
          },
        },
      ]),
    ).toThrow(/ownership/);
  });
});
