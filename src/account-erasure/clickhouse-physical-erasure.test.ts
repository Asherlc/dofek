import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "../db/index.ts";
import { sourceOwner } from "../metric-stream/test-helpers.ts";
import {
  classifyClickHouseManagedTableEngine,
  executeClickHousePhysicalErasure,
} from "./clickhouse-physical-erasure.ts";
import { AccountErasureIdentifierStore } from "./identifier-store.ts";
import type {
  AccountErasurePhysicalIntent,
  AccountErasurePhysicalMutation,
  AccountErasurePhysicalPart,
  PhysicalFamily,
  PhysicalPage,
  PhysicalValue,
} from "./retained-state.ts";

describe("classifyClickHouseManagedTableEngine", () => {
  it("registers receipt redaction in the existing physical intent and leaves failed mutation pending", async () => {
    const database = createDatabase("postgres://unit:unit@localhost/unit");
    const store = new AccountErasureIdentifierStore(database, {
      requestId: randomUUID(),
      leaseOwner: randomUUID(),
      pageSize: 500,
    });
    const intent = [
      "initial",
      "analytics",
      "effect_receipt",
      randomUUID(),
      "0".repeat(64),
      "user",
    ] as const;
    const key = "a".repeat(64);
    vi.spyOn(store, "loadPhysicalProgress").mockResolvedValue({
      step: "apply",
      afterIntentKey: null,
      pending: null,
    });
    function readPage(
      family: "physical_intent",
    ): Promise<PhysicalPage<AccountErasurePhysicalIntent>>;
    function readPage(family: "physical_part"): Promise<PhysicalPage<AccountErasurePhysicalPart>>;
    function readPage(
      family: "physical_mutation",
    ): Promise<PhysicalPage<AccountErasurePhysicalMutation>>;
    async function readPage(family: PhysicalFamily): Promise<PhysicalPage<PhysicalValue>> {
      return {
        entries: family === "physical_intent" ? [{ key, value: intent }] : [],
        nextCursor: null,
      };
    }
    vi.spyOn(store, "readPhysicalPage").mockImplementation(readPage);
    const start = vi.spyOn(store, "startPhysicalIntent").mockResolvedValue(undefined);
    const admit = vi.spyOn(store, "admitPhysicalIntent").mockResolvedValue(true);
    const finish = vi.spyOn(store, "finishPhysicalIntent").mockResolvedValue(undefined);
    const fixture = sourceOwner();
    fixture.owner.client.query = async ({ query }) => ({
      json: async () =>
        JSON.parse(
          JSON.stringify(
            query.includes("SELECT count()")
              ? [
                  {
                    count: query.startsWith(
                      "SELECT count() AS count FROM `analytics`.`effect_receipt` WHERE",
                    )
                      ? 1
                      : 0,
                  },
                ]
              : query.includes("SELECT max(length")
                ? [{ max_bytes: 0 }]
                : [],
          ),
        ),
    });
    const failure = new Error("Redaction request failed");
    fixture.owner.client.command = async ({ query }) => {
      if (query.startsWith("ALTER TABLE")) {
        expect(start).toHaveBeenCalled();
        expect(admit).toHaveBeenCalled();
        expect(query).toContain("UPDATE user_id=NULL,outcome='fenced' WHERE");
        throw failure;
      }
    };
    try {
      await expect(
        executeClickHousePhysicalErasure(
          fixture.owner,
          store,
          "initial",
          async () => ({
            intent,
            mutation: "redact-receipt",
            predicate: {
              sql: "user_id={user:UUID}",
              queryParameters: { user: randomUUID() },
              mutationSql: "user_id={user:UUID}",
              mutationQueryParameters: { user: randomUUID() },
            },
          }),
          async () => undefined,
          { pollIntervalMilliseconds: 1, waitTimeoutMilliseconds: 1, maximumPasses: 1 },
        ),
      ).rejects.toBe(failure);
      expect(finish).not.toHaveBeenCalled();
    } finally {
      await database.$client.end();
    }
  });
  it.each([
    ["MaterializedView", "non-storage"],
    ["Null", "non-storage"],
    ["View", "non-storage"],
    ["MergeTree", "merge-tree"],
    ["ReplacingMergeTree", "merge-tree"],
    ["Memory", "unsupported-storage"],
  ] as const)("classifies %s", (engine, expected) => {
    expect(classifyClickHouseManagedTableEngine(engine)).toBe(expected);
  });
});
