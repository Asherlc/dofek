import { describe, expect, it, vi } from "vitest";
import type { BodyClickHouseStore } from "./body-clickhouse.ts";
import {
  dataTypeEnum,
  getRecordDisplayColumns,
  getRecordFilterColumns,
  getRecordSelectFilterColumns,
  isJournalQuestionSlugFilterColumn,
  PROVIDER_ACCOUNT_TABLES,
  PROVIDER_DATA_TABLES,
  ProviderDetailRepository,
  SYNC_LOG_FILTER_OPTION_FIELDS,
  tableInfo,
  usesClickHouseRecordFilterOptions,
} from "./provider-detail-repository.ts";

// ---------------------------------------------------------------------------
// tableInfo
// ---------------------------------------------------------------------------

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
    for (const dataType of dataTypeEnum.options) {
      const result = tableInfo(dataType);
      expect(result.table).toBeTruthy();
      expect(result.orderColumn).toBeTruthy();
      expect(result.idColumn).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// dataTypeEnum
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// PROVIDER_ACCOUNT_TABLES
// ---------------------------------------------------------------------------

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
    expect(PROVIDER_ACCOUNT_TABLES).toContain("fitness.supplement_dose_event");
    expect(PROVIDER_ACCOUNT_TABLES).toContain("fitness.medication_dose_event");
    expect(PROVIDER_ACCOUNT_TABLES).toContain("fitness.health_event");
    expect(PROVIDER_ACCOUNT_TABLES).toContain("fitness.journal_entry");
    expect(PROVIDER_ACCOUNT_TABLES).toContain("fitness.dexa_scan");
    expect(PROVIDER_ACCOUNT_TABLES).toContain("fitness.sync_log");
    expect(PROVIDER_ACCOUNT_TABLES).toContain("fitness.activity");
    expect(PROVIDER_ACCOUNT_TABLES).toContain("fitness.oauth_token");
    expect(PROVIDER_ACCOUNT_TABLES).toContain("fitness.provider_connection");
  });

  it("starts with daily_metrics after Postgres metric_stream retirement", () => {
    expect(PROVIDER_ACCOUNT_TABLES[0]).toBe("fitness.daily_metrics");
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

// ---------------------------------------------------------------------------
// ProviderDetailRepository
// ---------------------------------------------------------------------------

describe("ProviderDetailRepository", () => {
  function stringifyQuery(query: unknown): string {
    if (typeof query === "object" && query !== null) {
      const sqlCandidate = Reflect.get(query, "sql");
      if (typeof sqlCandidate === "string") {
        return sqlCandidate;
      }
      const queryCandidate = Reflect.get(query, "query");
      if (typeof queryCandidate === "string") {
        return queryCandidate;
      }
    }
    return JSON.stringify(query);
  }

  function makeRepository(rows: Record<string, unknown>[] = [], transactionOverride?: unknown) {
    const execute = vi.fn().mockResolvedValue(rows);
    const transaction = transactionOverride ?? vi.fn();
    const db: Pick<import("dofek/db").Database, "execute" | "transaction"> = {
      execute,
      transaction,
    };
    const repo = new ProviderDetailRepository(db, "user-1");
    return { repo, execute, transaction, db };
  }

  function makeBodyStore(rows: Record<string, unknown>[] = []) {
    const queryImplementation: BodyClickHouseStore["query"] = async (schema) =>
      rows.map((row) => schema.parse(row));
    const query = vi.fn(queryImplementation);
    const bodyStore: BodyClickHouseStore = { query };
    return { bodyStore, query };
  }

  // ── getRecords ──

  describe("getAvailableDataTypes", () => {
    it("uses the provider's actual records instead of aggregate provider stats", async () => {
      const { db, execute } = makeRepository([
        { data_type: "activities" },
        { data_type: "foodEntries" },
      ]);
      const { bodyStore, query } = makeBodyStore([{ data_type: "metricStream" }]);
      const repo = new ProviderDetailRepository(db, "user-1", bodyStore);

      await expect(repo.getAvailableDataTypes("kaya-export")).resolves.toEqual([
        "activities",
        "foodEntries",
        "metricStream",
      ]);
      expect(execute).toHaveBeenCalledOnce();
      expect(query).toHaveBeenCalledOnce();
    });

    it("fails loudly when ClickHouse availability cannot be checked", async () => {
      const { repo } = makeRepository();

      await expect(repo.getAvailableDataTypes("kaya-export")).rejects.toThrow(
        "providerDetail record availability requires the ClickHouse store",
      );
    });
  });

  describe("getRecords", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getRecords("strava", "activities", 50, 0);
      expect(result).toEqual([]);
    });

    it("returns rows from the database", async () => {
      const { repo } = makeRepository([
        { id: "act-1", name: "Morning Run", canonical_type: "running" },
      ]);
      const result = await repo.getRecords("strava", "activities", 20, 0);
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("Morning Run");
    });

    it("calls execute once per query", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getRecords("strava", "activities", 50, 0);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("adds ILIKE filters to postgres record queries", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getRecords("strava", "activities", 50, 0, { name: "Morning" });

      const sqlText = stringifyQuery(execute.mock.calls[0]?.[0]);
      expect(sqlText).toContain("ILIKE");
      expect(sqlText).toContain("name");
    });

    it("adds datetime range filters to postgres record queries", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getRecords("strava", "activities", 50, 0, {
        started_at_from: "2024-06-01T08:00",
        started_at_to: "2024-06-30T18:00",
      });

      expect(execute).toHaveBeenCalledTimes(1);
      const sqlText = stringifyQuery(execute.mock.calls[0]?.[0]);
      expect(sqlText).toContain("started_at");
      expect(sqlText).toContain("::timestamptz");
    });

    it("includes provider-absent activities in activity record lists", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getRecords("strava", "activities", 50, 0);

      const sqlText = stringifyQuery(execute.mock.calls[0]?.[0]);
      expect(sqlText).not.toContain("provider_absent_at IS NULL");
      expect(sqlText).toContain("provider_absent_at");
    });

    it("requires a ClickHouse body store for body measurements", async () => {
      const { repo } = makeRepository([]);

      await expect(repo.getRecords("withings", "bodyMeasurements", 10, 0)).rejects.toThrow(
        "providerDetail body measurements require the ClickHouse store",
      );
    });

    it("passes body measurement query parameters to ClickHouse", async () => {
      const { bodyStore, query } = makeBodyStore([]);
      const { db } = makeRepository([]);
      const repo = new ProviderDetailRepository(db, "user-1", bodyStore);

      await repo.getRecords("withings", "bodyMeasurements", 10, 5);

      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0]?.[1]).toContain("analytics.v_body_measurement");
      expect(query.mock.calls[0]?.[1]).toContain("ORDER BY recorded_at DESC");
      expect(query.mock.calls[0]?.[2]).toStrictEqual({
        userId: "user-1",
        providerId: "withings",
        limit: 10,
        offset: 5,
      });
    });

    it("requires the ClickHouse store for metric stream", async () => {
      const { repo } = makeRepository([]);

      await expect(repo.getRecords("whoop", "metricStream", 10, 0)).rejects.toThrow(
        "providerDetail metric stream requires the ClickHouse store",
      );
    });

    it("reads deduplicated metric stream rows from ClickHouse with the query parameters", async () => {
      const { bodyStore, query } = makeBodyStore([]);
      const { db } = makeRepository([]);
      const repo = new ProviderDetailRepository(db, "user-1", bodyStore);

      await repo.getRecords("whoop", "metricStream", 10, 5);

      expect(query).toHaveBeenCalledTimes(1);
      // Reads the deduped Redpanda-fed mirror, not Postgres.
      expect(query.mock.calls[0]?.[1]).toContain("FROM ingest.metric_stream");
      expect(query.mock.calls[0]?.[1]).toContain(
        "row_number() OVER (PARTITION BY id ORDER BY version DESC)",
      );
      expect(query.mock.calls[0]?.[1]).toContain("version_rank = 1");
      expect(query.mock.calls[0]?.[1]).toContain("is_deleted = 0");
      // recorded_at is rendered in UTC so the literal 'Z' suffix is accurate.
      expect(query.mock.calls[0]?.[1]).toContain("'%Y-%m-%dT%H:%i:%S.%fZ', 'UTC'");
      expect(query.mock.calls[0]?.[2]).toStrictEqual({
        userId: "user-1",
        providerId: "whoop",
        limit: 10,
        offset: 5,
      });
    });
  });

  // ── getRecordDetail ──

  describe("getRecordDetail", () => {
    it("returns a single record", async () => {
      const { repo } = makeRepository([
        { id: "act-1", name: "Morning Run", raw: { distance: 5000 } },
      ]);
      const result = await repo.getRecordDetail("strava", "activities", "act-1");
      expect(result).not.toBeNull();
      expect(result?.raw).toEqual({ distance: 5000 });
    });

    it("returns null for non-existent record", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getRecordDetail("strava", "activities", "nonexistent");
      expect(result).toBeNull();
    });

    it("getRecordDetail returns exactly null (not undefined) for missing record", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getRecordDetail("strava", "activities", "nonexistent");
      expect(result).toStrictEqual(null);
    });

    it("calls execute once per query", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getRecordDetail("strava", "activities", "act-1");
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("includes provider-absent activities in activity record details", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getRecordDetail("strava", "activities", "act-1");

      const sqlText = stringifyQuery(execute.mock.calls[0]?.[0]);
      expect(sqlText).not.toContain("provider_absent_at IS NULL");
    });

    it("filters body measurement detail by record ID in ClickHouse", async () => {
      const bodyRow = { id: "body-1", provider_id: "withings", user_id: "user-1" };
      const { bodyStore, query } = makeBodyStore([bodyRow]);
      const { db } = makeRepository([]);
      const repo = new ProviderDetailRepository(db, "user-1", bodyStore);

      const result = await repo.getRecordDetail("withings", "bodyMeasurements", "body-1");

      expect(result).toStrictEqual(bodyRow);
      expect(query.mock.calls[0]?.[1]).toContain("AND toString(id) = {recordId:String}");
      expect(query.mock.calls[0]?.[2]).toStrictEqual({
        userId: "user-1",
        providerId: "withings",
        recordId: "body-1",
        limit: 1,
        offset: 0,
      });
    });
  });

  // ── verifyOwnership ──

  describe("verifyOwnership", () => {
    it("queries the authoritative provider connection for the user", async () => {
      const { repo, execute } = makeRepository([{ id: "strava" }]);
      const result = await repo.verifyOwnership("strava");
      expect(result).toBe(true);
      const queryString = stringifyQuery(vi.mocked(execute).mock.calls[0]?.[0]);
      expect(queryString).toMatch(/fitness\.provider_connection/i);
      expect(queryString).not.toMatch(/fitness\.oauth_token/i);
    });

    it("returns true when the provider connection exists", async () => {
      const { repo } = makeRepository([{ id: "strava" }]);
      const result = await repo.verifyOwnership("strava");
      expect(result).toBe(true);
    });

    it("verifyOwnership returns exactly true (not truthy) for existing provider", async () => {
      const { repo } = makeRepository([{ id: "strava" }]);
      const result = await repo.verifyOwnership("strava");
      expect(result).toStrictEqual(true);
    });

    it("returns false when provider does not exist in either table for user", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.verifyOwnership("unknown");
      expect(result).toBe(false);
    });

    it("verifyOwnership returns exactly false (not falsy) for missing provider", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.verifyOwnership("unknown");
      expect(result).toStrictEqual(false);
    });

    it("calls execute once", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.verifyOwnership("strava");
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("canDeleteProviderData", () => {
    it("allows a disconnected user with retained PostgreSQL records", async () => {
      const { bodyStore, query } = makeBodyStore([{ has_data: 0 }]);
      const execute = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ has_data: true }]);
      const transaction = vi.fn();
      const repository = new ProviderDetailRepository(
        { execute, transaction },
        "user-1",
        bodyStore,
      );

      await expect(repository.canDeleteProviderData("strava")).resolves.toBe(true);
      expect(stringifyQuery(execute.mock.calls[1]?.[0])).toContain("fitness.activity");
      expect(query).not.toHaveBeenCalled();
    });

    it("allows a disconnected user with active retained metric-stream records", async () => {
      const { bodyStore, query } = makeBodyStore([{ has_data: 1 }]);
      const execute = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ has_data: false }]);
      const transaction = vi.fn();
      const repository = new ProviderDetailRepository(
        { execute, transaction },
        "user-1",
        bodyStore,
      );

      await expect(repository.canDeleteProviderData("whoop")).resolves.toBe(true);
      expect(query.mock.calls[0]?.[1]).toContain(
        "argMax(is_deleted, tuple(version, ingested_at)) = 0",
      );
      expect(query.mock.calls[0]?.[2]).toEqual({
        userId: "user-1",
        providerId: "whoop",
      });
    });

    it("rejects a user with no connection or retained records", async () => {
      const { bodyStore } = makeBodyStore([{ has_data: 0 }]);
      const execute = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ has_data: false }]);
      const transaction = vi.fn();
      const repository = new ProviderDetailRepository(
        { execute, transaction },
        "user-2",
        bodyStore,
      );

      await expect(repository.canDeleteProviderData("strava")).resolves.toBe(false);
    });
  });

  describe("requestProviderDataDeletion", () => {
    it("atomically deletes provider records and writes the deletion request to the outbox", async () => {
      const deletionEventId = "10000000-0000-4000-8000-000000000001";
      const userId = "00000000-0000-4000-8000-000000000001";
      const txExecute = vi.fn().mockImplementation(async (_query: unknown) => {
        if (txExecute.mock.calls.length === PROVIDER_DATA_TABLES.length + 1) {
          return [
            {
              event_id: deletionEventId,
              generation: "1",
              provider_id: "strava",
              user_id: userId,
            },
          ];
        }
        return [];
      });
      const mockTransaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: { execute: typeof txExecute }) => Promise<unknown>) => {
          return fn({ execute: txExecute });
        });
      const db: Pick<import("dofek/db").Database, "execute" | "transaction"> = {
        execute: vi.fn(),
        transaction: mockTransaction,
      };
      const repo = new ProviderDetailRepository(db, userId);

      await expect(repo.requestProviderDataDeletion("strava")).resolves.toEqual({
        eventId: deletionEventId,
        generation: 1,
        providerId: "strava",
        userId,
      });

      const deleteSql = txExecute.mock.calls.map((call) => stringifyQuery(call[0])).join("\n");
      expect(deleteSql).toContain("fitness.medication");
      expect(deleteSql).toContain("fitness.condition");
      expect(deleteSql).toContain("fitness.allergy_intolerance");
      expect(deleteSql).toContain("fitness.imu_session");
      expect(deleteSql).not.toContain("fitness.oauth_token");
      expect(deleteSql).toContain("fitness.provider_data_generation");
      expect(deleteSql).toContain("fitness.provider_data_deletion_outbox");
      expect(txExecute).toHaveBeenCalledTimes(PROVIDER_DATA_TABLES.length + 1);
      expect(mockTransaction).toHaveBeenCalledTimes(1);
    });
  });

  // ── getRecordDetail precise value mapping ──

  describe("getRecordDetail value mapping", () => {
    it("returns the first row (not second or empty object) when rows exist", async () => {
      const { repo } = makeRepository([
        { id: "rec-1", field: "value-1" },
        { id: "rec-2", field: "value-2" },
      ]);
      const result = await repo.getRecordDetail("strava", "activities", "rec-1");
      expect(result).toStrictEqual({ id: "rec-1", field: "value-1" });
    });

    it("returns null (not undefined or empty object) when no rows match", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getRecordDetail("strava", "activities", "none");
      expect(result).toStrictEqual(null);
      expect(result).not.toBe(undefined);
    });
  });

  // ── verifyOwnership length check ──

  describe("verifyOwnership length check", () => {
    it("returns true when exactly one row (rows.length > 0, not >= 0)", async () => {
      const { repo } = makeRepository([{ id: "p-1" }]);
      expect(await repo.verifyOwnership("p-1")).toStrictEqual(true);
    });

    it("returns false when zero rows (rows.length > 0 is false)", async () => {
      const { repo } = makeRepository([]);
      expect(await repo.verifyOwnership("p-1")).toStrictEqual(false);
    });
  });

  // ── tableInfo return value precision ──

  describe("tableInfo precise return values", () => {
    it("returns exactly {table, orderColumn, idColumn} for each type", () => {
      // Verify exact shape (no extra properties, correct values)
      expect(tableInfo("activities")).toStrictEqual({
        table: "fitness.activity",
        orderColumn: "started_at",
        idColumn: "id",
      });
      expect(tableInfo("dailyMetrics")).toStrictEqual({
        table: "fitness.daily_metrics",
        orderColumn: "date",
        idColumn: "date",
      });
      expect(tableInfo("sleepSessions")).toStrictEqual({
        table: "fitness.sleep_session",
        orderColumn: "started_at",
        idColumn: "id",
      });
      expect(tableInfo("bodyMeasurements")).toStrictEqual({
        table: "analytics.v_body_measurement",
        orderColumn: "recorded_at",
        idColumn: "id",
      });
      expect(tableInfo("foodEntries")).toStrictEqual({
        table: "fitness.food_entry",
        orderColumn: "date",
        idColumn: "id",
      });
      expect(tableInfo("healthEvents")).toStrictEqual({
        table: "fitness.health_event",
        orderColumn: "start_date",
        idColumn: "id",
      });
      expect(tableInfo("metricStream")).toStrictEqual({
        table: "ingest.metric_stream",
        orderColumn: "recorded_at",
        idColumn: "id",
      });
      expect(tableInfo("nutritionDaily")).toStrictEqual({
        table: "fitness.v_nutrition_provider_daily",
        orderColumn: "date",
        idColumn: "date",
      });
      expect(tableInfo("labPanels")).toStrictEqual({
        table: "fitness.lab_panel",
        orderColumn: "recorded_at",
        idColumn: "id",
      });
      expect(tableInfo("labResults")).toStrictEqual({
        table: "fitness.lab_result",
        orderColumn: "recorded_at",
        idColumn: "id",
      });
      expect(tableInfo("journalEntries")).toStrictEqual({
        table: "fitness.journal_entry",
        orderColumn: "date",
        idColumn: "id",
      });
    });
  });

  describe("getRecordDisplayColumns (mutation-killing)", () => {
    it("uses body measurement columns (not metric stream columns)", () => {
      const columns = getRecordDisplayColumns("bodyMeasurements");
      expect(columns).toContain("weight_kg");
      expect(columns).not.toContain("channel");
      expect(columns).not.toContain("scalar");
    });

    it("excludes user_id and provider_id from display columns", () => {
      for (const dataType of ["bodyMeasurements", "metricStream", "activities"] as const) {
        const columns = getRecordDisplayColumns(dataType);
        expect(columns).not.toContain("user_id");
        expect(columns).not.toContain("provider_id");
        expect(getRecordFilterColumns(dataType)).toContain("provider_id");
      }
    });

    it("prioritizes known columns and caps display columns at six", () => {
      expect(getRecordDisplayColumns("activities")).toStrictEqual([
        "id",
        "name",
        "started_at",
        "canonical_type",
        "external_id",
        "provider_type",
      ]);
      expect(getRecordDisplayColumns("metricStream")).toHaveLength(6);
      expect(getRecordDisplayColumns("metricStream")).not.toContain("scalar");
    });

    it("does not duplicate columns in the display list", () => {
      for (const dataType of dataTypeEnum.options) {
        const columns = getRecordDisplayColumns(dataType);
        expect(new Set(columns).size).toBe(columns.length);
      }
    });
  });

  describe("mutation-killing: boundary and operator tests", () => {
    it("verifyOwnership uses rows.length > 0 (not >= 0 which is always true)", async () => {
      // With empty rows, length is 0, > 0 is false -> returns false
      // If mutated to >= 0, 0 >= 0 is true -> would return true incorrectly
      const { repo } = makeRepository([]);
      const result = await repo.verifyOwnership("nonexistent");
      expect(result).toStrictEqual(false);
    });

    it("verifyOwnership returns true with multiple rows (> 0 still true)", async () => {
      const { repo } = makeRepository([{ id: "p1" }, { id: "p2" }]);
      const result = await repo.verifyOwnership("p1");
      expect(result).toStrictEqual(true);
    });

    it("getRecordDetail returns first row via rows[0] (not rows[1] or last)", async () => {
      // rows[0] ?? null — must be first element
      const { repo } = makeRepository([
        { id: "first", value: 1 },
        { id: "second", value: 2 },
      ]);
      const result = await repo.getRecordDetail("strava", "activities", "first");
      expect(result).toStrictEqual({ id: "first", value: 1 });
      expect(result).not.toStrictEqual({ id: "second", value: 2 });
    });

    it("getRecordDetail returns null via ?? null (not undefined via ?? undefined)", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getRecordDetail("strava", "activities", "missing");
      expect(result).toStrictEqual(null);
      expect(result === null).toBe(true);
    });

    it("PROVIDER_ACCOUNT_TABLES is an array (not empty array from ArrayDeclaration mutation)", () => {
      expect(PROVIDER_ACCOUNT_TABLES.length).toBe(18);
      expect(PROVIDER_ACCOUNT_TABLES[0]).toBe("fitness.daily_metrics");
      expect(PROVIDER_ACCOUNT_TABLES[17]).toBe("fitness.provider_connection");
    });

    it("tableInfo returns three-key objects (not empty objects from ObjectLiteral mutation)", () => {
      for (const dataType of dataTypeEnum.options) {
        const info = tableInfo(dataType);
        expect(Object.keys(info)).toHaveLength(3);
        expect(Object.keys(info).sort()).toStrictEqual(["idColumn", "orderColumn", "table"]);
        expect(info.table.length).toBeGreaterThan(0);
        expect(info.orderColumn.length).toBeGreaterThan(0);
        expect(info.idColumn.length).toBeGreaterThan(0);
      }
    });

    it("tableInfo metricStream uses id as the row identifier and recorded_at for ordering", () => {
      const info = tableInfo("metricStream");
      expect(info.idColumn).toBe("id");
      expect(info.orderColumn).toBe("recorded_at");
      expect(info.idColumn).not.toBe(info.orderColumn);
    });

    it("tableInfo dailyMetrics has idColumn 'date' (not 'id')", () => {
      const info = tableInfo("dailyMetrics");
      expect(info.idColumn).toBe("date");
      expect(info.idColumn).not.toBe("id");
    });

    it("tableInfo nutritionDaily has idColumn 'date' (not 'id')", () => {
      const info = tableInfo("nutritionDaily");
      expect(info.idColumn).toBe("date");
      expect(info.idColumn).not.toBe("id");
    });

    it("getRecords returns array (not null or single object)", async () => {
      const { repo } = makeRepository([
        { id: "r1", data: "a" },
        { id: "r2", data: "b" },
      ]);
      const result = await repo.getRecords("strava", "activities", 50, 0);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
    });

    it("dataTypeEnum has exactly 11 options (not 10 or 12 from ArrayDeclaration mutation)", () => {
      expect(dataTypeEnum.options).toHaveLength(11);
      // Verify first and last entries specifically
      expect(dataTypeEnum.options[0]).toBe("activities");
      expect(dataTypeEnum.options[10]).toBe("journalEntries");
    });

    it("PROVIDER_ACCOUNT_TABLES ordering: activity comes before oauth_token", () => {
      const activityIndex = PROVIDER_ACCOUNT_TABLES.indexOf("fitness.activity");
      const oauthIndex = PROVIDER_ACCOUNT_TABLES.indexOf("fitness.oauth_token");
      expect(activityIndex).toBeGreaterThanOrEqual(0);
      expect(oauthIndex).toBeGreaterThanOrEqual(0);
      expect(activityIndex).toBeLessThan(oauthIndex);
    });
  });

  describe("getSyncLogFilterOptions", () => {
    it("queries distinct values for each sync log dropdown column", async () => {
      const { repo, execute } = makeRepository([{ value: "success" }, { value: "error" }]);

      const result = await repo.getSyncLogFilterOptions("strava");

      expect(Object.keys(result)).toEqual(Object.keys(SYNC_LOG_FILTER_OPTION_FIELDS));
      expect(execute).toHaveBeenCalledTimes(Object.keys(SYNC_LOG_FILTER_OPTION_FIELDS).length);
      expect(result.status).toEqual([{ value: "success" }, { value: "error" }]);
      expect(result.dataType).toEqual([{ value: "success" }, { value: "error" }]);
    });
  });

  describe("getRecordFilterOptions", () => {
    it("identifies journal question_slug columns for joined filter options", () => {
      expect(isJournalQuestionSlugFilterColumn("journalEntries", "question_slug")).toBe(true);
      expect(isJournalQuestionSlugFilterColumn("journalEntries", "date")).toBe(false);
      expect(isJournalQuestionSlugFilterColumn("activities", "question_slug")).toBe(false);
    });

    it("identifies ClickHouse-backed record filter option data types", () => {
      expect(usesClickHouseRecordFilterOptions("bodyMeasurements")).toBe(true);
      expect(usesClickHouseRecordFilterOptions("metricStream")).toBe(true);
      expect(usesClickHouseRecordFilterOptions("activities")).toBe(false);
    });

    it("queries distinct postgres values for categorical record columns", async () => {
      const { repo, execute } = makeRepository([{ value: "running" }, { value: "cycling" }]);

      const result = await repo.getRecordFilterOptions("strava", "activities");

      expect(getRecordSelectFilterColumns("activities")).toContain("canonical_type");
      expect(result.canonical_type).toEqual([{ value: "running" }, { value: "cycling" }]);
      expect(result.source_name).toEqual([{ value: "running" }, { value: "cycling" }]);
      expect(execute).toHaveBeenCalledTimes(getRecordSelectFilterColumns("activities").length);
    });

    it("joins journal questions for question_slug labels", async () => {
      const { repo, execute } = makeRepository([
        { value: "mood", label: "Mood" },
        { value: "energy", label: null },
      ]);

      const result = await repo.getRecordFilterOptions("whoop", "journalEntries");

      const sqlText = stringifyQuery(execute.mock.calls[0]?.[0]);
      expect(sqlText).toContain("fitness.journal_entry je");
      expect(sqlText).toContain("fitness.journal_question jq");
      expect(sqlText).not.toContain("SELECT DISTINCT question_slug AS value");
      expect(result.question_slug).toEqual([{ value: "mood", label: "Mood" }, { value: "energy" }]);
    });

    it("queries ClickHouse for body measurement dropdown values", async () => {
      const { bodyStore, query } = makeBodyStore([{ value: "withings" }, { value: "garmin" }]);
      const { db, execute } = makeRepository([]);
      const repo = new ProviderDetailRepository(db, "user-1", bodyStore);

      const result = await repo.getRecordFilterOptions("withings", "bodyMeasurements");

      expect(execute).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledTimes(getRecordSelectFilterColumns("bodyMeasurements").length);
      const sourceQuery = query.mock.calls[0];
      expect(String(sourceQuery?.[1])).toContain("analytics.v_body_measurement");
      expect(String(sourceQuery?.[1])).not.toContain("is_deleted = 0");
      expect(sourceQuery?.[2]).toStrictEqual({
        userId: "user-1",
        providerId: "withings",
        limit: 500,
      });
      expect(result.source_name).toEqual([{ value: "withings" }, { value: "garmin" }]);
    });

    it("queries ClickHouse for metric stream dropdown values", async () => {
      const { bodyStore, query } = makeBodyStore([
        { value: "heart_rate" },
        { value: "rr_interval_ms" },
      ]);
      const { db } = makeRepository([]);
      const repo = new ProviderDetailRepository(db, "user-1", bodyStore);

      const result = await repo.getRecordFilterOptions("whoop", "metricStream");

      expect(query).toHaveBeenCalledTimes(getRecordSelectFilterColumns("metricStream").length);
      const channelQuery = query.mock.calls.find((call) =>
        String(call[1]).includes("DISTINCT channel"),
      );
      expect(channelQuery?.[1]).toContain("AND is_deleted = 0");
      expect(channelQuery?.[2]).toStrictEqual({
        userId: "user-1",
        providerId: "whoop",
        limit: 500,
      });
      expect(result.channel).toEqual([{ value: "heart_rate" }, { value: "rr_interval_ms" }]);
    });

    it("requires ClickHouse for body measurement filter options", async () => {
      const { repo } = makeRepository([]);

      await expect(repo.getRecordFilterOptions("withings", "bodyMeasurements")).rejects.toThrow(
        "providerDetail analytics.v_body_measurement filter options require the ClickHouse store",
      );
    });

    it("requires ClickHouse for metric stream filter options", async () => {
      const { repo } = makeRepository([]);

      await expect(repo.getRecordFilterOptions("whoop", "metricStream")).rejects.toThrow(
        "providerDetail ingest.metric_stream filter options require the ClickHouse store",
      );
    });

    it("returns a frozen empty object for data types without dropdown filters", async () => {
      const { repo, execute } = makeRepository([]);

      const result = await repo.getRecordFilterOptions("cronometer", "nutritionDaily");

      expect(result).toEqual({});
      expect(Object.isFrozen(result)).toBe(true);
      expect(execute).not.toHaveBeenCalled();
    });
  });
});
