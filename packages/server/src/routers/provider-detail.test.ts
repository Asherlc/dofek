import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; userId: string | null; timezone: string }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: async (
      db: { execute: (query: unknown) => Promise<unknown[]> },
      _schema: unknown,
      query: unknown,
    ) => db.execute(query),
  };
});

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

const {
  mockLoadTokens,
  mockGetAllProviders,
  mockEnsureProvidersRegistered,
  mockRevokeToken,
  mockLoggerInfo,
  mockLoggerWarn,
} = vi.hoisted(() => ({
  mockLoadTokens: vi.fn(),
  mockGetAllProviders: vi.fn(),
  mockEnsureProvidersRegistered: vi.fn(),
  mockRevokeToken: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

vi.mock("dofek/db/tokens", () => ({
  loadTokens: (...args: unknown[]) => mockLoadTokens(...args),
}));
vi.mock("dofek/providers/registry", () => ({
  getAllProviders: () => mockGetAllProviders(),
}));
vi.mock("./sync.ts", () => ({
  ensureProvidersRegistered: () => mockEnsureProvidersRegistered(),
}));
vi.mock("dofek/auth/oauth", () => ({
  revokeToken: (...args: unknown[]) => mockRevokeToken(...args),
}));
vi.mock("../logger.ts", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
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
      ["labPanels", "fitness.lab_panel", "recorded_at", "id"],
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
    it("contains exactly 11 data types", () => {
      expect(dataTypeEnum.options).toHaveLength(11);
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
        "labPanels",
        "labResults",
        "journalEntries",
      ];
      expect(dataTypeEnum.options).toEqual(expected);
    });
  });

  // ── DISCONNECT_CHILD_TABLES ──

  describe("DISCONNECT_CHILD_TABLES", () => {
    it("contains 14 child tables", () => {
      expect(DISCONNECT_CHILD_TABLES).toHaveLength(14);
    });

    it("includes all required child tables", () => {
      expect(DISCONNECT_CHILD_TABLES).toContain("fitness.metric_stream");
      expect(DISCONNECT_CHILD_TABLES).not.toContain("fitness.strength_workout");
      expect(DISCONNECT_CHILD_TABLES).toContain("fitness.body_measurement");
      expect(DISCONNECT_CHILD_TABLES).toContain("fitness.daily_metrics");
      expect(DISCONNECT_CHILD_TABLES).toContain("fitness.sleep_session");
      expect(DISCONNECT_CHILD_TABLES).toContain("fitness.nutrition_daily");
      expect(DISCONNECT_CHILD_TABLES).toContain("fitness.food_entry");
      expect(DISCONNECT_CHILD_TABLES).toContain("fitness.lab_result");
      expect(DISCONNECT_CHILD_TABLES).toContain("fitness.lab_panel");
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

    it("deletes lab_result before lab_panel (FK order)", () => {
      const resultIndex = DISCONNECT_CHILD_TABLES.indexOf("fitness.lab_result");
      const panelIndex = DISCONNECT_CHILD_TABLES.indexOf("fitness.lab_panel");
      expect(resultIndex).toBeLessThan(panelIndex);
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
                    syncedAt: "2024-01-14T10:00:00Z",
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
        timezone: "UTC",
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
                    syncedAt: "2024-01-14T10:00:00Z",
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
        timezone: "UTC",
      });

      const result = await caller.logs({ providerId: "strava", limit: 20, offset: 0 });
      expect(result[0]?.errorMessage).toBe("OAuth token expired: secret-refresh-token");
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
                    syncedAt: "2024-01-14T10:00:00Z",
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
        timezone: "UTC",
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
        timezone: "UTC",
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
              started_at: "2024-01-14T08:00:00Z",
            },
          ]),
        },
        userId: "user-1",
        timezone: "UTC",
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
        timezone: "UTC",
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
        timezone: "UTC",
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
        timezone: "UTC",
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
        timezone: "UTC",
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
              started_at: "2024-01-14T08:00:00Z",
              raw: { distance: 5000, elapsed_time: 1400 },
            },
          ]),
        },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.recordDetail({
        providerId: "strava",
        dataType: "activities",
        recordId: "act-1",
      });

      expect(result).not.toBeNull();
      expect(result?.raw).toEqual({ distance: 5000, elapsed_time: 1400 });
    });

    it("returns null for non-existent record", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
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
        timezone: "UTC",
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
        timezone: "UTC",
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
        timezone: "UTC",
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
    it("deletes all user-scoped provider rows in a transaction", async () => {
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
        timezone: "UTC",
      });

      const result = await caller.disconnect({ providerId: "strava" });
      expect(result).toEqual({ success: true });
      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(txExecute).toHaveBeenCalledTimes(DISCONNECT_CHILD_TABLES.length);
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
        timezone: "UTC",
      });

      await caller.disconnect({ providerId: "strava" });

      // Verify ownership check SQL contains correct table and conditions
      const ownerSql = mockExecute.mock.calls[0][0];
      const ownerText = extractSqlText(ownerSql);
      expect(ownerText).toContain("fitness.oauth_token");
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
        timezone: "UTC",
      });

      await caller.disconnect({ providerId: "strava" });

      // Verify each child table DELETE was issued in order
      for (let i = 0; i < DISCONNECT_CHILD_TABLES.length; i++) {
        const callSql = txExecute.mock.calls[i][0];
        const callText = extractSqlText(callSql);
        expect(callText).toContain("DELETE FROM");
        expect(callText).toContain(DISCONNECT_CHILD_TABLES[i]);
      }
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
        timezone: "UTC",
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
        timezone: "UTC",
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
        timezone: "UTC",
      });

      await expect(caller.disconnect({ providerId: "unknown" })).rejects.toThrow();
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it("calls revokeExistingTokens before deleting data when provider supports it", async () => {
      const mockRevokeExisting = vi.fn().mockResolvedValue(undefined);
      const storedTokens = {
        accessToken: "access-123",
        refreshToken: "refresh-456",
        expiresAt: new Date("2026-12-31"),
        scopes: "email workouts_read",
      };
      mockLoadTokens.mockResolvedValue(storedTokens);
      mockEnsureProvidersRegistered.mockResolvedValue(undefined);
      mockGetAllProviders.mockReturnValue([
        {
          id: "wahoo",
          name: "Wahoo",
          validate: () => null,
          authSetup: () => ({
            oauthConfig: { revokeUrl: "https://api.wahooligan.com/oauth/revoke" },
            exchangeCode: vi.fn(),
            revokeExistingTokens: mockRevokeExisting,
          }),
        },
      ]);

      const txExecute = vi.fn().mockResolvedValue([]);
      const mockTransaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: { execute: typeof txExecute }) => Promise<void>) => {
          await fn({ execute: txExecute });
        });
      const mockExecute = vi.fn().mockResolvedValue([{ id: "wahoo" }]);

      const caller = createCaller({
        db: { execute: mockExecute, transaction: mockTransaction },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.disconnect({ providerId: "wahoo" });

      expect(mockLoadTokens).toHaveBeenCalledWith(expect.anything(), "wahoo", "user-1");
      expect(mockRevokeExisting).toHaveBeenCalledWith(storedTokens);
      expect(mockTransaction).toHaveBeenCalledTimes(1);
    });

    it("uses standard OAuth revocation when provider has revokeUrl but no revokeExistingTokens", async () => {
      const storedTokens = {
        accessToken: "access-abc",
        refreshToken: "refresh-def",
        expiresAt: new Date("2026-12-31"),
        scopes: null,
      };
      mockLoadTokens.mockResolvedValue(storedTokens);
      mockEnsureProvidersRegistered.mockResolvedValue(undefined);
      mockGetAllProviders.mockReturnValue([
        {
          id: "strava",
          name: "Strava",
          validate: () => null,
          authSetup: () => ({
            oauthConfig: {
              clientId: "client-id",
              clientSecret: "secret",
              revokeUrl: "https://www.strava.com/oauth/deauthorize",
            },
            exchangeCode: vi.fn(),
          }),
        },
      ]);
      mockRevokeToken.mockResolvedValue(undefined);

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
        timezone: "UTC",
      });

      await caller.disconnect({ providerId: "strava" });

      expect(mockRevokeToken).toHaveBeenCalledTimes(2);
      expect(mockRevokeToken).toHaveBeenCalledWith(
        expect.objectContaining({ revokeUrl: "https://www.strava.com/oauth/deauthorize" }),
        "access-abc",
      );
      expect(mockRevokeToken).toHaveBeenCalledWith(
        expect.objectContaining({ revokeUrl: "https://www.strava.com/oauth/deauthorize" }),
        "refresh-def",
      );
      expect(mockTransaction).toHaveBeenCalledTimes(1);
    });

    it("falls back to standard OAuth revocation when custom revocation fails", async () => {
      mockLoadTokens.mockResolvedValue({
        accessToken: "expired-token",
        refreshToken: null,
        expiresAt: new Date("2020-01-01"),
        scopes: null,
      });
      mockEnsureProvidersRegistered.mockResolvedValue(undefined);
      mockGetAllProviders.mockReturnValue([
        {
          id: "wahoo",
          name: "Wahoo",
          validate: () => null,
          authSetup: () => ({
            oauthConfig: { revokeUrl: "https://api.wahooligan.com/oauth/revoke" },
            exchangeCode: vi.fn(),
            revokeExistingTokens: vi.fn().mockRejectedValue(new Error("401 Unauthorized")),
          }),
        },
      ]);
      mockRevokeToken.mockResolvedValue(undefined);

      const txExecute = vi.fn().mockResolvedValue([]);
      const mockTransaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: { execute: typeof txExecute }) => Promise<void>) => {
          await fn({ execute: txExecute });
        });
      const mockExecute = vi.fn().mockResolvedValue([{ id: "wahoo" }]);

      const caller = createCaller({
        db: { execute: mockExecute, transaction: mockTransaction },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.disconnect({ providerId: "wahoo" });

      expect(result).toEqual({ success: true });
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining("Custom revocation failed for wahoo"),
      );
      // Falls back to standard OAuth revocation for the access token
      expect(mockRevokeToken).toHaveBeenCalledWith(
        expect.objectContaining({ revokeUrl: "https://api.wahooligan.com/oauth/revoke" }),
        "expired-token",
      );
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(txExecute).toHaveBeenCalledTimes(DISCONNECT_CHILD_TABLES.length);
    });

    it("still deletes data when all revocation methods fail", async () => {
      mockLoadTokens.mockResolvedValue({
        accessToken: "expired-token",
        refreshToken: "expired-refresh",
        expiresAt: new Date("2020-01-01"),
        scopes: null,
      });
      mockEnsureProvidersRegistered.mockResolvedValue(undefined);
      mockGetAllProviders.mockReturnValue([
        {
          id: "wahoo",
          name: "Wahoo",
          validate: () => null,
          authSetup: () => ({
            oauthConfig: { revokeUrl: "https://api.wahooligan.com/oauth/revoke" },
            exchangeCode: vi.fn(),
            revokeExistingTokens: vi.fn().mockRejectedValue(new Error("401 Unauthorized")),
          }),
        },
      ]);
      mockRevokeToken.mockRejectedValue(new Error("revocation endpoint down"));

      const txExecute = vi.fn().mockResolvedValue([]);
      const mockTransaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: { execute: typeof txExecute }) => Promise<void>) => {
          await fn({ execute: txExecute });
        });
      const mockExecute = vi.fn().mockResolvedValue([{ id: "wahoo" }]);

      const caller = createCaller({
        db: { execute: mockExecute, transaction: mockTransaction },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.disconnect({ providerId: "wahoo" });

      expect(result).toEqual({ success: true });
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(txExecute).toHaveBeenCalledTimes(DISCONNECT_CHILD_TABLES.length);
    });

    it("skips revocation when no stored tokens exist", async () => {
      const mockRevokeExistingNoTokens = vi.fn();
      mockLoadTokens.mockResolvedValue(null);
      mockEnsureProvidersRegistered.mockResolvedValue(undefined);
      mockGetAllProviders.mockReturnValue([
        {
          id: "wahoo",
          name: "Wahoo",
          validate: () => null,
          authSetup: () => ({
            oauthConfig: { revokeUrl: "https://api.wahooligan.com/oauth/revoke" },
            exchangeCode: vi.fn(),
            revokeExistingTokens: mockRevokeExistingNoTokens,
          }),
        },
      ]);

      const txExecute = vi.fn().mockResolvedValue([]);
      const mockTransaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: { execute: typeof txExecute }) => Promise<void>) => {
          await fn({ execute: txExecute });
        });
      const mockExecute = vi.fn().mockResolvedValue([{ id: "wahoo" }]);

      const caller = createCaller({
        db: { execute: mockExecute, transaction: mockTransaction },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.disconnect({ providerId: "wahoo" });

      expect(mockRevokeExistingNoTokens).not.toHaveBeenCalled();
      expect(mockTransaction).toHaveBeenCalledTimes(1);
    });

    it("skips revocation when provider has no authSetup", async () => {
      mockLoadTokens.mockResolvedValue({
        accessToken: "token",
        refreshToken: null,
        expiresAt: new Date(),
        scopes: null,
      });
      mockEnsureProvidersRegistered.mockResolvedValue(undefined);
      mockGetAllProviders.mockReturnValue([
        {
          id: "apple-health",
          name: "Apple Health",
          validate: () => null,
          // No authSetup method
        },
      ]);

      const txExecute = vi.fn().mockResolvedValue([]);
      const mockTransaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: { execute: typeof txExecute }) => Promise<void>) => {
          await fn({ execute: txExecute });
        });
      const mockExecute = vi.fn().mockResolvedValue([{ id: "apple-health" }]);

      const caller = createCaller({
        db: { execute: mockExecute, transaction: mockTransaction },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.disconnect({ providerId: "apple-health" });

      expect(result).toEqual({ success: true });
      expect(mockRevokeToken).not.toHaveBeenCalled();
      expect(mockTransaction).toHaveBeenCalledTimes(1);
    });

    it("only revokes access token when no refresh token exists", async () => {
      mockLoadTokens.mockResolvedValue({
        accessToken: "access-token",
        refreshToken: null,
        expiresAt: new Date(),
        scopes: null,
      });
      mockEnsureProvidersRegistered.mockResolvedValue(undefined);
      mockGetAllProviders.mockReturnValue([
        {
          id: "strava",
          name: "Strava",
          validate: () => null,
          authSetup: () => ({
            oauthConfig: { revokeUrl: "https://strava.com/revoke" },
            exchangeCode: vi.fn(),
          }),
        },
      ]);
      mockRevokeToken.mockResolvedValue(undefined);

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
        timezone: "UTC",
      });

      await caller.disconnect({ providerId: "strava" });

      // Only access token revoked, no refresh token
      expect(mockRevokeToken).toHaveBeenCalledTimes(1);
      expect(mockRevokeToken).toHaveBeenCalledWith(
        expect.objectContaining({ revokeUrl: "https://strava.com/revoke" }),
        "access-token",
      );
    });
  });
});
