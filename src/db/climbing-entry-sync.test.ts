import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { persistClimbingSessionEntries } from "./climbing-entry-sync.ts";
import type { SyncDatabase } from "./index.ts";
import { climbingEntry } from "./schema/activity.ts";

const scope = { userId: "user-1", providerId: "kaya", activityId: "activity-1" };
const entry = {
  externalId: "ascent-1",
  climbType: "boulder" as const,
  gradeSystem: "v_scale" as const,
  grade: "V3",
};

function database(rows: { id: string }[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const execute = vi.fn().mockResolvedValue([]);
  const db: SyncDatabase = {
    select: vi.fn(),
    insert: vi.fn().mockReturnValue({ values }),
    delete: vi.fn(),
    execute,
  };
  return { db, values, execute, onConflictDoUpdate, returning };
}

describe("persistClimbingSessionEntries", () => {
  it("updates a complete session before reconciling its missing source records", async () => {
    const { db, values, execute, onConflictDoUpdate, returning } = database([{ id: "entry-1" }]);
    await persistClimbingSessionEntries(db, { ...scope, entries: [entry], complete: true });
    expect(values).toHaveBeenCalledExactlyOnceWith([
      { ...entry, ...scope, providerAbsentAt: null },
    ]);
    expect(execute).toHaveBeenCalledOnce();
    expect(onConflictDoUpdate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        target: [climbingEntry.activityId, climbingEntry.externalId],
        targetWhere: expect.anything(),
        setWhere: expect.anything(),
        set: expect.objectContaining({
          raw: expect.anything(),
          locationPath: expect.anything(),
          resultStyle: expect.anything(),
          providerAbsentAt: null,
        }),
      }),
    );
    expect(returning).toHaveBeenCalledExactlyOnceWith({ id: climbingEntry.id });
    const [reconciliation] = execute.mock.calls[0] ?? [];
    expect(new PgDialect().sqlToQuery(reconciliation).params).toEqual([
      scope.userId,
      scope.providerId,
      scope.activityId,
      entry.externalId,
    ]);
    expect(values.mock.invocationCallOrder[0]).toBeLessThan(
      Math.min(...execute.mock.invocationCallOrder),
    );
  });

  it("keeps earlier records present when a CSV response is incomplete", async () => {
    const { db, values, execute } = database([{ id: "entry-1" }]);
    await persistClimbingSessionEntries(db, { ...scope, entries: [entry], complete: false });
    expect(values).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it("reconciles a complete empty session", async () => {
    const { db, values, execute } = database([]);
    await persistClimbingSessionEntries(db, { ...scope, entries: [], complete: true });
    expect(values).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    const [reconciliation] = execute.mock.calls[0] ?? [];
    expect(new PgDialect().sqlToQuery(reconciliation).params).toEqual([
      scope.userId,
      scope.providerId,
      scope.activityId,
    ]);
  });

  it("retains existing records for an incomplete empty response", async () => {
    const { db, execute } = database([]);
    await persistClimbingSessionEntries(db, { ...scope, entries: [], complete: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails before reconciliation if a record conflicts with another provider", async () => {
    const { db, execute } = database([]);
    await expect(
      persistClimbingSessionEntries(db, { ...scope, entries: [entry], complete: true }),
    ).rejects.toThrow(
      "Climbing entry identities conflict with another source; existing records were preserved.",
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
