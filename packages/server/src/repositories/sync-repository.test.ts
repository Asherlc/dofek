import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { SyncRepository } from "./sync-repository.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepository(
  rows: Record<string, unknown>[] = [],
  clickHouseStatsRows: Record<string, unknown>[] = [],
) {
  const execute = vi.fn().mockResolvedValue(rows);
  const query = vi.fn(<TSchema extends z.ZodType>(schema: TSchema) =>
    Promise.resolve(clickHouseStatsRows.map((row) => schema.parse(row))),
  );
  const select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  });
  const db: Pick<import("dofek/db").Database, "execute" | "select"> = { execute, select };
  const sensorStore = { query };
  const repo = new SyncRepository(db, "user-1", sensorStore);
  return { repo, execute, query, select };
}

// ---------------------------------------------------------------------------
// Repository tests
// ---------------------------------------------------------------------------

describe("SyncRepository", () => {
  describe("getConnectedProviderIds", () => {
    it("returns empty array when no tokens", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getConnectedProviderIds();
      expect(result).toEqual([]);
    });

    it("returns provider tokens", async () => {
      const { repo } = makeRepository([{ provider_id: "wahoo" }, { provider_id: "strava" }]);
      const result = await repo.getConnectedProviderIds();
      expect(result).toEqual([{ providerId: "wahoo" }, { providerId: "strava" }]);
    });

    it("calls db.execute once", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getConnectedProviderIds();
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("getLastSyncTimes", () => {
    it("returns empty array when no syncs", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getLastSyncTimes();
      expect(result).toEqual([]);
    });

    it("maps rows to LastSync objects", async () => {
      const { repo } = makeRepository([
        { provider_id: "wahoo", last_synced: "2024-01-15T10:00:00Z" },
        { provider_id: "strava", last_synced: "2024-01-14T08:00:00Z" },
      ]);
      const result = await repo.getLastSyncTimes();
      expect(result).toEqual([
        { providerId: "wahoo", lastSynced: "2024-01-15T10:00:00Z" },
        { providerId: "strava", lastSynced: "2024-01-14T08:00:00Z" },
      ]);
    });
  });

  describe("getLatestErrors", () => {
    it("returns empty array when no errors", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getLatestErrors();
      expect(result).toEqual([]);
    });

    it("maps rows to LatestError objects", async () => {
      const { repo } = makeRepository([
        { provider_id: "wahoo", error_message: "authorization failed" },
        { provider_id: "strava", error_message: null },
      ]);
      const result = await repo.getLatestErrors();
      expect(result).toEqual([
        { providerId: "wahoo", errorMessage: "authorization failed" },
        { providerId: "strava", errorMessage: null },
      ]);
    });
  });

  describe("getLogs", () => {
    it("returns sync log rows", async () => {
      const logRows = [
        {
          id: "log-1",
          userId: "user-1",
          providerId: "wahoo",
          status: "success",
          syncedAt: new Date("2024-01-15"),
          durationMs: 1234,
          recordCount: 10,
          dataType: "activities",
          errorMessage: null,
        },
      ];
      const { repo } = makeRepository(logRows);
      const result = await repo.getLogs(100);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(logRows[0]);
    });

    it("returns empty array when no logs", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getLogs(50);
      expect(result).toEqual([]);
    });
  });

  describe("getProviderStats", () => {
    it("returns empty array when no providers", async () => {
      const { repo, execute } = makeRepository([]);
      const result = await repo.getProviderStats();
      expect(result).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
    });

    it("maps rows to ProviderStatRow objects with numeric values", async () => {
      const { repo, execute } = makeRepository(
        [],
        [
          {
            provider_id: "wahoo",
            activities: "5",
            daily_metrics: "30",
            sleep_sessions: "0",
            body_measurements: "2",
            food_entries: "8",
            health_events: "1",
            metric_stream: "100",
            nutrition_daily: "6",
            lab_panels: "4",
            lab_results: "9",
            journal_entries: "3",
          },
        ],
      );
      const result = await repo.getProviderStats();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        providerId: "wahoo",
        activities: 5,
        dailyMetrics: 30,
        sleepSessions: 0,
        bodyMeasurements: 2,
        foodEntries: 8,
        healthEvents: 1,
        metricStream: 100,
        nutritionDaily: 6,
        labPanels: 4,
        labResults: 9,
        journalEntries: 3,
      });
      expect(execute).not.toHaveBeenCalled();
    });

    it("handles multiple providers", async () => {
      const { repo } = makeRepository(
        [],
        [
          {
            provider_id: "wahoo",
            activities: "5",
            daily_metrics: "0",
            sleep_sessions: "0",
            body_measurements: "0",
            food_entries: "0",
            health_events: "0",
            metric_stream: "0",
            nutrition_daily: "0",
            lab_panels: "0",
            lab_results: "0",
            journal_entries: "0",
          },
          {
            provider_id: "strava",
            activities: "10",
            daily_metrics: "0",
            sleep_sessions: "0",
            body_measurements: "0",
            food_entries: "0",
            health_events: "0",
            metric_stream: "42",
            nutrition_daily: "0",
            lab_panels: "0",
            lab_results: "0",
            journal_entries: "0",
          },
        ],
      );
      const result = await repo.getProviderStats();
      expect(result).toHaveLength(2);
      expect(result[0]?.providerId).toBe("wahoo");
      expect(result[0]?.activities).toBe(5);
      expect(result[0]?.metricStream).toBe(0);
      expect(result[1]?.providerId).toBe("strava");
      expect(result[1]?.activities).toBe(10);
      expect(result[1]?.metricStream).toBe(42);
    });

    it("reads all provider counts from ClickHouse instead of the Postgres stats query", async () => {
      const { repo, execute, query } = makeRepository(
        [],
        [
          {
            provider_id: "apple-health",
            activities: "1",
            daily_metrics: "2",
            sleep_sessions: "3",
            body_measurements: "4",
            food_entries: "5",
            health_events: "6",
            metric_stream: "7",
            nutrition_daily: "8",
            lab_panels: "9",
            lab_results: "10",
            journal_entries: "11",
          },
        ],
      );

      await repo.getProviderStats();

      expect(query).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("analytics.provider_stats"),
        { userId: "user-1" },
      );
      expect(execute).not.toHaveBeenCalled();
    });
  });
});
