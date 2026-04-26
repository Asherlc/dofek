import { escapeIdentifier } from "pg";
import { VIEW_SYNC_LOCK_KEY } from "./sync-views.ts";

export type MaterializedViewRefreshRisk = "low" | "medium" | "high";

export interface MaterializedViewRefreshInventoryItem {
  viewName: string;
  concurrentRefreshIndex: string;
  refreshRisk: MaterializedViewRefreshRisk;
  notes: string;
}

export interface QueryResult {
  rows: unknown[];
}

export interface MaterializedViewMaintenanceClient {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
}

export interface QuietDatabasePreflightResult {
  ok: boolean;
  failures: string[];
  warnings: string[];
  activeMaintenanceQueryCount: number;
  lockWaitCount: number;
}

export interface QuietDatabasePreflightOptions {
  maxActiveMaintenanceAgeSeconds?: number;
}

export interface MaterializedViewMaintenanceRefreshResult {
  viewName: string;
  mode: "concurrent";
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  warnings: string[];
}

export const MATERIALIZED_VIEW_REFRESH_INVENTORY: MaterializedViewRefreshInventoryItem[] = [
  {
    viewName: "fitness.v_activity",
    concurrentRefreshIndex: "v_activity_id_idx",
    refreshRisk: "medium",
    notes: "Activity de-duplication view; recursive overlap logic can be CPU-heavy.",
  },
  {
    viewName: "fitness.v_sleep",
    concurrentRefreshIndex: "v_sleep_id_idx",
    refreshRisk: "medium",
    notes: "Sleep de-duplication view; recursive overlap logic can be CPU-heavy.",
  },
  {
    viewName: "fitness.v_body_measurement",
    concurrentRefreshIndex: "v_body_measurement_id_idx",
    refreshRisk: "low",
    notes: "Body measurement de-duplication view; small relative to sensor data.",
  },
  {
    viewName: "fitness.v_daily_metrics",
    concurrentRefreshIndex: "v_daily_metrics_date_idx",
    refreshRisk: "medium",
    notes: "Daily metric priority view; used by dashboards and stale-view refresh paths.",
  },
  {
    viewName: "fitness.deduped_sensor",
    concurrentRefreshIndex: "deduped_sensor_pk",
    refreshRisk: "high",
    notes: "Scans metric stream data and joins activity data; reader-safe but resource-heavy.",
  },
  {
    viewName: "fitness.activity_summary",
    concurrentRefreshIndex: "activity_summary_pk",
    refreshRisk: "high",
    notes: "Depends on deduped sensor data and windowed activity calculations.",
  },
  {
    viewName: "fitness.provider_stats",
    concurrentRefreshIndex: "provider_stats_user_provider_idx",
    refreshRisk: "high",
    notes: "Aggregates across many tables including metric stream data.",
  },
];

