import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { makeTransactionalTestDatabase } from "../providers/test-helpers.ts";
import { persistClimbingLogSnapshot } from "./climbing-log-snapshot.ts";
import type { ClimbingLogSyncInput } from "./climbing-log-sync.ts";

const { persist } = vi.hoisted(() => ({ persist: vi.fn() }));
vi.mock("./climbing-log-sync.ts", () => ({ persistClimbingLogEntries: persist }));

describe("climbing snapshot parameter binding", () => {
  it("binds retained identities and scope to retirement and restoration commands", async () => {
    const input: ClimbingLogSyncInput = {
      userId: "00000000-0000-4000-8000-000000000001",
      providerId: "kaya",
      entries: [],
    };
    const retainedIds = ["kaya:session:1000:attempted:1000_2001"];
    persist.mockResolvedValueOnce({ logEntryIds: [], recordsSynced: 0 });
    const execute = vi.fn().mockResolvedValue([]);
    const db = makeTransactionalTestDatabase({
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute,
    });
    expect(await persistClimbingLogSnapshot(db, input, retainedIds)).toEqual({
      logEntryIds: [],
      recordsSynced: 0,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    const parameters = execute.mock.calls.map(
      ([query]) => new PgDialect().sqlToQuery(query).params,
    );
    expect(parameters).toEqual([
      [input.userId, input.providerId, [], retainedIds],
      [input.userId, input.providerId, retainedIds],
    ]);
  });
  it("binds a large logbook as one UUID array within the PostgreSQL parameter limit", async () => {
    const logEntryIds = Array.from(
      { length: 65_534 },
      (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    );
    const input: ClimbingLogSyncInput = {
      userId: "00000000-0000-4000-8000-000000000001",
      providerId: "snapshot-test",
      entries: logEntryIds.map((externalId) => ({ externalId, attempts: [{ scope: "climb" }] })),
    };
    const persisted = { logEntryIds, recordsSynced: logEntryIds.length };
    persist.mockResolvedValueOnce(persisted);
    const execute = vi.fn().mockResolvedValue([]);
    const db = makeTransactionalTestDatabase({
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute,
    });

    expect(await persistClimbingLogSnapshot(db, input)).toEqual(persisted);
    expect(persist).toHaveBeenCalledWith(db, input);
    const query = execute.mock.calls[0]?.[0];
    if (!query) throw new Error("The snapshot did not reconcile missing entries");
    const { params } = new PgDialect().sqlToQuery(query);
    expect(params.length).toBe(3);
    expect(params).toEqual([input.userId, input.providerId, logEntryIds]);
  });
});
