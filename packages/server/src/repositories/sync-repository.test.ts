import { describe, expect, it, vi } from "vitest";
import { SyncRepository } from "./sync-repository.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepository(rows: Record<string, unknown>[] = []) {
  const execute = vi.fn().mockResolvedValue(rows);
  const select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  });
  const db = { execute, select } as unknown as Parameters<typeof SyncRepository extends new (db: infer D, ...rest: unknown[]) => unknown ? (db: D) => void : never>[0];
  const repo = new SyncRepository(db as never, "user-1");
  return { repo, execute, select };
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
      const { repo } = makeRepository([
        { provider_id: "wahoo" },
        { provider_id: "strava" },
      ]);
      const result = await repo.getConnectedProviderIds();
      expect(result).toEqual([
        { providerId: "wahoo" },
        { providerId: "strava" },
      ]);
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
      const { repo } = makeRepository([]);
      const result = await repo.getProviderStats();
      expect(result).toEqual([]);
    });

    it("maps rows to ProviderStatRow objects with numeric values", async () => {
      const { repo } = makeRepository([
        {
          provider_id: "wahoo",
          activities: "5",
          daily_metrics: "30",
          sleep_sessions: "0",
          body_measurements: "2",
          food_entries: "0",
          health_events: "1",
          metric_stream: "100",
          nutrition_daily: "0",
          lab_panels: "0",
          lab_results: "0",
          journal_entries: "3",
        },
      ]);
      const result = await repo.getProviderStats();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        providerId: "wahoo",
        activities: 5,
        dailyMetrics: 30,
        sleepSessions: 0,
        bodyMeasurements: 2,
        foodEntries: 0,
        healthEvents: 1,
        metricStream: 100,
        nutritionDaily: 0,
        labPanels: 0,
        labResults: 0,
        journalEntries: 3,
      });
    });

    it("handles multiple providers", async () => {
      const { repo } = makeRepository([
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
          metric_stream: "0",
          nutrition_daily: "0",
          lab_panels: "0",
          lab_results: "0",
          journal_entries: "0",
        },
      ]);
      const result = await repo.getProviderStats();
      expect(result).toHaveLength(2);
      expect(result[0]?.providerId).toBe("wahoo");
      expect(result[0]?.activities).toBe(5);
      expect(result[1]?.providerId).toBe("strava");
      expect(result[1]?.activities).toBe(10);
    });
  });
});
