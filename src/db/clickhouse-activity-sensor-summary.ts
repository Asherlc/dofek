export function buildActivitySensorSummaryRowsTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS analytics.activity_sensor_summary_rows (
  activity_id UUID,
  user_id UUID,
  avg_hr Nullable(Float64),
  max_hr Nullable(Int16),
  min_hr Nullable(Int16),
  avg_power Nullable(Float64),
  max_power Nullable(Int16),
  avg_speed Nullable(Float64),
  max_speed Nullable(Float64),
  avg_cadence Nullable(Float64),
  elevation_gain_legacy Nullable(Float64),
  avg_left_balance Nullable(Float64),
  avg_left_torque_eff Nullable(Float64),
  avg_right_torque_eff Nullable(Float64),
  avg_left_pedal_smooth Nullable(Float64),
  avg_right_pedal_smooth Nullable(Float64),
  elevation_gain_m Nullable(Float64),
  elevation_loss_m Nullable(Float64),
  avg_stance_time Nullable(Float64),
  avg_vertical_osc Nullable(Float64),
  avg_ground_contact_time Nullable(Float64),
  avg_stride_length Nullable(Float64),
  sample_count Nullable(UInt64),
  hr_sample_count Nullable(UInt64),
  power_sample_count Nullable(UInt64),
  first_sample_at Nullable(DateTime64(6, 'UTC')),
  last_sample_at Nullable(DateTime64(6, 'UTC')),
  best_twenty_minute_power Nullable(Float64),
  normalized_power Nullable(Float64),
  smoothed_avg_power Nullable(Float64),
  climbing_elevation_gain_m Nullable(Float64),
  climbing_seconds Nullable(Int32),
  refresh_version UInt64,
  is_deleted UInt8,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, activity_id)`;
}

export function extractClickHouseTableColumnNames(createTableSql: string): string[] {
  const bodyMatch = createTableSql.match(/\(\s*([\s\S]+?)\s*\)\s*ENGINE/im);
  if (!bodyMatch?.[1]) {
    throw new Error("Could not parse ClickHouse CREATE TABLE column list");
  }

  const columnNames: string[] = [];
  for (const line of bodyMatch[1].split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("--")) {
      continue;
    }

    const name = trimmed.replace(/,$/, "").split(/\s+/)[0];
    if (name) {
      columnNames.push(name);
    }
  }

  return columnNames;
}

export function extractDbtFinalSelectColumnNames(modelSql: string, fromTable: string): string[] {
  const selectBody = findSelectBodyForFromTable(modelSql, fromTable);
  if (!selectBody) {
    throw new Error(`Could not parse dbt final SELECT for FROM ${fromTable}`);
  }

  const columns: string[] = [];
  for (const line of selectBody.split("\n")) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }

    const aliasMatch = trimmedLine.match(/\s+AS\s+([a-z_][a-z0-9_]*)\s*,?\s*$/i);
    if (aliasMatch?.[1]) {
      columns.push(aliasMatch[1]);
    }
  }

  if (columns.length === 0) {
    throw new Error(`Could not parse dbt SELECT column aliases for FROM ${fromTable}`);
  }

  return columns;
}

function findSelectBodyForFromTable(modelSql: string, fromTable: string): string | undefined {
  const fromTablePattern = /^[a-z_][a-z0-9_]*$/;
  if (!fromTablePattern.test(fromTable)) {
    throw new Error(`Invalid dbt FROM table name: ${fromTable}`);
  }

  const fromMatches = modelSql.matchAll(/\bFROM\s+([a-z_][a-z0-9_]*)\b/gi);
  let selectBody: string | undefined;
  for (const fromMatch of fromMatches) {
    if (fromMatch[1] !== fromTable || fromMatch.index === undefined) {
      continue;
    }

    const beforeFrom = modelSql.slice(0, fromMatch.index);
    const selectIndex = beforeFrom.toUpperCase().lastIndexOf("SELECT");
    if (selectIndex === -1) {
      continue;
    }
    selectBody = modelSql.slice(selectIndex + "SELECT".length, fromMatch.index);
  }

  return selectBody;
}
