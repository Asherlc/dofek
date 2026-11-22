import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { makeTransactionalTestDatabase } from "../providers/test-helpers.ts";
import { persistClimbingLogSnapshot } from "./climbing-log-snapshot.ts";
import type { ClimbingLogSyncInput } from "./climbing-log-sync.ts";

const { persist, markAbsent, markPresent, loggerInfo } = vi.hoisted(() => ({
  persist: vi.fn(),
  markAbsent: vi.fn(),
  markPresent: vi.fn(),
  loggerInfo: vi.fn(),
}));
vi.mock("./climbing-log-sync.ts", () => ({ persistClimbingLogEntries: persist }));
vi.mock("./provider-activity-absence.ts", () => ({
  markProviderActivityAbsent: markAbsent,
  markProviderActivityPresent: markPresent,
}));
vi.mock("../logger.ts", () => ({ logger: { info: loggerInfo } }));

describe("persistClimbingLogSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
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
    expect(execute).toHaveBeenCalledTimes(3);
    const parameters = execute.mock.calls.map(
      ([query]) => new PgDialect().sqlToQuery(query).params,
    );
    expect(parameters).toEqual([
      [input.userId, input.providerId, [], retainedIds],
      [input.userId, input.providerId, retainedIds],
      [input.userId, input.providerId, retainedIds],
    ]);
    expect(loggerInfo).toHaveBeenCalledWith(
      "[climbing-log-snapshot] provider=kaya snapshotEntries=0 newlyAbsent=0 oldestNewlyAbsent=none",
    );
  });
  it("dispatches typed native observation presence to the shared lifecycle helpers", async () => {
    const input: ClimbingLogSyncInput = {
      userId: "00000000-0000-4000-8000-000000000001",
      providerId: "kilter",
      entries: [],
    };
    const persisted = { logEntryIds: ["00000000-0000-4000-8000-000000000002"], recordsSynced: 1 };
    persist.mockResolvedValueOnce(persisted);
    const observations: { external_id: string; absent: boolean }[] = [
      { external_id: "kilter:log:removed", absent: true },
      { external_id: "kilter:log:retained", absent: false },
    ];
    const execute = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(observations);
    const db = makeTransactionalTestDatabase({
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute,
    });
    expect(await persistClimbingLogSnapshot(db, input, ["kilter:log:retained"])).toBe(persisted);
    expect(markAbsent).toHaveBeenCalledExactlyOnceWith(db, {
      userId: input.userId,
      providerId: input.providerId,
      externalId: "kilter:log:removed",
    });
    expect(markPresent).toHaveBeenCalledExactlyOnceWith(db, {
      userId: input.userId,
      providerId: input.providerId,
      externalId: "kilter:log:retained",
    });
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
  it("logs the oldest newly absent date from unordered rows including a null date", async () => {
    const input: ClimbingLogSyncInput = {
      userId: "00000000-0000-4000-8000-000000000001",
      providerId: "kaya",
      entries: [{ externalId: "kaya:ascent:retained", attempts: [{ scope: "climb" }] }],
    };
    const logEntryIds = ["00000000-0000-4000-8000-000000000002"];
    persist.mockResolvedValueOnce({ logEntryIds, recordsSynced: input.entries.length });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        { external_id: "kaya:ascent:null-date", climbed_on: null },
        { external_id: "kaya:ascent:later", climbed_on: "2026-08-02" },
        { external_id: "kaya:ascent:earlier", climbed_on: "2020-01-01" },
      ])
      .mockResolvedValue([]);
    const db = makeTransactionalTestDatabase({
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute,
    });

    await persistClimbingLogSnapshot(db, input);
    expect(loggerInfo).toHaveBeenCalledWith(
      "[climbing-log-snapshot] provider=kaya snapshotEntries=1 newlyAbsent=3 oldestNewlyAbsent=2020-01-01",
    );
  });
  it("rejects a malformed reconciliation row through the real schema", async () => {
    const input: ClimbingLogSyncInput = {
      userId: "00000000-0000-4000-8000-000000000001",
      providerId: "kaya",
      entries: [],
    };
    persist.mockResolvedValueOnce({ logEntryIds: [], recordsSynced: 0 });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ external_id: 42, climbed_on: null }])
      .mockResolvedValue([]);
    const db = makeTransactionalTestDatabase({
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute,
    });

    await expect(persistClimbingLogSnapshot(db, input)).rejects.toBeInstanceOf(z.ZodError);
  });
});
