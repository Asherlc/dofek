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

    if (/^(FROM|JOIN|WHERE|ORDER|GROUP|LIMIT|HAVING|WINDOW)\b/i.test(trimmedLine)) {
      break;
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

  const normalizedFromTable = fromTable.toLowerCase();
  let selectBody: string | undefined;
  let cursorIndex = 0;
  let depth = 0;
  let lastSelectStart: number | undefined;

  while (cursorIndex < modelSql.length) {
    const currentChar = modelSql[cursorIndex];
    const nextChar = modelSql[cursorIndex + 1];

    if (currentChar === "-" && nextChar === "-") {
      cursorIndex = skipSqlLineComment(modelSql, cursorIndex);
      continue;
    }
    if (currentChar === "/" && nextChar === "*") {
      cursorIndex = skipSqlBlockComment(modelSql, cursorIndex);
      continue;
    }
    if (currentChar === "'") {
      cursorIndex = skipSqlStringLiteral(modelSql, cursorIndex);
      continue;
    }

    if (currentChar === "(") {
      depth += 1;
      cursorIndex += 1;
      continue;
    }
    if (currentChar === ")") {
      depth = Math.max(0, depth - 1);
      cursorIndex += 1;
      continue;
    }

    if (depth > 0) {
      cursorIndex += 1;
      continue;
    }

    const selectEnd = matchSqlKeyword(modelSql, "SELECT", cursorIndex);
    if (selectEnd !== null) {
      lastSelectStart = cursorIndex;
      cursorIndex = selectEnd;
      continue;
    }

    const fromEnd =
      matchSqlKeyword(modelSql, "FROM", cursorIndex) ??
      matchSqlKeyword(modelSql, "JOIN", cursorIndex);
    if (fromEnd !== null) {
      const tableStart = skipWhitespace(modelSql, fromEnd);
      const tableEnd = readSqlIdentifierEndIndex(modelSql, tableStart);
      const tableName = modelSql.slice(tableStart, tableEnd).toLowerCase();
      if (tableName === normalizedFromTable && lastSelectStart !== undefined) {
        selectBody = modelSql.slice(lastSelectStart + "SELECT".length, cursorIndex);
      }
      cursorIndex = tableEnd;
      continue;
    }

    cursorIndex += 1;
  }

  return selectBody;
}

function skipSqlLineComment(sql: string, startIndex: number): number {
  let cursorIndex = startIndex + 2;
  while (cursorIndex < sql.length && sql[cursorIndex] !== "\n") {
    cursorIndex += 1;
  }
  return cursorIndex;
}

function skipSqlBlockComment(sql: string, startIndex: number): number {
  let cursorIndex = startIndex + 2;
  while (cursorIndex < sql.length - 1) {
    if (sql[cursorIndex] === "*" && sql[cursorIndex + 1] === "/") {
      return cursorIndex + 2;
    }
    cursorIndex += 1;
  }
  return sql.length;
}

function skipSqlStringLiteral(sql: string, startIndex: number): number {
  let cursorIndex = startIndex + 1;
  while (cursorIndex < sql.length) {
    if (sql[cursorIndex] === "'" && sql[cursorIndex + 1] === "'") {
      cursorIndex += 2;
      continue;
    }
    if (sql[cursorIndex] === "'") {
      return cursorIndex + 1;
    }
    cursorIndex += 1;
  }
  return sql.length;
}

function skipWhitespace(sql: string, startIndex: number): number {
  let cursorIndex = startIndex;
  while (cursorIndex < sql.length && /\s/.test(sql[cursorIndex] ?? "")) {
    cursorIndex += 1;
  }
  return cursorIndex;
}

function isSqlIdentifierChar(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_]/.test(value);
}

function readSqlIdentifierEndIndex(sql: string, startIndex: number): number {
  let cursorIndex = startIndex;
  while (isSqlIdentifierChar(sql[cursorIndex])) {
    cursorIndex += 1;
  }
  return cursorIndex;
}

function matchSqlKeyword(sql: string, keyword: string, startIndex: number): number | null {
  if (isSqlIdentifierChar(sql[startIndex - 1])) {
    return null;
  }
  const endIndex = startIndex + keyword.length;
  if (sql.slice(startIndex, endIndex).toLowerCase() !== keyword.toLowerCase()) {
    return null;
  }
  return isSqlIdentifierChar(sql[endIndex]) ? null : endIndex;
}
