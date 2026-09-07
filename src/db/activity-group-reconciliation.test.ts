import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { reconcileActivityGroups } from "./activity-group-reconciliation.ts";

const userId = "10000000-0000-4000-8000-000000000001";
const first = "20000000-0000-4000-8000-000000000001";
const second = "20000000-0000-4000-8000-000000000002";
const group = "30000000-0000-4000-8000-000000000001";
const newerGroup = "30000000-0000-4000-8000-000000000002";
const createdAt = "2026-09-01T10:00:00Z";

function memberRow(id: string, groupId = group, anchorId = first) {
  return {
    id,
    group_id: groupId,
    created_at: createdAt,
    group_created_at: createdAt,
    anchor_activity_id: anchorId,
  };
}

function databaseWithRows(responses: unknown[][]) {
  const execute = vi.fn(async (_query: SQL) => responses.shift() ?? []);
  return {
    execute,
    queries: () => execute.mock.calls.map(([query]) => new PgDialect().sqlToQuery(query)),
  };
}

describe("activity group reconciliation adapter", () => {
  it("translates stored member and oldest-anchor metadata into durable merge decisions", async () => {
    const responses: unknown[][] = [
      [],
      [
        {
          id: first,
          group_id: group,
          created_at: createdAt,
          group_created_at: createdAt,
          anchor_activity_id: first,
        },
        {
          id: second,
          group_id: newerGroup,
          created_at: "2026-09-02T10:00:00Z",
          group_created_at: "2026-09-02T10:00:00Z",
          anchor_activity_id: second,
        },
      ],
      [{ activity_id: first, overlapping_activity_id: second }],
      [],
    ];
    const execute = vi.fn(async (_query: SQL) => responses.shift() ?? []);
    await reconcileActivityGroups({ execute }, userId);
    const calls = execute.mock.calls.map((call) => new PgDialect().sqlToQuery(call[0]));
    expect(calls.find((call) => call.sql.includes("UPDATE fitness.activity"))?.params).toEqual([
      group,
      userId,
      first,
      second,
      group,
    ]);
    expect(
      calls.find((call) => call.sql.includes("INSERT INTO fitness.activity_group_alias"))?.params,
    ).toEqual([newerGroup, group, userId]);
  });

  it("propagates storage failures before applying membership writes", async () => {
    const error = new Error("database unavailable");
    const execute = vi.fn().mockRejectedValue(error);
    await expect(reconcileActivityGroups({ execute }, userId)).rejects.toBe(error);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("creates a split group before assigning its members", async () => {
    const database = databaseWithRows([
      [],
      [memberRow(first), memberRow(second)],
      [],
      [],
      [{ id: newerGroup }],
    ]);
    await reconcileActivityGroups(database, userId);
    const writes = database.queries().filter((query) => /INSERT|UPDATE/.test(query.sql));
    expect(writes.map((query) => query.params)).toEqual([
      [userId, second],
      [newerGroup, userId, second, newerGroup],
    ]);
    expect(writes[0]?.sql).toContain("INSERT INTO fitness.activity_group");
    expect(writes[1]?.sql).toContain("UPDATE fitness.activity");
  });

  it("fails a split without changing membership when group allocation returns no identity", async () => {
    const database = databaseWithRows([[], [memberRow(first), memberRow(second)], [], [], []]);
    await expect(reconcileActivityGroups(database, userId)).rejects.toThrow(
      "Activity group insert did not return an ID",
    );
    expect(database.queries().filter((query) => query.sql.includes("UPDATE"))).toEqual([]);
  });

  it("avoids rewriting already reconciled memberships", async () => {
    const database = databaseWithRows([[], [memberRow(first)], [], []]);
    await reconcileActivityGroups(database, userId);
    expect(database.queries().filter((query) => /INSERT|UPDATE/.test(query.sql))).toEqual([]);
  });

  it("resolves a historical alias chain to its terminal group before assigning membership", async () => {
    const terminal = "30000000-0000-4000-8000-000000000003";
    const database = databaseWithRows([
      [],
      [memberRow(first)],
      [],
      [
        { alias_id: group, group_id: newerGroup },
        { alias_id: newerGroup, group_id: terminal },
      ],
    ]);
    await reconcileActivityGroups(database, userId);
    expect(
      database.queries().find((query) => query.sql.includes("UPDATE fitness.activity"))?.params,
    ).toEqual([terminal, userId, first, terminal]);
  });

  it("rejects stored alias cycles without changing membership", async () => {
    const database = databaseWithRows([
      [],
      [memberRow(first)],
      [],
      [
        { alias_id: group, group_id: newerGroup },
        { alias_id: newerGroup, group_id: group },
      ],
    ]);
    await expect(reconcileActivityGroups(database, userId)).rejects.toThrow(
      "Activity group alias cycle",
    );
    expect(database.queries().filter((query) => /INSERT|UPDATE/.test(query.sql))).toEqual([]);
  });
});
