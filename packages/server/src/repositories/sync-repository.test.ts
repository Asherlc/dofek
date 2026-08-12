import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { SyncRepository } from "./sync-repository.ts";
import { collectSqlText } from "./test-helpers.ts";

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
      const wahooUpdatedAt = new Date("2026-06-02T10:00:00Z");
      const stravaUpdatedAt = new Date("2026-06-02T11:00:00Z");
      const { repo } = makeRepository([
        { provider_id: "wahoo", updated_at: wahooUpdatedAt },
        { provider_id: "strava", updated_at: stravaUpdatedAt },
      ]);
      const result = await repo.getConnectedProviderIds();
      expect(result).toEqual([
        { providerId: "wahoo", updatedAt: wahooUpdatedAt },
        { providerId: "strava", updatedAt: stravaUpdatedAt },
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

  describe("getLastSuccessfulSyncTimes", () => {
    it("returns each provider's latest successful sync as LastSync objects", async () => {
      const { repo, execute } = makeRepository([
        { provider_id: "wahoo", last_synced: "2024-01-15T10:00:00Z" },
        { provider_id: "strava", last_synced: "2024-01-14T08:00:00Z" },
      ]);

      const result = await repo.getLastSuccessfulSyncTimes();

      expect(result).toEqual([
        { providerId: "wahoo", lastSynced: "2024-01-15T10:00:00Z" },
        { providerId: "strava", lastSynced: "2024-01-14T08:00:00Z" },
      ]);
      const rawSql = collectSqlText(execute.mock.calls[0]?.[0]);
      expect(rawSql).toContain("SELECT provider_id, MAX(synced_at) AS last_synced");
      expect(rawSql).toContain("WHERE user_id = ");
      expect(rawSql).toContain("AND status = 'success'");
      expect(rawSql).toContain("GROUP BY provider_id");
    });
  });

  describe("getLatestErrors", () => {
    it("returns empty array when no errors", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getLatestErrors();
      expect(result).toEqual([]);
    });

    it("maps rows to LatestError objects", async () => {
      const wahooSyncedAt = new Date("2026-06-02T10:00:00Z");
      const stravaSyncedAt = new Date("2026-06-02T11:00:00Z");
      const { repo } = makeRepository([
        {
          provider_id: "wahoo",
          error_message: "authorization failed",
          auth_failure_reason: "authorization_failed",
          synced_at: wahooSyncedAt,
        },
        {
          provider_id: "strava",
          error_message: null,
          auth_failure_reason: null,
          synced_at: stravaSyncedAt,
        },
      ]);
      const result = await repo.getLatestErrors();
      expect(result).toEqual([
        {
          providerId: "wahoo",
          errorMessage: "authorization failed",
          authFailureReason: "authorization_failed",
          syncedAt: wahooSyncedAt,
        },
        {
          providerId: "strava",
          errorMessage: null,
          authFailureReason: null,
          syncedAt: stravaSyncedAt,
        },
      ]);
    });

    it("selects each provider's latest sync rows without a correlated max lookup", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getLatestErrors();

      const rawSql = collectSqlText(execute.mock.calls[0]?.[0]);
      expect(rawSql).toContain("WITH latest_sync_times AS");
      expect(rawSql).toContain("SELECT provider_id, MAX(synced_at) AS synced_at");
      expect(rawSql).toContain("GROUP BY provider_id");
      expect(rawSql).toContain("DISTINCT ON (sync_log.provider_id)");
      expect(rawSql).toContain("INNER JOIN latest_sync_times");
      expect(rawSql).toContain("ORDER BY sync_log.provider_id, (sync_log.status = 'error') DESC");
      expect(rawSql).toContain("WHERE latest_sync_log.status = 'error'");
      expect(rawSql).not.toContain("SELECT MAX(synced_at) FROM fitness.sync_log s2");
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
        totalRecords: 168,
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

    it("reads provider stats from the compact ClickHouse read model", async () => {
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

      expect(query).toHaveBeenCalledTimes(1);
      const querySql = query.mock.calls[0]?.[1];
      expect(query).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("FROM analytics.provider_stats FINAL"),
        { userId: "user-1" },
      );
      expect(querySql).toEqual(expect.stringContaining("user_id = {userId:UUID}"));
      expect(querySql).toEqual(expect.stringContaining("is_deleted = 0"));
      expect(querySql).not.toEqual(expect.stringContaining("postgres_fitness.metric_stream"));
      expect(execute).not.toHaveBeenCalled();
    });
  });
});
