import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import {
  deliveryParams,
  effectHash,
  hasCompleteAnalyticsDeliveryReceipt,
  persistAnalyticsEffectPage,
  prepareAnalyticsDelivery,
  readPreparedAnalyticsEffectPages,
  readReferencedEffects,
  recordAnalyticsEffectOutcomes,
  validateEffectBatch,
} from "./effect-journal.ts";
import { verifyAnalyticsDeliveryReceipts } from "./effect-journal-group.ts";
import { analyticsEffect, analyticsPosition } from "./test-helpers.ts";

const stream = {
  transport: "pulsar" as const,
  epoch: "epoch-1",
  topic: "persistent://public/default/test",
  partition: -1,
};
describe("analytics effect validation", () => {
  it("records generation filtering against the original selected attempt and effect hash", async () => {
    const effect = analyticsEffect(analyticsPosition(stream, 5n), 0n, randomUUID());
    const attempt = randomUUID();
    const written: object[] = [];
    const manifest = {
      ...deliveryParams(effect.position),
      preparation_attempt: attempt,
      serialized_message_id: effect.position.serializedMessageId,
      effect_count: "1",
      chunk_count: "1",
      effect_digest: createHash("sha256").update(effectHash(effect)).digest("hex"),
      stages: ["scalar"],
    };
    const client: ClickHouseClient = {
      exec: async () => {
        throw new Error("Unexpected exec");
      },
      command: async () => {
        throw new Error("Unexpected command");
      },
      query: async ({ query }) => ({
        json: async () =>
          JSON.parse(JSON.stringify(query.includes("AND status='prepared'") ? [manifest] : [])),
      }),
      insert: async ({ values }) => {
        written.push(...values);
      },
    };
    await recordAnalyticsEffectOutcomes(client, [effect], "generation_filtered");
    expect(written).toEqual([
      expect.objectContaining({
        preparation_attempt: attempt,
        effect_hash: effectHash(effect),
        user_id: effect.after?.userId,
        outcome: "generation_filtered",
        effect_ordinal: "0",
        is_empty: 0,
      }),
    ]);
    await expect(
      recordAnalyticsEffectOutcomes(client, [effect], JSON.parse('"fenced"')),
    ).rejects.toThrow();
    expect(written).toHaveLength(1);
  });
  it.each([false, true])(
    "keeps complete control hashes and ordinals after redaction, all fenced: %s",
    async (allFenced) => {
      const position = analyticsPosition(stream, 3n);
      const first = analyticsEffect(position, 0n, randomUUID());
      const second = analyticsEffect(position, 1n, randomUUID());
      const attempt = randomUUID();
      const refs = [first, second].map((effect, index) => ({
        ...deliveryParams(position),
        preparation_attempt: attempt,
        effect_ordinal: String(index),
        stage: "scalar" as const,
        effect_hash: effectHash(effect),
        is_empty: 0,
        user_id: index === 0 || allFenced ? null : (effect.after?.userId ?? null),
        outcome: index === 0 || allFenced ? ("fenced" as const) : ("written" as const),
      }));
      const manifest = {
        ...deliveryParams(position),
        preparation_attempt: attempt,
        serialized_message_id: position.serializedMessageId,
        effect_count: "2",
        chunk_count: "2",
        effect_digest: createHash("sha256")
          .update(effectHash(first))
          .update(effectHash(second))
          .digest("hex"),
        stages: ["scalar"],
      };
      const journal = {
        ...deliveryParams(position),
        preparation_attempt: attempt,
        effect_ordinal: "1",
        stage: "scalar",
        serialized_message_id: position.serializedMessageId,
        operation_id: null,
        user_id: second.after?.userId,
        source_id: second.sourceId,
        source_version: second.sourceVersion,
        generation: second.generation,
        before: null,
        after: JSON.stringify(second.after),
        effect_hash: effectHash(second),
      };
      const client: ClickHouseClient = {
        exec: async () => {
          throw new Error("Unexpected exec");
        },
        command: async () => {
          throw new Error("Unexpected command");
        },
        query: async ({ query, query_params }) => ({
          json: async () =>
            JSON.parse(
              JSON.stringify(
                query.includes("FROM analytics.delivery_receipt")
                  ? [manifest]
                  : query.startsWith("SELECT * FROM analytics.effect_journal FINAL")
                    ? [journal]
                    : BigInt(String(query_params?.afterOrdinal ?? "-1")) >= 1n
                      ? []
                      : refs,
              ),
            ),
        }),
      };
      const applicable = [];
      for await (const page of readPreparedAnalyticsEffectPages(client, position))
        applicable.push(...page);
      expect(applicable).toEqual(allFenced ? [] : [second]);
      expect(await hasCompleteAnalyticsDeliveryReceipt(client, position)).toBe(true);
      await expect(verifyAnalyticsDeliveryReceipts(client, [position])).resolves.toBeUndefined();
    },
  );

  it("fails when a non-fenced structural reference has lost its journal payload", async () => {
    const effect = analyticsEffect(analyticsPosition(stream, 4n), 0n, randomUUID());
    await expect(
      readReferencedEffects({ query: async () => ({ json: async () => [] }) }, [
        {
          ...deliveryParams(effect.position),
          preparation_attempt: randomUUID(),
          effect_ordinal: "0",
          stage: "scalar",
          effect_hash: effectHash(effect),
          is_empty: 0,
          user_id: effect.after?.userId ?? null,
          outcome: "written",
        },
      ]),
    ).rejects.toThrow(/Missing analytics journal effect/);
  });
  it("retains a fenced structural reference without requiring erased journal payload", async () => {
    const effect = analyticsEffect(analyticsPosition(stream, 1n), 0n, randomUUID());
    const reference = {
      ...deliveryParams(effect.position),
      preparation_attempt: "00000000-0000-0000-0000-000000000000",
      effect_ordinal: "0",
      stage: "scalar" as const,
      effect_hash: effectHash(effect),
      is_empty: 0,
      user_id: null,
      outcome: "fenced" as const,
    };
    const client: Pick<ClickHouseClient, "query"> = {
      query: async () => {
        throw new Error("Fenced references must not load erased payload");
      },
    };
    expect(await readReferencedEffects(client, [reference])).toEqual([{ reference, effect: null }]);
  });

  it("does not restore account ownership over an existing fenced reference", async () => {
    const effect = analyticsEffect(analyticsPosition(stream, 1n), 0n, randomUUID());
    let inserts = 0;
    const key = {
      ...deliveryParams(effect.position),
      preparation_attempt: "00000000-0000-0000-0000-000000000000",
      effect_ordinal: "0",
      stage: "scalar",
    };
    const client: ClickHouseClient = {
      exec: async () => {
        throw new Error("Unexpected exec");
      },
      command: async () => {
        throw new Error("Unexpected command");
      },
      insert: async () => {
        inserts++;
      },
      query: async ({ query }) => ({
        json: async () =>
          JSON.parse(
            JSON.stringify(
              query.includes("FROM analytics.effect_receipt")
                ? [
                    {
                      ...key,
                      effect_hash: effectHash(effect),
                      outcome: "fenced",
                      user_id: null,
                      is_empty: 0,
                    },
                  ]
                : [],
            ),
          ),
      }),
    };
    await expect(
      persistAnalyticsEffectPage(client, [effect], "commit", key.preparation_attempt, "written"),
    ).rejects.toThrow(/fenced/i);
    expect(inserts).toBe(0);
  });

  it("uses a new attempt for incomplete control preparation and freezes its completed attempt", async () => {
    const position = analyticsPosition(stream, 2n);
    const first = analyticsEffect(position, 0n, randomUUID());
    const second = analyticsEffect(position, 0n, randomUUID());
    const stored = new Map<string, Record<string, unknown>[]>();
    let selectedAttempt: unknown;
    const client: ClickHouseClient = {
      exec: async () => {
        throw new Error("Unexpected exec");
      },
      command: async () => {
        throw new Error("Unexpected command");
      },
      insert: async ({ table, values }) => {
        stored.set(table, [...(stored.get(table) ?? []), ...values.map((value) => ({ ...value }))]);
      },
      query: async ({ query, query_params }) => {
        let rows: Record<string, unknown>[] = [];
        if (query.includes("FROM analytics.delivery_receipt"))
          rows = (stored.get("analytics.delivery_receipt") ?? []).filter(
            (row) => row.status === query_params?.status,
          );
        else if (query.includes("FROM analytics.effect_journal AS intent")) {
          selectedAttempt = query_params?.preparationAttempt;
          rows = (stored.get("analytics.effect_journal") ?? [])
            .filter(
              (row) =>
                row.preparation_attempt === selectedAttempt &&
                BigInt(String(row.effect_ordinal)) >
                  BigInt(String(query_params?.afterOrdinal ?? "-1")),
            )
            .map((row) => ({ ...row, is_empty: 0, outcome: "written" }));
        } else if (query.startsWith("SELECT * FROM analytics.effect_journal"))
          rows = (stored.get("analytics.effect_journal") ?? []).filter(
            (row) => row.preparation_attempt === selectedAttempt,
          );
        return { json: async () => JSON.parse(JSON.stringify(rows)) };
      },
    };
    const interrupted = new Error("Incomplete control enumeration");
    await expect(
      prepareAnalyticsDelivery(client, {
        position,
        preparation: "control",
        pages: async function* () {
          yield [first];
          throw interrupted;
        },
      }),
    ).rejects.toBe(interrupted);
    await prepareAnalyticsDelivery(client, {
      position,
      preparation: "control",
      pages: async function* () {
        yield [second];
      },
    });
    const journal = stored.get("analytics.effect_journal") ?? [];
    expect(journal).toHaveLength(2);
    expect(journal[0]?.preparation_attempt).not.toBe(journal[1]?.preparation_attempt);
    const manifests = stored.get("analytics.delivery_receipt") ?? [];
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.preparation_attempt).toBe(journal[1]?.preparation_attempt);
    let regenerated = false;
    await prepareAnalyticsDelivery(client, {
      position,
      preparation: "control",
      pages: async function* () {
        regenerated = true;
        yield [first];
      },
    });
    expect(regenerated).toBe(false);
    expect(stored.get("analytics.effect_journal")).toHaveLength(2);
  });
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
