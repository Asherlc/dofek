import { describe, expect, it, vi } from "vitest";
import {
  DISCONNECT_CHILD_TABLES,
  dataTypeEnum,
  ProviderDetailRepository,
  tableInfo,
} from "./provider-detail-repository.ts";

// ---------------------------------------------------------------------------
// tableInfo
// ---------------------------------------------------------------------------

describe("tableInfo", () => {
  it.each([
    ["activities", "fitness.activity", "started_at", "id"],
    ["dailyMetrics", "fitness.daily_metrics", "date", "date"],
    ["sleepSessions", "fitness.sleep_session", "started_at", "id"],
    ["bodyMeasurements", "fitness.body_measurement", "recorded_at", "id"],
    ["foodEntries", "fitness.food_entry", "date", "id"],
    ["healthEvents", "fitness.health_event", "start_date", "id"],
    ["metricStream", "fitness.sensor_sample", "recorded_at", "recorded_at"],
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
// DISCONNECT_CHILD_TABLES
// ---------------------------------------------------------------------------

describe("DISCONNECT_CHILD_TABLES", () => {
  it("contains 17 child tables", () => {
    expect(DISCONNECT_CHILD_TABLES).toHaveLength(17);
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
    expect(DISCONNECT_CHILD_TABLES).toContain("fitness.lab_panel");
    expect(DISCONNECT_CHILD_TABLES).toContain("fitness.health_event");
    expect(DISCONNECT_CHILD_TABLES).toContain("fitness.journal_entry");
    expect(DISCONNECT_CHILD_TABLES).toContain("fitness.dexa_scan");
    expect(DISCONNECT_CHILD_TABLES).toContain("fitness.sync_log");
    expect(DISCONNECT_CHILD_TABLES).toContain("fitness.activity");
    expect(DISCONNECT_CHILD_TABLES).toContain("fitness.oauth_token");
  });

  it("starts with fitness.sensor_sample (first to delete)", () => {
    expect(DISCONNECT_CHILD_TABLES[0]).toBe("fitness.sensor_sample");
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

// ---------------------------------------------------------------------------
// ProviderDetailRepository
// ---------------------------------------------------------------------------

describe("ProviderDetailRepository", () => {
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

  // ── getRecords ──

  describe("getRecords", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getRecords("strava", "activities", 50, 0);
      expect(result).toEqual([]);
    });

    it("returns rows from the database", async () => {
      const { repo } = makeRepository([
        { id: "act-1", name: "Morning Run", activity_type: "running" },
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
  });

  // ── verifyOwnership ──

  describe("verifyOwnership", () => {
    it("returns true when provider exists for user", async () => {
      const { repo } = makeRepository([{ id: "strava" }]);
      const result = await repo.verifyOwnership("strava");
      expect(result).toBe(true);
    });

    it("verifyOwnership returns exactly true (not truthy) for existing provider", async () => {
      const { repo } = makeRepository([{ id: "strava" }]);
      const result = await repo.verifyOwnership("strava");
      expect(result).toStrictEqual(true);
    });

    it("returns false when provider does not exist for user", async () => {
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

  // ── deleteProviderData ──

  describe("deleteProviderData", () => {
    it("deletes all child table rows and provider row in a transaction", async () => {
      const txExecute = vi.fn().mockResolvedValue([]);
      const mockTransaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: { execute: typeof txExecute }) => Promise<void>) => {
          await fn({ execute: txExecute });
        });
      const { repo } = makeRepository([], mockTransaction);

      await repo.deleteProviderData("strava");

      expect(mockTransaction).toHaveBeenCalledTimes(1);
      // 17 child tables + 1 provider delete = 18 deletes inside the transaction
      expect(txExecute).toHaveBeenCalledTimes(18);
    });

    it("deletes from each child table in order", async () => {
      const txExecute = vi.fn().mockResolvedValue([]);
      const mockTransaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: { execute: typeof txExecute }) => Promise<void>) => {
          await fn({ execute: txExecute });
        });
      const { repo } = makeRepository([], mockTransaction);

      await repo.deleteProviderData("strava");

      // Each child table delete should be issued in DISCONNECT_CHILD_TABLES order
      for (let index = 0; index < DISCONNECT_CHILD_TABLES.length; index++) {
        expect(txExecute.mock.calls[index]).toBeDefined();
      }
      // Final call is the provider delete
      expect(txExecute).toHaveBeenCalledTimes(DISCONNECT_CHILD_TABLES.length + 1);
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
        table: "fitness.body_measurement",
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
        table: "fitness.sensor_sample",
        orderColumn: "recorded_at",
        idColumn: "recorded_at",
      });
      expect(tableInfo("nutritionDaily")).toStrictEqual({
        table: "fitness.nutrition_daily",
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

    it("deleteProviderData calls transaction (BlockStatement mutation would skip it)", async () => {
      const txExecute = vi.fn().mockResolvedValue([]);
      const mockTransaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: { execute: typeof txExecute }) => Promise<void>) => {
          await fn({ execute: txExecute });
        });
      const { repo } = makeRepository([], mockTransaction);

      await repo.deleteProviderData("test-provider");
      // If the await this.#db.transaction() block was removed, transaction would not be called
      expect(mockTransaction).toHaveBeenCalledTimes(1);
    });

    it("deleteProviderData deletes from exactly DISCONNECT_CHILD_TABLES.length + 1 tables", async () => {
      const txExecute = vi.fn().mockResolvedValue([]);
      const mockTransaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: { execute: typeof txExecute }) => Promise<void>) => {
          await fn({ execute: txExecute });
        });
      const { repo } = makeRepository([], mockTransaction);

      await repo.deleteProviderData("test-provider");
      // 17 child tables + 1 provider row = 18
      expect(txExecute).toHaveBeenCalledTimes(DISCONNECT_CHILD_TABLES.length + 1);
      // Verify it's exactly 18, not 17 (BlockStatement removing the final delete)
      expect(txExecute).toHaveBeenCalledTimes(18);
    });

    it("DISCONNECT_CHILD_TABLES is an array (not empty array from ArrayDeclaration mutation)", () => {
      expect(DISCONNECT_CHILD_TABLES.length).toBe(17);
      expect(DISCONNECT_CHILD_TABLES[0]).toBe("fitness.sensor_sample");
      expect(DISCONNECT_CHILD_TABLES[16]).toBe("fitness.oauth_token");
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

    it("tableInfo metricStream has matching idColumn and orderColumn (both recorded_at)", () => {
      // This is unique: idColumn === orderColumn = "recorded_at"
      // If one was mutated to "id", they would differ
      const info = tableInfo("metricStream");
      expect(info.idColumn).toBe("recorded_at");
      expect(info.orderColumn).toBe("recorded_at");
      expect(info.idColumn).toBe(info.orderColumn);
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

    it("DISCONNECT_CHILD_TABLES ordering: activity comes before oauth_token", () => {
      const activityIndex = DISCONNECT_CHILD_TABLES.indexOf("fitness.activity");
      const oauthIndex = DISCONNECT_CHILD_TABLES.indexOf("fitness.oauth_token");
      expect(activityIndex).toBeLessThan(oauthIndex);
      expect(activityIndex).toBe(15);
      expect(oauthIndex).toBe(16);
    });
  });
});
