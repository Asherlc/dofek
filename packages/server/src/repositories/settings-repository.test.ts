import { describe, expect, it, vi } from "vitest";
import { SettingsRepository } from "./settings-repository.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepository(rows: Record<string, unknown>[] = []) {
  const execute = vi.fn().mockResolvedValue(rows);
  const transactionCallback = vi.fn();
  const transaction = vi
    .fn()
    .mockImplementation(async (callback: (tx: { execute: typeof execute }) => Promise<void>) => {
      const transactionExecute = vi.fn().mockResolvedValue([]);
      transactionCallback.mockImplementation(callback);
      await callback({ execute: transactionExecute });
      return transactionExecute;
    });
  const db: Pick<import("dofek/db").Database, "execute" | "transaction"> = { execute, transaction };
  const repo = new SettingsRepository(db, "user-1");
  return { repo, execute, transaction };
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

describe("SettingsRepository", () => {
  describe("get", () => {
    it("returns null when no setting found", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.get("theme");
      expect(result).toBeNull();
    });

    it("returns the setting when found", async () => {
      const { repo } = makeRepository([{ key: "theme", value: "dark" }]);
      const result = await repo.get("theme");
      expect(result).toEqual({ key: "theme", value: "dark" });
    });

    it("calls execute once", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.get("theme");
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("getAll", () => {
    it("returns empty array when no settings", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getAll();
      expect(result).toEqual([]);
    });

    it("returns all settings", async () => {
      const { repo } = makeRepository([
        { key: "theme", value: "dark" },
        { key: "timezone", value: "UTC" },
      ]);
      const result = await repo.getAll();
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ key: "theme", value: "dark" });
      expect(result[1]).toEqual({ key: "timezone", value: "UTC" });
    });
  });

  describe("set", () => {
    it("returns the upserted setting", async () => {
      const { repo } = makeRepository([{ key: "theme", value: "dark" }]);
      const result = await repo.set("theme", "dark");
      expect(result).toEqual({ key: "theme", value: "dark" });
    });

    it("throws when upsert returns no rows", async () => {
      const { repo } = makeRepository([]);
      await expect(repo.set("theme", "dark")).rejects.toThrow("Failed to upsert setting");
    });
  });

  describe("deleteAllUserData", () => {
    it("calls transaction", async () => {
      const { repo, transaction } = makeRepository([]);
      await repo.deleteAllUserData(["fitness.sync_log", "fitness.activity"]);
      expect(transaction).toHaveBeenCalledTimes(1);
    });

    it("deletes exactly 4 user-scoped tables (user_settings, life_events, sport_settings, supplement)", async () => {
      const transactionExecute = vi.fn().mockResolvedValue([]);
      const transaction = vi
        .fn()
        .mockImplementation(
          async (callback: (tx: { execute: typeof transactionExecute }) => Promise<void>) => {
            await callback({ execute: transactionExecute });
          },
        );
      const execute = vi.fn().mockResolvedValue([]);
      const db: Pick<import("dofek/db").Database, "execute" | "transaction"> = {
        execute,
        transaction,
      };
      const repo = new SettingsRepository(db, "user-1");

      // Pass 0 child tables to isolate user-scoped count: 4 user-scoped deletes
      await repo.deleteAllUserData([]);
      expect(transactionExecute).toHaveBeenCalledTimes(4);
    });

    it("executes deletes for provider child tables, provider, and user-scoped tables", async () => {
      const transactionExecute = vi.fn().mockResolvedValue([]);
      const transaction = vi
        .fn()
        .mockImplementation(
          async (callback: (tx: { execute: typeof transactionExecute }) => Promise<void>) => {
            await callback({ execute: transactionExecute });
          },
        );
      const execute = vi.fn().mockResolvedValue([]);
      const db: Pick<import("dofek/db").Database, "execute" | "transaction"> = {
        execute,
        transaction,
      };
      const repo = new SettingsRepository(db, "user-1");

      const childTables = ["fitness.sync_log", "fitness.activity"];
      await repo.deleteAllUserData(childTables);

      // 2 child tables + 4 user-scoped tables = 6 execute calls
      expect(transactionExecute).toHaveBeenCalledTimes(6);
    });
  });
});
