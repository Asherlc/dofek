import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; userId: string | null; timezone: string; sensorStore?: unknown }>()
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

vi.mock("dofek/db/schema/events", () => ({
  syncLog: {
    userId: "userId",
    providerId: "providerId",
    syncedAt: "syncedAt",
  },
}));

vi.mock("dofek/db/schema/reference", () => ({
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
  mockDeleteProviderAuthorization,
  mockGetAllProviders,
  mockEnsureProvidersRegistered,
  mockRevokeToken,
  mockLoggerInfo,
  mockLoggerWarn,
  mockSentryCaptureException,
  mockProviderDataDeletesInc,
  mockGetProviderDataDeletionJob,
} = vi.hoisted(() => ({
  mockLoadTokens: vi.fn(),
  mockDeleteProviderAuthorization: vi.fn(),
  mockGetAllProviders: vi.fn(),
  mockEnsureProvidersRegistered: vi.fn(),
  mockRevokeToken: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockSentryCaptureException: vi.fn(),
  mockProviderDataDeletesInc: vi.fn(),
  mockGetProviderDataDeletionJob: vi.fn(),
}));

vi.mock("dofek/jobs/queues", () => ({
  getProviderDataDeletionQueue: () => ({ getJob: mockGetProviderDataDeletionJob }),
}));

vi.mock("dofek/db/tokens", () => ({
  loadTokens: (...args: unknown[]) => mockLoadTokens(...args),
  deleteProviderAuthorization: (...args: unknown[]) => mockDeleteProviderAuthorization(...args),
}));
vi.mock("dofek/providers/registry", () => ({
  getAllProviders: () => mockGetAllProviders(),
}));
vi.mock("./sync-helpers.ts", () => ({
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
  captureException: (...args: unknown[]) => mockSentryCaptureException(...args),
}));
vi.mock("../lib/metrics.ts", () => ({
  providerDataDeletesTotal: { inc: (...args: unknown[]) => mockProviderDataDeletesInc(...args) },
}));

import { PROVIDER_ACCOUNT_TABLES } from "../repositories/provider-detail-repository.ts";
import { dataTypeEnum, providerDetailRouter, tableInfo } from "./provider-detail.ts";

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
  const params: Array<string | number> = [];
  for (const chunk of parsed.data.queryChunks) {
    if (typeof chunk === "string" || typeof chunk === "number") {
      params.push(chunk);
      continue;
    }
    params.push(...extractSqlParams(chunk));
  }
  return params;
}

const expectedListColumns = {
  activities: [
    "id",
    "provider_id",
    "external_id",
    "activity_type",
    "started_at",
    "ended_at",
    "name",
    "source_name",
    "provider_absent_at",
    "deleted_at",
    "created_at",
  ],
  dailyMetrics: [
    "id",
    "provider_id",
    "date",
    "hrv",
    "respiratory_rate_avg",
    "steps",
    "distance_km",
    "source_name",
    "created_at",
  ],
  sleepSessions: [
    "id",
    "provider_id",
    "external_id",
    "started_at",
    "ended_at",
    "duration_minutes",
    "sleep_type",
    "source_name",
    "created_at",
  ],
  foodEntries: [
    "id",
    "provider_id",
    "external_id",
    "date",
    "meal",
    "food_name",
    "logged_at",
    "source_name",
    "created_at",
  ],
  healthEvents: [
    "id",
    "provider_id",
    "external_id",
    "type",
    "value",
    "value_text",
    "unit",
    "source_name",
    "start_date",
    "end_date",
    "created_at",
  ],
  nutritionDaily: [
    "date",
    "provider_id",
    "calories",
    "protein_g",
    "carbs_g",
    "fat_g",
    "fiber_g",
    "sugar_g",
  ],
  labPanels: [
    "id",
    "provider_id",
    "external_id",
    "name",
    "loinc_code",
    "status",
    "source_name",
    "recorded_at",
    "issued_at",
    "created_at",
  ],
  labResults: [
    "id",
    "provider_id",
    "panel_id",
    "external_id",
    "test_name",
    "loinc_code",
    "value",
    "value_text",
    "unit",
    "status",
    "recorded_at",
    "created_at",
  ],
  journalEntries: [
    "id",
    "provider_id",
    "date",
    "question_slug",
    "answer_text",
    "answer_numeric",
    "impact_score",
    "created_at",
  ],
} satisfies Record<
  Exclude<(typeof dataTypeEnum.options)[number], "bodyMeasurements" | "metricStream">,
  string[]
>;

const expectedListColumnCases = [
  ["activities", expectedListColumns.activities],
  ["dailyMetrics", expectedListColumns.dailyMetrics],
  ["sleepSessions", expectedListColumns.sleepSessions],
  ["foodEntries", expectedListColumns.foodEntries],
  ["healthEvents", expectedListColumns.healthEvents],
  ["nutritionDaily", expectedListColumns.nutritionDaily],
  ["labPanels", expectedListColumns.labPanels],
  ["labResults", expectedListColumns.labResults],
  ["journalEntries", expectedListColumns.journalEntries],
] satisfies Array<[keyof typeof expectedListColumns, string[]]>;

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
      ["bodyMeasurements", "analytics.v_body_measurement", "recorded_at", "id"],
      ["foodEntries", "fitness.food_entry", "date", "id"],
      ["healthEvents", "fitness.health_event", "start_date", "id"],
      ["metricStream", "ingest.metric_stream", "recorded_at", "id"],
      ["nutritionDaily", "fitness.v_nutrition_provider_daily", "date", "date"],
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

  // ── PROVIDER_ACCOUNT_TABLES ──

  describe("PROVIDER_ACCOUNT_TABLES", () => {
    it("contains 18 child tables", () => {
      expect(PROVIDER_ACCOUNT_TABLES).toHaveLength(18);
    });

    it("includes all required child tables", () => {
      expect(PROVIDER_ACCOUNT_TABLES).not.toContain("fitness.metric_stream");
      expect(PROVIDER_ACCOUNT_TABLES).not.toContain("fitness.strength_workout");
      expect(PROVIDER_ACCOUNT_TABLES).not.toContain("fitness.body_measurement");
      expect(PROVIDER_ACCOUNT_TABLES).not.toContain("fitness.nutrition_daily");
      expect(PROVIDER_ACCOUNT_TABLES).toContain("fitness.daily_metrics");
      expect(PROVIDER_ACCOUNT_TABLES).toContain("fitness.sleep_session");
      expect(PROVIDER_ACCOUNT_TABLES).toContain("fitness.food_entry");
      expect(PROVIDER_ACCOUNT_TABLES).toContain("fitness.lab_result");
      expect(PROVIDER_ACCOUNT_TABLES).toContain("fitness.lab_panel");
      expect(PROVIDER_ACCOUNT_TABLES).toContain("fitness.medication_dose_event");
      expect(PROVIDER_ACCOUNT_TABLES).toContain("fitness.supplement_dose_event");
      expect(PROVIDER_ACCOUNT_TABLES).toContain("fitness.health_event");
      expect(PROVIDER_ACCOUNT_TABLES).toContain("fitness.journal_entry");
      expect(PROVIDER_ACCOUNT_TABLES).toContain("fitness.dexa_scan");
      expect(PROVIDER_ACCOUNT_TABLES).toContain("fitness.sync_log");
      expect(PROVIDER_ACCOUNT_TABLES).toContain("fitness.activity");
      expect(PROVIDER_ACCOUNT_TABLES).toContain("fitness.oauth_token");
      expect(PROVIDER_ACCOUNT_TABLES).toContain("fitness.provider_connection");
    });

    it("ends with OAuth token then provider connection (FK order)", () => {
      const lastTwo = PROVIDER_ACCOUNT_TABLES.slice(-2);
      expect(lastTwo).toEqual(["fitness.oauth_token", "fitness.provider_connection"]);
    });

    it("deletes lab_result before lab_panel (FK order)", () => {
      const resultIndex = PROVIDER_ACCOUNT_TABLES.indexOf("fitness.lab_result");
      const panelIndex = PROVIDER_ACCOUNT_TABLES.indexOf("fitness.lab_panel");
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

    it("applies server-side filters to sync logs", async () => {
      const mockWhere = vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            offset: vi.fn().mockResolvedValue([]),
          }),
        }),
      });
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: mockWhere,
        }),
      });

      const caller = createCaller({
        db: { select: mockSelect, execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.logs({
        providerId: "strava",
        filters: { status: "error", dataType: "activities" },
      });

      expect(mockWhere).toHaveBeenCalledTimes(1);
      const whereSql = extractSqlText(mockWhere.mock.calls[0]?.[0]);
      expect(whereSql).toContain("ILIKE");
      expect(whereSql).toContain("status");
      expect(whereSql).toContain("data_type");
    });
  });

  describe("logFilterOptions", () => {
    it("returns distinct sync log dropdown values for a provider", async () => {
      const caller = createCaller({
        db: {
          execute: vi.fn().mockResolvedValue([{ value: "success" }, { value: "error" }]),
        },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.logFilterOptions({ providerId: "strava" });

      expect(result.status).toEqual([{ value: "success" }, { value: "error" }]);
      expect(result.dataType).toEqual([{ value: "success" }, { value: "error" }]);
    });
  });

  describe("availableDataTypes", () => {
    it("returns the provider data types reported by both stores", async () => {
      const mockExecute = vi.fn().mockResolvedValue([{ data_type: "activities" }]);
      const sensorQuery = vi.fn().mockResolvedValue([{ data_type: "metricStream" }]);
      const caller = createCaller({
        db: { execute: mockExecute },
        sensorStore: { query: sensorQuery },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(caller.availableDataTypes({ providerId: "whoop" })).resolves.toEqual([
        "activities",
        "metricStream",
      ]);
      expect(mockExecute).toHaveBeenCalledOnce();
      expect(sensorQuery).toHaveBeenCalledOnce();
      expect(sensorQuery.mock.calls[0]?.[2]).toEqual({
        userId: "user-1",
        providerId: "whoop",
      });
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

    it("returns distinct record dropdown values for a provider data type", async () => {
      const caller = createCaller({
        db: {
          execute: vi.fn().mockResolvedValue([{ value: "running" }, { value: "cycling" }]),
        },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.recordFilterOptions({
        providerId: "strava",
        dataType: "activities",
      });

      expect(result.activity_type).toEqual([{ value: "running" }, { value: "cycling" }]);
    });

    it.each(
      dataTypeEnum.options.filter(
        (dataType) => dataType !== "bodyMeasurements" && dataType !== "metricStream",
      ),
    )("generates SQL with correct table for %s", async (dataType) => {
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

    it.each(
      expectedListColumnCases,
    )("selects explicit list columns for %s", async (dataType, expectedColumns) => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.records({ providerId: "test-provider", dataType });

      const sqlText = extractSqlText(mockExecute.mock.calls[0][0]);
      const selectClause = sqlText.slice(
        sqlText.indexOf("SELECT") + "SELECT".length,
        sqlText.indexOf("FROM"),
      );
      expect(selectClause.trim()).toBe(expectedColumns.join(", "));
    });

    it("queries body measurement records through ClickHouse", async () => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      const sensorQuery = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute: mockExecute },
        sensorStore: { query: sensorQuery },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.records({ providerId: "test-provider", dataType: "bodyMeasurements" });

      expect(mockExecute).not.toHaveBeenCalled();
      expect(sensorQuery.mock.calls[0]?.[1]).toContain("analytics.v_body_measurement");
    });

    it("queries metric stream records through ClickHouse", async () => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      const sensorQuery = vi.fn().mockResolvedValue([
        {
          id: "stream-1",
          recorded_at: "2026-04-12T10:00:00.000000Z",
          provider_id: "whoop",
          channel: "heart_rate",
          scalar: 72,
        },
      ]);
      const caller = createCaller({
        db: { execute: mockExecute },
        sensorStore: { query: sensorQuery },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.records({
        providerId: "whoop",
        dataType: "metricStream",
        limit: 25,
        offset: 0,
      });

      expect(mockExecute).not.toHaveBeenCalled();
      expect(sensorQuery).toHaveBeenCalledTimes(1);
      expect(sensorQuery.mock.calls[0]?.[1]).toContain("FROM ingest.metric_stream");
      expect(sensorQuery.mock.calls[0]?.[1]).toContain(
        "row_number() OVER (PARTITION BY id ORDER BY version DESC)",
      );
      expect(sensorQuery.mock.calls[0]?.[1]).toContain("version_rank = 1");
      expect(sensorQuery.mock.calls[0]?.[1]).toContain("is_deleted = 0");
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.channel).toBe("heart_rate");
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

    it("includes provider-absent activities in record lists", async () => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.records({ providerId: "strava", dataType: "activities" });

      const sqlText = extractSqlText(mockExecute.mock.calls[0][0]);
      expect(sqlText).not.toContain("provider_absent_at IS NULL");
      expect(sqlText).toContain("provider_absent_at");
    });

    it("does not apply the provider-absent activity filter to non-activity record lists", async () => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.records({ providerId: "strava", dataType: "dailyMetrics" });

      const sqlText = extractSqlText(mockExecute.mock.calls[0][0]);
      expect(sqlText).not.toContain("provider_absent_at IS NULL");
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

    it("applies server-side filters to activity records", async () => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.records({
        providerId: "strava",
        dataType: "activities",
        filters: { activity_type: "run", name: "Morning" },
      });

      const sqlText = extractSqlText(mockExecute.mock.calls[0][0]);
      expect(sqlText).toContain("ILIKE");
      expect(sqlText).toContain("activity_type");
      expect(sqlText).toContain("name");
    });

    it("returns filterable columns with record rows", async () => {
      const caller = createCaller({
        db: {
          execute: vi.fn().mockResolvedValue([{ id: "act-1", name: "Morning Run" }]),
        },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.records({
        providerId: "strava",
        dataType: "activities",
      });

      expect(result.columns).toContain("activity_type");
      expect(result.columns).toContain("name");
      expect(result.columns).not.toContain("provider_id");
      expect(result.filterColumns).toContain("provider_id");
      expect(result.filterColumns).toContain("activity_type");
      expect(result.rows).toHaveLength(1);
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
      dataTypeEnum.options.filter(
        (dataType) => dataType !== "bodyMeasurements" && dataType !== "metricStream",
      ),
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

    it("includes provider-absent activities in record details", async () => {
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

      const sqlText = extractSqlText(mockExecute.mock.calls[0][0]);
      expect(sqlText).not.toContain("provider_absent_at IS NULL");
    });

    it("does not apply the provider-absent activity filter to non-activity record details", async () => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.recordDetail({
        providerId: "strava",
        dataType: "dailyMetrics",
        recordId: "2026-03-01",
      });

      const sqlText = extractSqlText(mockExecute.mock.calls[0][0]);
      expect(sqlText).not.toContain("provider_absent_at IS NULL");
    });
  });

  // ── disconnect ──

  describe("disconnect", () => {
    it("removes authorization without deleting imported provider records", async () => {
      const mockExecute = vi.fn().mockResolvedValue([{ id: "strava" }]);
      const mockTransaction = vi.fn();
      const db = { execute: mockExecute, transaction: mockTransaction };
      const caller = createCaller({
        db,
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(caller.disconnect({ providerId: "strava" })).resolves.toEqual({
        success: true,
      });

      expect(mockDeleteProviderAuthorization).toHaveBeenCalledWith(db, "strava", "user-1");
      expect(mockTransaction).not.toHaveBeenCalled();
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
      expect(ownerText).toContain("fitness.provider_connection");
      expect(ownerText).toContain("SELECT");
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
        "This provider is not connected to your account.",
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

    it("calls revokeExistingTokens before removing authorization when provider supports it", async () => {
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
      expect(mockDeleteProviderAuthorization).toHaveBeenCalledWith(
        expect.anything(),
        "wahoo",
        "user-1",
      );
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
      expect(mockDeleteProviderAuthorization).toHaveBeenCalledWith(
        expect.anything(),
        "strava",
        "user-1",
      );
    });

    it("skips standard OAuth revocation when provider has no OAuth config", async () => {
      mockLoadTokens.mockResolvedValue({
        accessToken: "access-abc",
        refreshToken: "refresh-def",
        expiresAt: new Date("2026-12-31"),
        scopes: null,
      });
      mockEnsureProvidersRegistered.mockResolvedValue(undefined);
      mockGetAllProviders.mockReturnValue([
        {
          id: "manual-provider",
          name: "Manual Provider",
          validate: () => null,
          authSetup: () => ({
            exchangeCode: vi.fn(),
          }),
        },
      ]);

      const txExecute = vi.fn().mockResolvedValue([]);
      const mockTransaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: { execute: typeof txExecute }) => Promise<void>) => {
          await fn({ execute: txExecute });
        });
      const mockExecute = vi.fn().mockResolvedValue([{ id: "manual-provider" }]);

      const caller = createCaller({
        db: { execute: mockExecute, transaction: mockTransaction },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.disconnect({ providerId: "manual-provider" });

      expect(mockRevokeToken).not.toHaveBeenCalled();
      expect(mockDeleteProviderAuthorization).toHaveBeenCalledWith(
        expect.anything(),
        "manual-provider",
        "user-1",
      );
    });

    it("does not call standard OAuth revocation for a missing access token", async () => {
      mockLoadTokens.mockResolvedValue({
        accessToken: null,
        refreshToken: "refresh-only",
        expiresAt: new Date("2026-12-31"),
        scopes: null,
      });
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

      expect(mockRevokeToken).toHaveBeenCalledTimes(1);
      expect(mockRevokeToken).toHaveBeenCalledWith(expect.anything(), "refresh-only");
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
      expect(mockDeleteProviderAuthorization).toHaveBeenCalledWith(
        expect.anything(),
        "wahoo",
        "user-1",
      );
    });

    it("still removes local authorization when all remote revocation methods fail", async () => {
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
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining("Access token revocation failed for wahoo"),
      );
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining("Refresh token revocation failed for wahoo"),
      );
      expect(mockSentryCaptureException).toHaveBeenCalledWith(expect.any(Error));
      expect(mockSentryCaptureException).toHaveBeenCalledTimes(3);
      expect(mockDeleteProviderAuthorization).toHaveBeenCalledWith(
        expect.anything(),
        "wahoo",
        "user-1",
      );
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
      expect(mockDeleteProviderAuthorization).toHaveBeenCalledWith(
        expect.anything(),
        "wahoo",
        "user-1",
      );
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
      expect(mockDeleteProviderAuthorization).toHaveBeenCalledWith(
        expect.anything(),
        "apple-health",
        "user-1",
      );
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

  describe("deleteAllData", () => {
    it("requires the exact DELETE confirmation", async () => {
      const caller = createCaller({
        db: { execute: vi.fn(), transaction: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(
        caller.deleteAllData({ providerId: "strava", confirmation: "delete" }),
      ).rejects.toThrow();
    });

    it("returns queued progress while the deletion request waits for dispatch", async () => {
      const userId = "00000000-0000-4000-8000-000000000001";
      const operationId = "30000000-0000-4000-8000-000000000001";
      const execute = vi.fn().mockResolvedValue([
        {
          event_id: operationId,
          failure_reason: null,
          generation: "1",
          provider_id: "strava",
          status: "pending",
          user_id: userId,
        },
      ]);
      const caller = createCaller({ db: { execute, transaction: vi.fn() }, userId });

      await expect(caller.deletionStatus({ providerId: "strava", operationId })).resolves.toEqual({
        status: "queued",
        message: "Provider data deletion is pending...",
      });
      expect(mockGetProviderDataDeletionJob).not.toHaveBeenCalled();
    });

    it("returns generic progress for an active deletion job", async () => {
      const userId = "00000000-0000-4000-8000-000000000001";
      const operationId = "30000000-0000-4000-8000-000000000001";
      const execute = vi.fn().mockResolvedValue([
        {
          event_id: operationId,
          failure_reason: null,
          generation: "1",
          provider_id: "strava",
          status: "dispatched",
          user_id: userId,
        },
      ]);
      mockGetProviderDataDeletionJob.mockResolvedValue({
        failedReason: undefined,
        getState: vi.fn().mockResolvedValue("active"),
        progress: { percentage: 50, message: "Tombstoned 10,000 metric stream rows..." },
      });
      const caller = createCaller({ db: { execute, transaction: vi.fn() }, userId });

      await expect(caller.deletionStatus({ providerId: "strava", operationId })).resolves.toEqual({
        status: "running",
        percentage: 50,
        message: "Tombstoned 10,000 metric stream rows...",
      });
    });

    it("returns completed progress without looking up a queue job", async () => {
      const userId = "00000000-0000-4000-8000-000000000001";
      const operationId = "30000000-0000-4000-8000-000000000001";
      const execute = vi.fn().mockResolvedValue([
        {
          event_id: operationId,
          failure_reason: null,
          generation: "1",
          provider_id: "strava",
          status: "completed",
          user_id: userId,
        },
      ]);
      const caller = createCaller({ db: { execute, transaction: vi.fn() }, userId });

      await expect(caller.deletionStatus({ providerId: "strava", operationId })).resolves.toEqual({
        status: "completed",
        percentage: 100,
        message: "Provider data deleted",
      });
      expect(mockGetProviderDataDeletionJob).not.toHaveBeenCalled();
    });

    it("returns a durable failure after the deletion job is evicted", async () => {
      const userId = "00000000-0000-4000-8000-000000000001";
      const operationId = "30000000-0000-4000-8000-000000000001";
      const execute = vi.fn().mockResolvedValue([
        {
          event_id: operationId,
          failure_reason: "Provider credentials were rejected",
          generation: "1",
          provider_id: "strava",
          status: "failed",
          user_id: userId,
        },
      ]);
      const caller = createCaller({ db: { execute, transaction: vi.fn() }, userId });

      await expect(caller.deletionStatus({ providerId: "strava", operationId })).resolves.toEqual({
        status: "failed",
        message: "Provider credentials were rejected",
      });
      expect(mockGetProviderDataDeletionJob).not.toHaveBeenCalled();
    });

    it("returns queued progress when the deletion job is not available yet", async () => {
      const userId = "00000000-0000-4000-8000-000000000001";
      const operationId = "30000000-0000-4000-8000-000000000001";
      const execute = vi.fn().mockResolvedValue([
        {
          event_id: operationId,
          failure_reason: null,
          generation: "1",
          provider_id: "strava",
          status: "dispatched",
          user_id: userId,
        },
      ]);
      mockGetProviderDataDeletionJob.mockResolvedValue(undefined);
      const caller = createCaller({ db: { execute, transaction: vi.fn() }, userId });

      await expect(caller.deletionStatus({ providerId: "strava", operationId })).resolves.toEqual({
        status: "queued",
        message: "Provider data deletion is pending...",
      });
    });

    it("reports queue lookup errors with an actionable client error", async () => {
      const userId = "00000000-0000-4000-8000-000000000001";
      const operationId = "30000000-0000-4000-8000-000000000001";
      const queueError = new Error("Redis unavailable");
      const execute = vi.fn().mockResolvedValue([
        {
          event_id: operationId,
          failure_reason: null,
          generation: "1",
          provider_id: "strava",
          status: "dispatched",
          user_id: userId,
        },
      ]);
      mockGetProviderDataDeletionJob.mockRejectedValue(queueError);
      const caller = createCaller({ db: { execute, transaction: vi.fn() }, userId });

      await expect(
        caller.deletionStatus({ providerId: "strava", operationId }),
      ).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
        message: "Unable to check provider data deletion progress",
        cause: queueError,
      });
      expect(mockSentryCaptureException).toHaveBeenCalledWith(queueError, {
        tags: { operation: "providerDataDeletionStatus" },
      });
    });

    it("does not expose deletion progress owned by another user", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]), transaction: vi.fn() },
        userId: "00000000-0000-4000-8000-000000000001",
      });

      await expect(
        caller.deletionStatus({
          providerId: "strava",
          operationId: "30000000-0000-4000-8000-000000000001",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("rejects deletion when the provider is not owned by the user", async () => {
      const transaction = vi.fn();
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]), transaction },
        sensorStore: { query: vi.fn().mockResolvedValue([{ has_data: 0 }]) },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(
        caller.deleteAllData({ providerId: "strava", confirmation: "DELETE" }),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "No connected provider or retained provider data was found for your account.",
      });
      expect(transaction).not.toHaveBeenCalled();
    });

    it("accepts canonical deletion for a disconnected user with retained records", async () => {
      const userId = "00000000-0000-4000-8000-000000000001";
      const execute = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ has_data: true }]);
      const transactionExecute = vi.fn().mockResolvedValue([
        {
          event_id: "30000000-0000-4000-8000-000000000002",
          generation: "1",
          provider_id: "strava",
          user_id: userId,
        },
      ]);
      const transaction = vi.fn(
        async (callback: (database: { execute: typeof transactionExecute }) => Promise<unknown>) =>
          callback({ execute: transactionExecute }),
      );
      const sensorQuery = vi.fn();
      const caller = createCaller({
        db: { execute, transaction },
        sensorStore: { query: sensorQuery },
        userId,
        timezone: "UTC",
      });

      await expect(
        caller.deleteAllData({ providerId: "strava", confirmation: "DELETE" }),
      ).resolves.toEqual({
        success: true,
        operationId: "30000000-0000-4000-8000-000000000002",
      });
      expect(sensorQuery).not.toHaveBeenCalled();
      expect(transaction).toHaveBeenCalledOnce();
    });

    it("atomically deletes provider records and writes a transactional outbox request", async () => {
      const userId = "00000000-0000-4000-8000-000000000001";
      const txExecute = vi.fn().mockResolvedValue([
        {
          event_id: "30000000-0000-4000-8000-000000000001",
          generation: "1",
          provider_id: "strava",
          user_id: userId,
        },
      ]);
      const mockTransaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: { execute: typeof txExecute }) => Promise<unknown>) => {
          return fn({ execute: txExecute });
        });
      const mockExecute = vi.fn().mockResolvedValueOnce([{ id: "strava" }]);
      const caller = createCaller({
        db: { execute: mockExecute, transaction: mockTransaction },
        userId,
        timezone: "UTC",
      });

      await expect(
        caller.deleteAllData({ providerId: "strava", confirmation: "DELETE" }),
      ).resolves.toEqual({
        success: true,
        operationId: "30000000-0000-4000-8000-000000000001",
      });

      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(mockProviderDataDeletesInc).toHaveBeenCalledWith({ provider_id: "strava" });
      const deleteSql = txExecute.mock.calls.map((call) => extractSqlText(call[0])).join("\n");
      expect(deleteSql).not.toContain("fitness.oauth_token");
      expect(deleteSql).toContain("fitness.provider_data_generation");
      expect(deleteSql).toContain("fitness.provider_data_deletion_outbox");
    });
  });
});
