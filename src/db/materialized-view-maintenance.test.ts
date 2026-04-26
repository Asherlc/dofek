import { describe, expect, it, vi } from "vitest";
import {
  MATERIALIZED_VIEW_REFRESH_INVENTORY,
  refreshMaterializedViewForMaintenance,
  runQuietDatabasePreflight,
} from "./materialized-view-maintenance.ts";

function createClient(rowsByQuery: Map<string, unknown[]> = new Map()) {
  return {
    query: vi.fn((text: string) => {
      for (const [needle, rows] of rowsByQuery.entries()) {
        if (text.includes(needle)) {
          return Promise.resolve({ rows });
        }
      }
      return Promise.resolve({ rows: [] });
    }),
  };
}

function executedQueries(client: ReturnType<typeof createClient>): string[] {
  return client.query.mock.calls.map(([text]) => text);
}

describe("MATERIALIZED_VIEW_REFRESH_INVENTORY", () => {
  it("lists every canonical materialized view with its concurrent-refresh index", () => {
    expect(MATERIALIZED_VIEW_REFRESH_INVENTORY).toEqual([
      expect.objectContaining({
        concurrentRefreshIndex: "v_activity_id_idx",
        viewName: "fitness.v_activity",
      }),
      expect.objectContaining({
        concurrentRefreshIndex: "v_sleep_id_idx",
        viewName: "fitness.v_sleep",
      }),
      expect.objectContaining({
        concurrentRefreshIndex: "v_body_measurement_id_idx",
        viewName: "fitness.v_body_measurement",
      }),
      expect.objectContaining({
        concurrentRefreshIndex: "v_daily_metrics_date_idx",
        viewName: "fitness.v_daily_metrics",
      }),
      expect.objectContaining({
        concurrentRefreshIndex: "deduped_sensor_pk",
        viewName: "fitness.deduped_sensor",
      }),
      expect.objectContaining({
        concurrentRefreshIndex: "activity_summary_pk",
        viewName: "fitness.activity_summary",
      }),
      expect.objectContaining({
        concurrentRefreshIndex: "provider_stats_user_provider_idx",
        viewName: "fitness.provider_stats",
      }),
    ]);
  });
});

describe("runQuietDatabasePreflight", () => {
  it("fails when the database is in recovery", async () => {
    const client = createClient(new Map([["pg_is_in_recovery", [{ in_recovery: true }]]]));

    const result = await runQuietDatabasePreflight(client);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("database is in recovery");
  });

  it("fails when another session is waiting on a lock", async () => {
    const client = createClient(
      new Map([
        ["pg_is_in_recovery", [{ in_recovery: false }]],
        [
          "blocked_pid",
          [
            {
              blocked_age: "00:03:00",
              blocked_pid: 10,
              blocked_query: "REFRESH MATERIALIZED VIEW fitness.v_activity",
              blocking_age: "00:04:00",
              blocking_pid: 11,
              blocking_query: "SELECT * FROM fitness.activity",
            },
          ],
        ],
      ]),
    );

    const result = await runQuietDatabasePreflight(client);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("1 lock wait is active");
  });

  it("warns when long-running maintenance-like queries are active", async () => {
    const client = createClient(
      new Map([
        ["pg_is_in_recovery", [{ in_recovery: false }]],
        [
          "risky_active_query",
          [
            {
              age: "00:15:00",
              pid: 20,
              query: "SELECT count(*) FROM fitness.metric_stream",
              state: "active",
              wait_event: null,
              wait_event_type: null,
            },
          ],
        ],
      ]),
    );

    const result = await runQuietDatabasePreflight(client);

    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("1 long-running maintenance-like query is active");
  });
});

describe("refreshMaterializedViewForMaintenance", () => {
  it("refuses views outside the canonical inventory", async () => {
    const client = createClient();

    await expect(
      refreshMaterializedViewForMaintenance(client, "fitness.unknown_view"),
    ).rejects.toThrow("not in the canonical materialized view inventory");
  });

  it("acquires the view sync lock, refreshes concurrently, and unlocks", async () => {
    const client = createClient(
      new Map([
        ["pg_try_advisory_lock", [{ locked: true }]],
        ["pg_is_in_recovery", [{ in_recovery: false }]],
      ]),
    );

    await refreshMaterializedViewForMaintenance(client, "fitness.v_daily_metrics");

    expect(executedQueries(client)).toContain("SELECT pg_try_advisory_lock($1) AS locked");
    expect(executedQueries(client)).toContain(
      'REFRESH MATERIALIZED VIEW CONCURRENTLY "fitness"."v_daily_metrics"',
    );
    expect(executedQueries(client)).toContain("SELECT pg_advisory_unlock($1)");
  });
});
