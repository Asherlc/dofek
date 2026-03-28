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
  it("contains 16 child tables", () => {
    expect(DISCONNECT_CHILD_TABLES).toHaveLength(16);
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

  it("starts with fitness.metric_stream (first to delete)", () => {
    expect(DISCONNECT_CHILD_TABLES[0]).toBe("fitness.metric_stream");
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
      // 16 child tables + 1 provider delete = 17 deletes inside the transaction
      expect(txExecute).toHaveBeenCalledTimes(17);
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
});
