import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const t = initTRPC.context<{ db: unknown; userId: string | null }>().create();
  return {
    router: t.router,
    protectedProcedure: t.procedure,
    cachedProtectedQuery: () => t.procedure,
    cachedProtectedQueryLight: () => t.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("../lib/typed-sql.ts", () => ({
  executeWithSchema: async (
    db: { execute: (query: unknown) => Promise<unknown[]> },
    _schema: unknown,
    query: unknown,
  ) => db.execute(query),
}));

vi.mock("dofek/db/schema", () => ({
  syncLog: {
    userId: "userId",
    providerId: "providerId",
    syncedAt: "syncedAt",
  },
  oauthToken: {
    providerId: "providerId",
  },
  provider: {
    id: "id",
    userId: "userId",
  },
}));

import {
  DISCONNECT_CHILD_TABLES,
  dataTypeEnum,
  providerDetailRouter,
  tableInfo,
} from "./provider-detail.ts";

// Zod schemas for drizzle SQL object introspection
const stringChunkSchema = z.object({ value: z.array(z.string()) });
const sqlObjectSchema: z.ZodType<{ queryChunks: unknown[] }> = z.object({
  queryChunks: z.array(z.unknown()),
});

/**
 * Extract SQL string fragments from a drizzle sql tagged template object.
 * Returns a single concatenated string of all SQL text parts (without parameter values).
 */
function extractSqlText(sqlObj: unknown): string {
  const parsed = sqlObjectSchema.safeParse(sqlObj);
  if (!parsed.success) return "";
  const parts: string[] = [];
  for (const chunk of parsed.data.queryChunks) {
    const asStringChunk = stringChunkSchema.safeParse(chunk);
    if (asStringChunk.success) {
      parts.push(...asStringChunk.data.value);
    } else {
      const asNestedSql = sqlObjectSchema.safeParse(chunk);
      if (asNestedSql.success) {
        parts.push(extractSqlText(chunk));
      }
    }
  }
  return parts.join("");
}

/** Extract parameter values (strings/numbers) from a drizzle SQL object's queryChunks */
function extractSqlParams(sqlObj: unknown): Array<string | number> {
  const parsed = sqlObjectSchema.safeParse(sqlObj);
  if (!parsed.success) return [];
  return parsed.data.queryChunks.filter(
    (c): c is string | number => typeof c === "string" || typeof c === "number",
  );
}

describe("providerDetailRouter", () => {
  const createCaller = createTestCallerFactory(providerDetailRouter);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── tableInfo ──

  describe("tableInfo", () => {
    it.each([
      ["activities", "fitness.activity", "started_at", "id"],
      ["dailyMetrics", "fitness.daily_metrics", "date", "date"],
      ["sleepSessions", "fitness.sleep_session", "started_at", "id"],
      ["bodyMeasurements", "fitness.body_measurement", "recorded_at", "id"],
      ["foodEntries", "fitness.food_entry", "date", "id"],
      ["healthEvents", "fitness.health_event", "start_date", "id"],
      ["metricStream", "fitness.metric_stream", "recorded_at", "recorded_at"],
      ["nutritionDaily", "fitness.nutrition_daily", "date", "date"],
      ["labResults", "fitness.lab_result", "recorded_at", "id"],
      ["journalEntries", "fitness.journal_entry", "date", "id"],
    ] as const)("returns correct mapping for %s", (dataType, expectedTable, expectedOrder, expectedId) => {
      const result = tableInfo(dataType);
      expect(result.table).toBe(expectedTable);
      expect(result.orderColumn).toBe(expectedOrder);
      expect(result.idColumn).toBe(expectedId);
    });

    it("covers every value in dataTypeEnum", () => {
      for (const dt of dataTypeEnum.options) {
        const result = tableInfo(dt);
        expect(result.table).toBeTruthy();
        expect(result.orderColumn).toBeTruthy();
        expect(result.idColumn).toBeTruthy();
      }
    });
  });

  // ── dataTypeEnum ──

  describe("dataTypeEnum", () => {
    it("contains exactly 10 data types", () => {
      expect(dataTypeEnum.options).toHaveLength(10);
    });

    it("includes all expected data types", () => {
      const expected = [
        "activities",
        "dailyMetrics",
        "sleepSessions",
        "bodyMeasurements",
        "foodEntries",
        "healthEvents",
        "metricStream",
        "nutritionDaily",
        "labResults",
        "journalEntries",
      ];
      expect(dataTypeEnum.options).toEqual(expected);
    });
  });

  // ── DISCONNECT_CHILD_TABLES ──

  describe("DISCONNECT_CHILD_TABLES", () => {
    it("contains 15 child tables", () => {
      expect(DISCONNECT_CHILD_TABLES).toHaveLength(15);
    });

    it("includes all required child tables", () => {
      expect(DISCONNECT_CHILD_TABLES).toContain("fitness.metric_stream");
      expect(DISCONNECT_CHILD_TABLES).toContain("fitness.exercise_alias");
      expect(DISCONNECT_CHILD_TABLES).toContain("fitness.strength_workout");
      expect(DISCONNECT_CHILD_TABLES).toContain("fitness.body_measurement");
      expect(DISCONNECT_CHILD_TABLES).toContain("fitness.daily_metrics");
      expect(DISCONNECT_CHILD_TABLES).toContain("fitness.sleep_session");
      expect(DISCONNECT_CHILD_TABLES).toContain("fitness.nutrition_daily");
      expect(DISCONNECT_CHILD_TABLES).toContain("fitness.food_entry");
      expect(DISCONNECT_CHILD_TABLES).toContain("fitness.lab_result");
      expect(DISCONNECT_CHILD_TABLES).toContain("fitness.health_event");
      expect(DISCONNECT_CHILD_TABLES).toContain("fitness.journal_entry");
      expect(DISCONNECT_CHILD_TABLES).toContain("fitness.dexa_scan");
      expect(DISCONNECT_CHILD_TABLES).toContain("fitness.sync_log");
      expect(DISCONNECT_CHILD_TABLES).toContain("fitness.activity");
      expect(DISCONNECT_CHILD_TABLES).toContain("fitness.oauth_token");
    });

    it("ends with activity then oauth_token (FK order)", () => {
      const lastTwo = DISCONNECT_CHILD_TABLES.slice(-2);
      expect(lastTwo).toEqual(["fitness.activity", "fitness.oauth_token"]);
    });
  });

  // ── logs ──

  describe("logs", () => {
    it("returns paginated sync logs for a specific provider", async () => {
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue([
                  {
                    id: "log-1",
                    providerId: "strava",
                    dataType: "activities",
                    status: "success",
                    recordCount: 5,
                    errorMessage: null,
                    durationMs: 1200,
                    syncedAt: "2024-01-15T10:00:00Z",
                  },
                ]),
              }),
            }),
          }),
        }),
      });

      const caller = createCaller({
        db: { select: mockSelect, execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      const result = await caller.logs({ providerId: "strava", limit: 20, offset: 0 });
      expect(result).toHaveLength(1);
      expect(result[0]?.providerId).toBe("strava");
      expect(result[0]?.errorMessage).toBe(null);
    });

    it("redacts error messages in logs", async () => {
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue([
                  {
                    id: "log-2",
                    providerId: "strava",
                    dataType: "activities",
                    status: "error",
                    recordCount: 0,
                    errorMessage: "OAuth token expired: secret-refresh-token",
                    durationMs: 500,
                    syncedAt: "2024-01-15T10:00:00Z",
                  },
                ]),
              }),
            }),
          }),
        }),
      });

      const caller = createCaller({
        db: { select: mockSelect, execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      const result = await caller.logs({ providerId: "strava", limit: 20, offset: 0 });
      expect(result[0]?.errorMessage).toBe("Details hidden");
    });

    it("preserves null errorMessage as null", async () => {
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue([
                  {
                    id: "log-3",
                    providerId: "strava",
                    dataType: "activities",
                    status: "success",
                    recordCount: 5,
                    errorMessage: null,
                    durationMs: 1200,
                    syncedAt: "2024-01-15T10:00:00Z",
                  },
                ]),
              }),
            }),
          }),
        }),
      });

      const caller = createCaller({
        db: { select: mockSelect, execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      const result = await caller.logs({ providerId: "strava", limit: 20, offset: 0 });
      expect(result[0]?.errorMessage).toBeNull();
    });

    it("defaults offset to 0 and limit to 50", async () => {
      const mockOffset = vi.fn().mockResolvedValue([]);
      const mockLimit = vi.fn().mockReturnValue({ offset: mockOffset });
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: mockLimit,
            }),
          }),
        }),
      });

      const caller = createCaller({
        db: { select: mockSelect, execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      await caller.logs({ providerId: "strava" });
      expect(mockLimit).toHaveBeenCalledWith(50);
      expect(mockOffset).toHaveBeenCalledWith(0);
    });
  });

  // ── records ──

  describe("records", () => {
    it("returns paginated activity records for a provider", async () => {
      const caller = createCaller({
        db: {
          execute: vi.fn().mockResolvedValue([
            {
              id: "act-1",
              name: "Morning Run",
              activity_type: "running",
              started_at: "2024-01-15T08:00:00Z",
            },
          ]),
        },
        userId: "user-1",
      });

      const result = await caller.records({
        providerId: "strava",
        dataType: "activities",
        limit: 20,
        offset: 0,
      });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.name).toBe("Morning Run");
    });

    it.each(dataTypeEnum.options)("generates SQL with correct table for %s", async (dataType) => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
      });

      await caller.records({ providerId: "test-provider", dataType });

      expect(mockExecute).toHaveBeenCalledTimes(1);
      const sqlObj = mockExecute.mock.calls[0][0];
      const sqlText = extractSqlText(sqlObj);

      const info = tableInfo(dataType);
      expect(sqlText).toContain(info.table);
      expect(sqlText).toContain(info.orderColumn);
      expect(sqlText).toContain("SELECT");
      expect(sqlText).toContain("ORDER BY");
      expect(sqlText).toContain("LIMIT");
      expect(sqlText).toContain("OFFSET");
    });

    it("passes user ID and provider ID as parameters", async () => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-42",
      });

      await caller.records({ providerId: "strava", dataType: "activities", limit: 10, offset: 5 });

      const sqlObj = mockExecute.mock.calls[0][0];
      const params = extractSqlParams(sqlObj);
      expect(params).toContain("user-42");
      expect(params).toContain("strava");
      expect(params).toContain(10);
      expect(params).toContain(5);
    });

    it("does not join activity_summary for activities (raw data only)", async () => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
      });

      await caller.records({ providerId: "strava", dataType: "activities" });

      const sqlObj = mockExecute.mock.calls[0][0];
      const sqlText = extractSqlText(sqlObj);
      expect(sqlText).not.toContain("activity_summary");
      expect(sqlText).not.toContain("LEFT JOIN");
      expect(sqlText).not.toContain("avg_hr");
    });

    it("defaults offset to 0 and limit to 50", async () => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
      });

      await caller.records({ providerId: "strava", dataType: "activities" });

      const sqlObj = mockExecute.mock.calls[0][0];
      const params = extractSqlParams(sqlObj).filter((p) => typeof p === "number");
      expect(params).toContain(50);
      expect(params).toContain(0);
    });
  });

  // ── recordDetail ──

  describe("recordDetail", () => {
    it("returns a single activity record with raw data", async () => {
      const caller = createCaller({
        db: {
          execute: vi.fn().mockResolvedValue([
            {
              id: "act-1",
              provider_id: "strava",
              name: "Morning Run",
              activity_type: "running",
              started_at: "2024-01-15T08:00:00Z",
              raw: { distance: 5000, elapsed_time: 1500 },
            },
          ]),
        },
        userId: "user-1",
      });

      const result = await caller.recordDetail({
        providerId: "strava",
        dataType: "activities",
        recordId: "act-1",
      });

      expect(result).not.toBeNull();
      expect(result?.raw).toEqual({ distance: 5000, elapsed_time: 1500 });
    });

    it("returns null for non-existent record", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      const result = await caller.recordDetail({
        providerId: "strava",
        dataType: "activities",
        recordId: "nonexistent",
      });

      expect(result).toBeNull();
    });

    it.each(
      dataTypeEnum.options,
    )("generates SQL with correct table and id column for %s", async (dataType) => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
      });

      await caller.recordDetail({
        providerId: "test-provider",
        dataType,
        recordId: "record-1",
      });

      expect(mockExecute).toHaveBeenCalledTimes(1);
      const sqlObj = mockExecute.mock.calls[0][0];
      const sqlText = extractSqlText(sqlObj);

      const info = tableInfo(dataType);
      expect(sqlText).toContain(info.table);
      expect(sqlText).toContain(info.idColumn);
      expect(sqlText).toContain("SELECT");
      expect(sqlText).toContain("LIMIT");
    });

    it("passes providerId and recordId as parameters", async () => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-42",
      });

      await caller.recordDetail({
        providerId: "strava",
        dataType: "activities",
        recordId: "abc-123",
      });

      const sqlObj = mockExecute.mock.calls[0][0];
      const params = extractSqlParams(sqlObj);
      expect(params).toContain("user-42");
      expect(params).toContain("strava");
      expect(params).toContain("abc-123");
    });

    it("does not join activity_summary for activities (raw data only)", async () => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
      });

      await caller.recordDetail({
        providerId: "strava",
        dataType: "activities",
        recordId: "act-1",
      });

      const sqlObj = mockExecute.mock.calls[0][0];
      const sqlText = extractSqlText(sqlObj);
      expect(sqlText).not.toContain("activity_summary");
      expect(sqlText).not.toContain("LEFT JOIN");
      expect(sqlText).not.toContain("avg_hr");
    });
  });

  // ── disconnect ──

  describe("disconnect", () => {
    it("deletes all child table rows and provider row in a transaction", async () => {
      const txExecute = vi.fn().mockResolvedValue([]);
      const mockTransaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: { execute: typeof txExecute }) => Promise<void>) => {
          await fn({ execute: txExecute });
        });
      const mockExecute = vi.fn().mockResolvedValue([{ id: "strava" }]);

      const caller = createCaller({
        db: {
          execute: mockExecute,
          transaction: mockTransaction,
        },
        userId: "user-1",
      });

      const result = await caller.disconnect({ providerId: "strava" });
      expect(result).toEqual({ success: true });
      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      // 15 child tables + 1 provider delete = 16 deletes inside the transaction
      expect(txExecute).toHaveBeenCalledTimes(16);
    });

    it("verifies ownership before disconnecting", async () => {
      const mockExecute = vi.fn().mockResolvedValue([{ id: "strava" }]);
      const txExecute = vi.fn().mockResolvedValue([]);
      const mockTransaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: { execute: typeof txExecute }) => Promise<void>) => {
          await fn({ execute: txExecute });
        });

      const caller = createCaller({
        db: { execute: mockExecute, transaction: mockTransaction },
        userId: "user-1",
      });

      await caller.disconnect({ providerId: "strava" });

      // Verify ownership check SQL contains correct table and conditions
      const ownerSql = mockExecute.mock.calls[0][0];
      const ownerText = extractSqlText(ownerSql);
      expect(ownerText).toContain("fitness.provider");
      expect(ownerText).toContain("SELECT");
    });

    it("deletes from each child table with correct table names", async () => {
      const txExecute = vi.fn().mockResolvedValue([]);
      const mockTransaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: { execute: typeof txExecute }) => Promise<void>) => {
          await fn({ execute: txExecute });
        });
      const mockExecute = vi.fn().mockResolvedValue([{ id: "strava" }]);

      const caller = createCaller({
        db: { execute: mockExecute, transaction: mockTransaction },
        userId: "user-1",
      });

      await caller.disconnect({ providerId: "strava" });

      // Verify each child table DELETE was issued in order
      for (let i = 0; i < DISCONNECT_CHILD_TABLES.length; i++) {
        const callSql = txExecute.mock.calls[i][0];
        const callText = extractSqlText(callSql);
        expect(callText).toContain("DELETE FROM");
        expect(callText).toContain(DISCONNECT_CHILD_TABLES[i]);
      }

      // Verify final provider delete
      const providerDeleteSql = txExecute.mock.calls[DISCONNECT_CHILD_TABLES.length][0];
      const providerDeleteText = extractSqlText(providerDeleteSql);
      expect(providerDeleteText).toContain("DELETE FROM");
      expect(providerDeleteText).toContain("fitness.provider");
    });

    it("passes provider ID as parameter to each delete", async () => {
      const txExecute = vi.fn().mockResolvedValue([]);
      const mockTransaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: { execute: typeof txExecute }) => Promise<void>) => {
          await fn({ execute: txExecute });
        });
      const mockExecute = vi.fn().mockResolvedValue([{ id: "my-provider" }]);

      const caller = createCaller({
        db: { execute: mockExecute, transaction: mockTransaction },
        userId: "user-1",
      });

      await caller.disconnect({ providerId: "my-provider" });

      // Each child table delete should include the provider ID as a parameter
      for (let i = 0; i < DISCONNECT_CHILD_TABLES.length; i++) {
        const callSql = txExecute.mock.calls[i][0];
        const params = extractSqlParams(callSql);
        expect(params).toContain("my-provider");
      }
    });

    it("throws when provider is not owned by user", async () => {
      const mockExecute = vi.fn().mockResolvedValue([]);

      const caller = createCaller({
        db: {
          execute: mockExecute,
          transaction: vi.fn(),
        },
        userId: "user-1",
      });

      await expect(caller.disconnect({ providerId: "unknown" })).rejects.toThrow(
        "Provider not found or not owned by user",
      );
    });

    it("does not call transaction when ownership check fails", async () => {
      const mockTransaction = vi.fn();
      const mockExecute = vi.fn().mockResolvedValue([]);

      const caller = createCaller({
        db: { execute: mockExecute, transaction: mockTransaction },
        userId: "user-1",
      });

      await expect(caller.disconnect({ providerId: "unknown" })).rejects.toThrow();
      expect(mockTransaction).not.toHaveBeenCalled();
    });
  });
});
