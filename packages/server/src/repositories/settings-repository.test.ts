import { describe, expect, it, vi } from "vitest";
import { SettingsRepository } from "./settings-repository.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepository(rows: Record<string, unknown>[] = []) {
  const execute = vi.fn().mockResolvedValue(rows);
  const transactionCallback = vi.fn();
  const transaction = vi.fn().mockImplementation(async (callback: (tx: { execute: typeof execute }) => Promise<void>) => {
    const transactionExecute = vi.fn().mockResolvedValue([]);
    transactionCallback.mockImplementation(callback);
    await callback({ execute: transactionExecute });
    return transactionExecute;
  });
  const db = { execute, transaction } as unknown as Parameters<typeof SettingsRepository extends new (db: infer D, ...rest: unknown[]) => unknown ? D extends infer T ? T : never : never>[0];
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

  describe("slackStatus", () => {
    it("returns connected false when no slack account", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.slackStatus();
      expect(result.connected).toBe(false);
    });

    it("returns connected true when slack account exists", async () => {
      const { repo } = makeRepository([{ provider_account_id: "slack-123" }]);
      const result = await repo.slackStatus();
      expect(result.connected).toBe(true);
    });

    it("returns configured true when oauth env vars are set", async () => {
      const originalClientId = process.env.SLACK_CLIENT_ID;
      const originalSigningSecret = process.env.SLACK_SIGNING_SECRET;
      process.env.SLACK_CLIENT_ID = "test-client-id";
      process.env.SLACK_SIGNING_SECRET = "test-signing-secret";
      try {
        const { repo } = makeRepository([]);
        const result = await repo.slackStatus();
        expect(result.configured).toBe(true);
      } finally {
        process.env.SLACK_CLIENT_ID = originalClientId;
        process.env.SLACK_SIGNING_SECRET = originalSigningSecret;
      }
    });

    it("returns configured true when socket mode env vars are set", async () => {
      const originalBotToken = process.env.SLACK_BOT_TOKEN;
      const originalAppToken = process.env.SLACK_APP_TOKEN;
      process.env.SLACK_BOT_TOKEN = "test-bot-token";
      process.env.SLACK_APP_TOKEN = "test-app-token";
      try {
        const { repo } = makeRepository([]);
        const result = await repo.slackStatus();
        expect(result.configured).toBe(true);
      } finally {
        process.env.SLACK_BOT_TOKEN = originalBotToken;
        process.env.SLACK_APP_TOKEN = originalAppToken;
      }
    });

    it("returns configured false when no slack env vars are set", async () => {
      const envBackup = { ...process.env };
      delete process.env.SLACK_CLIENT_ID;
      delete process.env.SLACK_SIGNING_SECRET;
      delete process.env.SLACK_BOT_TOKEN;
      delete process.env.SLACK_APP_TOKEN;
      try {
        const { repo } = makeRepository([]);
        const result = await repo.slackStatus();
        expect(result.configured).toBe(false);
      } finally {
        Object.assign(process.env, envBackup);
      }
    });
  });

  describe("deleteAllUserData", () => {
    it("calls transaction", async () => {
      const { repo, transaction } = makeRepository([]);
      await repo.deleteAllUserData(["fitness.sync_log", "fitness.activity"]);
      expect(transaction).toHaveBeenCalledTimes(1);
    });

    it("executes deletes for provider child tables, provider, and user-scoped tables", async () => {
      const transactionExecute = vi.fn().mockResolvedValue([]);
      const transaction = vi.fn().mockImplementation(async (callback: (tx: { execute: typeof transactionExecute }) => Promise<void>) => {
        await callback({ execute: transactionExecute });
      });
      const execute = vi.fn().mockResolvedValue([]);
      const db = { execute, transaction } as unknown as Parameters<typeof SettingsRepository extends new (db: infer D, ...rest: unknown[]) => unknown ? D extends infer T ? T : never : never>[0];
      const repo = new SettingsRepository(db, "user-1");

      const childTables = ["fitness.sync_log", "fitness.activity"];
      await repo.deleteAllUserData(childTables);

      // 2 child tables + 1 provider delete + 4 user-scoped tables = 7 execute calls
      expect(transactionExecute).toHaveBeenCalledTimes(7);
    });
  });
});
