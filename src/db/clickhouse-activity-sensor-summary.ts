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
  const bodyMatch = createTableSql.match(/\(([\s\S]+)\)\s*ENGINE/m);
  if (!bodyMatch?.[1]) {
    throw new Error("Could not parse ClickHouse CREATE TABLE column list");
  }

  const columnNames: string[] = [];
  for (const line of bodyMatch[1].split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
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
  const selectMatch = modelSql.match(new RegExp(`\\nSELECT\\n([\\s\\S]+?)\\nFROM ${fromTable}\\n`));
  if (!selectMatch?.[1]) {
    throw new Error(`Could not parse dbt final SELECT for FROM ${fromTable}`);
  }

  const columns: string[] = [];
  for (const line of selectMatch[1].split("\n")) {
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