function formatCount(count: number, singular: string, plural: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`;
}

function quoteQualifiedIdentifier(name: string): string {
  return name
    .split(".")
    .map((part) => escapeIdentifier(part))
    .join(".");
}

function findInventoryItem(viewName: string): MaterializedViewRefreshInventoryItem | undefined {
  return MATERIALIZED_VIEW_REFRESH_INVENTORY.find((item) => item.viewName === viewName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function booleanField(row: unknown, fieldName: string): boolean | undefined {
  if (!isRecord(row)) {
    return undefined;
  }
  const value = row[fieldName];
  return typeof value === "boolean" ? value : undefined;
}

export async function runQuietDatabasePreflight(
  client: MaterializedViewMaintenanceClient,
  options: QuietDatabasePreflightOptions = {},
): Promise<QuietDatabasePreflightResult> {
  const maxActiveMaintenanceAgeSeconds = options.maxActiveMaintenanceAgeSeconds ?? 300;
  const failures: string[] = [];
  const warnings: string[] = [];

  const recoveryState = await client.query("SELECT pg_is_in_recovery() AS in_recovery");
  if (booleanField(recoveryState.rows[0], "in_recovery") === true) {
    failures.push("database is in recovery");
  }

  const lockWaits = await client.query(`
    -- cspell:disable -- Postgres system catalog column names
    SELECT
      blocked.pid AS blocked_pid,
      now() - blocked.query_start AS blocked_age,
      left(blocked.query, 200) AS blocked_query,
      blocking.pid AS blocking_pid,
      now() - blocking.query_start AS blocking_age,
      left(blocking.query, 200) AS blocking_query
    FROM pg_stat_activity AS blocked
    JOIN pg_locks AS blocked_locks
      ON blocked_locks.pid = blocked.pid
     AND NOT blocked_locks.granted
    JOIN pg_locks AS blocking_locks
      ON blocking_locks.locktype = blocked_locks.locktype
     AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
     AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
     AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
     AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
     AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
     AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
     AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
     AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
     AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
     AND blocking_locks.pid <> blocked_locks.pid
     AND blocking_locks.granted
    JOIN pg_stat_activity AS blocking
      ON blocking.pid = blocking_locks.pid
    ORDER BY blocked.query_start NULLS LAST
    -- cspell:enable
  `);
  if (lockWaits.rows.length > 0) {
    const lockWaitState = lockWaits.rows.length === 1 ? "is" : "are";
    failures.push(
      `${formatCount(lockWaits.rows.length, "lock wait", "lock waits")} ${lockWaitState} active`,
    );
  }

  const activeMaintenanceQueries = await client.query(
    `
      SELECT
        active.pid AS risky_active_query_pid,
        active.pid,
        now() - active.query_start AS age,
        active.wait_event_type,
        active.wait_event,
        active.state,
        left(active.query, 220) AS query
      FROM pg_stat_activity AS active
      WHERE active.datname = current_database() -- cspell:disable-line -- Postgres system catalog column name
        AND active.pid <> pg_backend_pid()
        AND active.state <> 'idle'
        AND active.query_start IS NOT NULL
        AND now() - active.query_start > make_interval(secs => $1)
        AND (
          active.query ILIKE '%REFRESH MATERIALIZED VIEW%'
          OR active.query ILIKE '%compress_chunk%'
          OR active.query ILIKE '%decompress_chunk%'
          OR active.query ILIKE '%refresh_continuous_aggregate%'
          OR active.query ILIKE '%metric_stream%'
        )
      ORDER BY active.query_start NULLS LAST
    `,
    [maxActiveMaintenanceAgeSeconds],
  );
  if (activeMaintenanceQueries.rows.length > 0) {
    const queryState = activeMaintenanceQueries.rows.length === 1 ? "is" : "are";
    warnings.push(
      `${formatCount(
        activeMaintenanceQueries.rows.length,
        "long-running maintenance-like query",
        "long-running maintenance-like queries",
      )} ${queryState} active`,
    );
  }

  return {
    activeMaintenanceQueryCount: activeMaintenanceQueries.rows.length,
    failures,
    lockWaitCount: lockWaits.rows.length,
    ok: failures.length === 0,
    warnings,
  };
}

export async function refreshMaterializedViewForMaintenance(
  client: MaterializedViewMaintenanceClient,
  viewName: string,
): Promise<MaterializedViewMaintenanceRefreshResult> {
  if (!findInventoryItem(viewName)) {
    throw new Error(`${viewName} is not in the canonical materialized view inventory`);
  }

  const lockResult = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [
    VIEW_SYNC_LOCK_KEY,
  ]);
  if (booleanField(lockResult.rows[0], "locked") !== true) {
    throw new Error("materialized view maintenance lock is already held");
  }

  try {
    await client.query("SET application_name = 'dofek-materialized-view-maintenance'");
    await client.query("SET lock_timeout = '5s'");
    await client.query("SET statement_timeout = '45min'");

    const preflight = await runQuietDatabasePreflight(client);
    if (!preflight.ok) {
      throw new Error(`quiet database preflight failed: ${preflight.failures.join("; ")}`);
    }

    const startedAt = new Date();
    const startedAtMs = performance.now();
    await client.query(
      `REFRESH MATERIALIZED VIEW CONCURRENTLY ${quoteQualifiedIdentifier(viewName)}`,
    );
    const finishedAt = new Date();

    return {
      durationMs: Math.round(performance.now() - startedAtMs),
      finishedAt,
      mode: "concurrent",
      startedAt,
      viewName,
      warnings: preflight.warnings,
    };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [VIEW_SYNC_LOCK_KEY]);
  }
}
