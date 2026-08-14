import { createClient } from "@clickhouse/client";
import { createTaggedQueryClient } from "../src/db/tagged-query-client.ts";

const pgUrl = process.env.DATABASE_URL;
if (!pgUrl) throw new Error("DATABASE_URL required");

const chUrl = process.env.CLICKHOUSE_URL;
if (!chUrl) throw new Error("CLICKHOUSE_URL required");

const ch = createClient({
  url: chUrl,
  clickhouse_settings: { allow_experimental_nullable_tuple_type: 1 },
});
const pg = createTaggedQueryClient(pgUrl);

interface CHTableInfo {
  columns: string[];
  orderBy: string;
  dateCols?: string[];
  tsCols?: string[];
}

function fmt(v: unknown, info: CHTableInfo, col: string): unknown {
  if (v == null) return null;
  if (v instanceof Date) {
    if (info.dateCols?.includes(col)) {
      return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
    }
    if (info.tsCols?.includes(col)) {
      return v.toISOString().replace("T", " ").replace("Z", "");
    }
  }
  if (typeof v === "string") return v;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return String(v);
}

async function backfill(table: string, info: CHTableInfo) {
  const { columns, orderBy } = info;
  const pgRows = await pg.unsafe<Record<string, unknown>[]>(
    `SELECT ${columns.join(", ")} FROM fitness.${table} ORDER BY ${orderBy}`,
  );
  if (pgRows.length === 0) {
    console.log(`  ${table}: 0 rows`);
    return;
  }
  const vals = pgRows.map((row) => {
    const r: Record<string, unknown> = { _peerdb_is_deleted: 0, _peerdb_version: 1 };
    for (const c of columns) r[c] = fmt(row[c], info, c);
    return r;
  });
  await ch.insert({
    table: `postgres_fitness.${table}`,
    values: vals,
    format: "JSONEachRow",
  });
  console.log(`  ${table}: ${pgRows.length} rows`);
}

async function main() {
  console.log("Backfilling ClickHouse postgres_fitness.* from Postgres...\n");

  const tables: Record<string, CHTableInfo> = {
    provider: {
      columns: ["id", "name", "api_base_url", "user_id", "created_at"],
      orderBy: "user_id, id",
      tsCols: ["created_at"],
    },
    provider_priority: {
      columns: [
        "provider_id",
        "priority",
        "sleep_priority",
        "body_priority",
        "recovery_priority",
        "daily_activity_priority",
      ],
      orderBy: "provider_id",
    },
    device_priority: {
      columns: [
        "provider_id",
        "source_name_pattern",
        "priority",
        "sleep_priority",
        "body_priority",
        "recovery_priority",
        "daily_activity_priority",
      ],
      orderBy: "provider_id, source_name_pattern",
    },
    daily_metrics: {
      columns: [
        "id",
        "date",
        "provider_id",
        "user_id",
        "hrv",
        "spo2_avg",
        "respiratory_rate_avg",
        "steps",
        "distance_km",
        "flights_climbed",
        "exercise_minutes",
        "walking_speed",
        "walking_step_length",
        "walking_double_support_pct",
        "walking_asymmetry_pct",
        "walking_steadiness",
        "stand_hours",
        "skin_temp_c",
        "stress_high_minutes",
        "recovery_high_minutes",
        "resilience_level",
        "push_count",
        "wheelchair_distance_km",
        "uv_exposure",
        "source_name",
        "created_at",
      ],
      orderBy: "user_id, date, provider_id, id",
      dateCols: ["date"],
      tsCols: ["created_at"],
    },
    sleep_session: {
      columns: [
        "id",
        "provider_id",
        "user_id",
        "external_id",
        "started_at",
        "ended_at",
        "duration_minutes",
        "deep_minutes",
        "rem_minutes",
        "light_minutes",
        "awake_minutes",
        "efficiency_pct",
        "staging_available",
        "sleep_type",
        "sleep_need_baseline_minutes",
        "sleep_need_from_debt_minutes",
        "sleep_need_from_strain_minutes",
        "sleep_need_from_nap_minutes",
        "source_name",
        "created_at",
      ],
      orderBy: "user_id, started_at, id",
      tsCols: ["started_at", "ended_at", "created_at"],
    },
    sleep_stage: {
      columns: ["session_id", "stage", "started_at", "ended_at", "source_name"],
      orderBy: "session_id, started_at",
      tsCols: ["started_at", "ended_at"],
    },
    activity: {
      columns: [
        "id",
        "provider_id",
        "user_id",
        "external_id",
        "canonical_type",
        "started_at",
        "ended_at",
        "name",
        "notes",
        "perceived_exertion",
        "source_name",
        "timezone",
        "strava_id",
        "raw",
        "provider_absent_at",
        "deleted_at",
        "created_at",
      ],
      orderBy: "id",
      tsCols: ["started_at", "ended_at", "provider_absent_at", "deleted_at", "created_at"],
    },
  };

  for (const [table, info] of Object.entries(tables)) {
    try {
      await backfill(table, info);
    } catch (err) {
      console.error(`  ${table}: FAILED`, err);
    }
  }

  console.log("\nBackfill complete. Run analytics:build to populate read models.");
  await ch.close();
  await pg.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
