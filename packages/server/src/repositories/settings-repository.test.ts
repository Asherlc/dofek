import { describe, expect, it, vi } from "vitest";
import { SettingsRepository } from "./settings-repository.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepository(rows: Record<string, unknown>[] = []) {
  const execute = vi.fn().mockResolvedValue(rows);
  const transaction = vi
    .fn()
    .mockImplementation(async (callback: (tx: { execute: typeof execute }) => Promise<unknown>) => {
      await callback({ execute });
    });
  const db: Pick<import("dofek/db").Database, "execute" | "transaction"> = {
    execute,
    transaction,
  };
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

  describe("getCalorieGoal", () => {
    it("returns a positive numeric calorie goal", async () => {
      const { repo } = makeRepository([{ key: "calorieGoal", value: 2350 }]);

      await expect(repo.getCalorieGoal()).resolves.toBe(2350);
    });

    it("accepts the existing numeric-string setting format", async () => {
      const { repo } = makeRepository([{ key: "calorieGoal", value: "2150" }]);

      await expect(repo.getCalorieGoal()).resolves.toBe(2150);
    });

    it.each([
      { rows: [] },
      { rows: [{ key: "calorieGoal", value: 0 }] },
      { rows: [{ key: "calorieGoal", value: 0.4 }] },
      { rows: [{ key: "calorieGoal", value: "invalid" }] },
    ])("falls back to 2000 when the setting is absent or invalid", async ({ rows }) => {
      const { repo } = makeRepository(rows);

      await expect(repo.getCalorieGoal()).resolves.toBe(2000);
    });
  });

  describe("getCalorieGoalContext", () => {
    it("identifies a valid configured target", async () => {
      const { repo } = makeRepository([{ key: "calorieGoal", value: 2450 }]);

      await expect(repo.getCalorieGoalContext()).resolves.toEqual({
        target: 2450,
        type: "configured",
      });
    });

    it.each([
      { rows: [] },
      { rows: [{ key: "calorieGoal", value: 0 }] },
      { rows: [{ key: "calorieGoal", value: 0.4 }] },
      { rows: [{ key: "calorieGoal", value: "invalid" }] },
    ])("identifies the canonical default when the target is absent or invalid", async ({
      rows,
    }) => {
      const { repo } = makeRepository(rows);

      await expect(repo.getCalorieGoalContext()).resolves.toEqual({
        target: 2000,
        type: "default",
      });
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

    it("returns configured false when only SLACK_CLIENT_ID is set (not signing secret)", async () => {
      const envBackup = { ...process.env };
      delete process.env.SLACK_SIGNING_SECRET;
      delete process.env.SLACK_BOT_TOKEN;
      delete process.env.SLACK_APP_TOKEN;
      process.env.SLACK_CLIENT_ID = "only-client-id";
      try {
        const { repo } = makeRepository([]);
        const result = await repo.slackStatus();
        // && requires both: SLACK_CLIENT_ID && SLACK_SIGNING_SECRET
        expect(result.configured).toBe(false);
      } finally {
        Object.assign(process.env, envBackup);
      }
    });

    it("returns configured false when only SLACK_SIGNING_SECRET is set (not client id)", async () => {
      const envBackup = { ...process.env };
      delete process.env.SLACK_CLIENT_ID;
      delete process.env.SLACK_BOT_TOKEN;
      delete process.env.SLACK_APP_TOKEN;
      process.env.SLACK_SIGNING_SECRET = "only-signing-secret";
      try {
        const { repo } = makeRepository([]);
        const result = await repo.slackStatus();
        expect(result.configured).toBe(false);
      } finally {
        Object.assign(process.env, envBackup);
      }
    });

    it("returns configured false when only SLACK_BOT_TOKEN is set (not app token)", async () => {
      const envBackup = { ...process.env };
      delete process.env.SLACK_CLIENT_ID;
      delete process.env.SLACK_SIGNING_SECRET;
      delete process.env.SLACK_APP_TOKEN;
      process.env.SLACK_BOT_TOKEN = "only-bot-token";
      try {
        const { repo } = makeRepository([]);
        const result = await repo.slackStatus();
        expect(result.configured).toBe(false);
      } finally {
        Object.assign(process.env, envBackup);
      }
    });

    it("returns configured false when only SLACK_APP_TOKEN is set (not bot token)", async () => {
      const envBackup = { ...process.env };
      delete process.env.SLACK_CLIENT_ID;
      delete process.env.SLACK_SIGNING_SECRET;
      delete process.env.SLACK_BOT_TOKEN;
      process.env.SLACK_APP_TOKEN = "only-app-token";
      try {
        const { repo } = makeRepository([]);
        const result = await repo.slackStatus();
        expect(result.configured).toBe(false);
      } finally {
        Object.assign(process.env, envBackup);
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

    it("skips global provider tables while deleting normal provider child tables", async () => {
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

      await repo.deleteAllUserData(["fitness.exercise_alias", "fitness.activity"]);

      const queries = transactionExecute.mock.calls.map(([query]) =>
        JSON.stringify(Reflect.get(query, "queryChunks") ?? []),
      );
      expect(queries.some((query) => query.includes("fitness.exercise_alias"))).toBe(false);
      expect(queries.some((query) => query.includes("fitness.activity"))).toBe(true);
    });

    it("rolls back an absent-table delete before continuing the transaction", async () => {
      let transactionAborted = false;
      const transactionExecute = vi.fn(async (query: unknown) => {
        const queryText = JSON.stringify(
          typeof query === "object" && query !== null
            ? (Reflect.get(query, "queryChunks") ?? [])
            : [],
        );
        if (queryText.includes("ROLLBACK TO SAVEPOINT")) {
          transactionAborted = false;
          return [];
        }
        if (transactionAborted) {
          throw new Error("current transaction is aborted");
        }
        if (queryText.includes("fitness.life_events")) {
          transactionAborted = true;
          throw Object.assign(new Error('relation "fitness.life_events" does not exist'), {
            code: "42P01",
          });
        }
        return [];
      });
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

      await expect(repo.deleteAllUserData([])).resolves.toBeUndefined();

      const queries = transactionExecute.mock.calls.map(([query]) =>
        JSON.stringify(
          typeof query === "object" && query !== null
            ? (Reflect.get(query, "queryChunks") ?? [])
            : [],
        ),
      );
      expect(queries.some((query) => query.includes("ROLLBACK TO SAVEPOINT"))).toBe(true);
      expect(queries.some((query) => query.includes("fitness.sport_settings"))).toBe(true);
    });

    it("rethrows non-schema deletion errors after restoring the transaction", async () => {
      const deletionError = new Error("permission denied");
      const transactionExecute = vi.fn(async (query: unknown) => {
        const queryText = JSON.stringify(
          typeof query === "object" && query !== null
            ? (Reflect.get(query, "queryChunks") ?? [])
            : [],
        );
        if (queryText.includes("fitness.life_events")) {
          throw deletionError;
        }
        return [];
      });
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

      await expect(repo.deleteAllUserData([])).rejects.toBe(deletionError);

      const queries = transactionExecute.mock.calls.map(([query]) =>
        JSON.stringify(
          typeof query === "object" && query !== null
            ? (Reflect.get(query, "queryChunks") ?? [])
            : [],
        ),
      );
      expect(queries.some((query) => query.includes("ROLLBACK TO SAVEPOINT"))).toBe(true);
      expect(queries.some((query) => query.includes("RELEASE SAVEPOINT"))).toBe(true);
    });

    it("deletes every user-scoped table", async () => {
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

      // Pass 0 child tables to isolate user-scoped count.
      await repo.deleteAllUserData([]);
      const queries = transactionExecute.mock.calls.map(([query]) =>
        JSON.stringify(Reflect.get(query, "queryChunks") ?? []),
      );
      expect(queries.filter((query) => query.includes("DELETE FROM"))).toHaveLength(5);
      expect(queries.some((query) => query.includes("fitness.life_events"))).toBe(true);
    });

    it("continues deleting user-scoped data when a table is absent", async () => {
      const transactionExecute = vi.fn(async (query: unknown) => {
        const queryText = JSON.stringify(
          typeof query === "object" && query !== null
            ? (Reflect.get(query, "queryChunks") ?? [])
            : [],
        );
        if (queryText.includes("fitness.life_events")) {
          throw Object.assign(new Error('relation "fitness.life_events" does not exist'), {
            code: "42P01",
          });
        }
        return [];
      });
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

      await expect(repo.deleteAllUserData([])).resolves.toBeUndefined();
      const queries = transactionExecute.mock.calls.map(([query]) =>
        JSON.stringify(
          typeof query === "object" && query !== null
            ? (Reflect.get(query, "queryChunks") ?? [])
            : [],
        ),
      );
      expect(queries.filter((query) => query.includes("DELETE FROM"))).toHaveLength(5);
      expect(queries.some((query) => query.includes("fitness.supplement"))).toBe(true);
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

      const queries = transactionExecute.mock.calls.map(([query]) =>
        JSON.stringify(Reflect.get(query, "queryChunks") ?? []),
      );
      // 2 child tables + 5 user-scoped tables = 7 delete statements.
      expect(queries.filter((query) => query.includes("DELETE FROM"))).toHaveLength(7);
    });
  });
});
