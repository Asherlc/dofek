import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "./schema.ts";
import { logSync, withSyncLog } from "./sync-log.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { ensureProvider } from "./tokens.ts";

describe("Sync Log (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "test-provider", "Test Provider", undefined, TEST_USER_ID);
  }, 120_000);

  afterAll(async () => {
    await ctx?.cleanup();
  });

  describe("logSync", () => {
    it("logs a successful sync", async () => {
      await logSync(ctx.db, {
        providerId: "test-provider",
        dataType: "activities",
        status: "success",
        recordCount: 10,
        durationMs: 500,
        userId: TEST_USER_ID,
      });

      const rows = await ctx.db.execute<{
        provider_id: string;
        data_type: string;
        status: string;
        record_count: number;
        duration_ms: number;
      }>(
        sql`SELECT provider_id, data_type, status, record_count, duration_ms
            FROM fitness.sync_log
            WHERE provider_id = 'test-provider' AND data_type = 'activities'
            ORDER BY synced_at DESC LIMIT 1`,
      );

      expect(rows.length).toBe(1);
      expect(rows[0]?.status).toBe("success");
      expect(rows[0]?.record_count).toBe(10);
      expect(rows[0]?.duration_ms).toBe(500);
    });

    it("logs an error sync with error message", async () => {
      await logSync(ctx.db, {
        providerId: "test-provider",
        dataType: "sleep",
        status: "error",
        errorMessage: "API rate limit exceeded",
        durationMs: 100,
        userId: TEST_USER_ID,
      });

      const rows = await ctx.db.execute<{
        status: string;
        error_message: string;
        record_count: number;
      }>(
        sql`SELECT status, error_message, record_count
            FROM fitness.sync_log
            WHERE provider_id = 'test-provider' AND data_type = 'sleep'
            ORDER BY synced_at DESC LIMIT 1`,
      );

      expect(rows[0]?.status).toBe("error");
      expect(rows[0]?.error_message).toBe("API rate limit exceeded");
      expect(rows[0]?.record_count).toBe(0); // defaults to 0
    });
  });

  describe("withSyncLog", () => {
    it("logs success and returns the result", async () => {
      const result = await withSyncLog(
        ctx.db,
        "test-provider",
        "metrics",
        async () => ({
          recordCount: 5,
          result: "synced-data",
        }),
        TEST_USER_ID,
      );

      expect(result).toBe("synced-data");

      const rows = await ctx.db.execute<{ status: string; record_count: number }>(
        sql`SELECT status, record_count
            FROM fitness.sync_log
            WHERE provider_id = 'test-provider' AND data_type = 'metrics'
            ORDER BY synced_at DESC LIMIT 1`,
      );
      expect(rows[0]?.status).toBe("success");
      expect(rows[0]?.record_count).toBe(5);
    });

    it("logs error and re-throws on failure", async () => {
      await expect(
        withSyncLog(
          ctx.db,
          "test-provider",
          "workouts",
          async () => {
            throw new Error("Connection timeout");
          },
          TEST_USER_ID,
        ),
      ).rejects.toThrow("Connection timeout");

      const rows = await ctx.db.execute<{ status: string; error_message: string }>(
        sql`SELECT status, error_message
            FROM fitness.sync_log
            WHERE provider_id = 'test-provider' AND data_type = 'workouts'
            ORDER BY synced_at DESC LIMIT 1`,
      );
      expect(rows[0]?.status).toBe("error");
      expect(rows[0]?.error_message).toBe("Connection timeout");
    });

    it("records duration in milliseconds", async () => {
      await withSyncLog(
        ctx.db,
        "test-provider",
        "hr-data",
        async () => {
          // Simulate some work
          await new Promise((r) => setTimeout(r, 50));
          return { recordCount: 1, result: null };
        },
        TEST_USER_ID,
      );

      const rows = await ctx.db.execute<{ duration_ms: number }>(
        sql`SELECT duration_ms
            FROM fitness.sync_log
            WHERE provider_id = 'test-provider' AND data_type = 'hr-data'
            ORDER BY synced_at DESC LIMIT 1`,
      );
      expect(rows[0]?.duration_ms).toBeGreaterThanOrEqual(40);
    });

    it("logs duration even on error", async () => {
      try {
        await withSyncLog(
          ctx.db,
          "test-provider",
          "error-timed",
          async () => {
            await new Promise((r) => setTimeout(r, 30));
            throw new Error("timed failure");
          },
          TEST_USER_ID,
        );
      } catch {
        // expected
      }

      const rows = await ctx.db.execute<{ duration_ms: number; status: string }>(
        sql`SELECT duration_ms, status
            FROM fitness.sync_log
            WHERE provider_id = 'test-provider' AND data_type = 'error-timed'
            ORDER BY synced_at DESC LIMIT 1`,
      );
      expect(rows[0]?.status).toBe("error");
      expect(rows[0]?.duration_ms).toBeGreaterThanOrEqual(20);
    });
  });
});
