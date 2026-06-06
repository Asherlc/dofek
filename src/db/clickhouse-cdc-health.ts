import { z } from "zod";

export interface PostgresQueryClient {
  query(queryText: string): Promise<unknown>;
}

export interface CdcHealthClickHouseClient {
  query(options: { query: string; format: "JSONEachRow" }): Promise<{ json(): Promise<unknown> }>;
}

export interface CdcHealthIssue {
  severity: "warning" | "failure";
  message: string;
}

export interface CdcHealthReport {
  issues: CdcHealthIssue[];
  slotCount: number;
  mirrorCount: number;
}

export interface CdcHealthThresholds {
  retainedWalWarningBytes: number;
  retainedWalFailureBytes: number;
}

interface MirrorFreshnessCheck {
  tableName: string;
  maxAgeMilliseconds: number;
}

interface CheckClickHouseCdcHealthOptions {
  postgresClient: PostgresQueryClient;
  clickHouseClient: CdcHealthClickHouseClient;
  now?: Date;
  thresholds?: Partial<CdcHealthThresholds>;
  mirrorFreshnessChecks?: readonly MirrorFreshnessCheck[];
}

const expectedSlotNames = [
  "peerflow_slot_dofek_fitness_raw_analytics",
  "peerflow_slot_dofek_metric_stream_analytics",
  "peerflow_slot_dofek_provider_inventory_raw_analytics",
  "peerflow_slot_dofek_sensor_priority_raw_analytics",
] as const;

const defaultThresholds: CdcHealthThresholds = {
  retainedWalWarningBytes: 32 * 1024 * 1024 * 1024,
  retainedWalFailureBytes: 48 * 1024 * 1024 * 1024,
};

const defaultMirrorFreshnessChecks: readonly MirrorFreshnessCheck[] = [
  { tableName: "metric_stream", maxAgeMilliseconds: 2 * 60 * 60 * 1000 },
  { tableName: "sleep_session", maxAgeMilliseconds: 36 * 60 * 60 * 1000 },
];

const numericStringSchema = z.string().regex(/^\d+$/);
const nullableIntegerLikeSchema = z.union([
  z.number().int().nonnegative(),
  numericStringSchema,
  z.null(),
]);
const integerLikeSchema = z.union([z.number().int().nonnegative(), numericStringSchema]);

const postgresReplicationSlotRowsSchema = z.object({
  rows: z.array(
    z.object({
      active: z.boolean(),
      restart_lsn: z.string().nullable(),
      retained_wal_bytes: nullableIntegerLikeSchema,
      slot_name: z.enum(expectedSlotNames),
      wal_status: z.string().nullable(),
    }),
  ),
});

const clickHouseFreshnessRowsSchema = z.array(
  z.object({
    latest_peerdb_synced_at: z.string().nullable(),
    row_count: integerLikeSchema,
    table_name: z.string(),
  }),
);

function integerLikeToNumber(value: z.infer<typeof integerLikeSchema>): number {
  return typeof value === "number" ? value : Number.parseInt(value, 10);
}

function nullableIntegerLikeToNumber(
  value: z.infer<typeof nullableIntegerLikeSchema>,
): number | null {
  if (value === null) {
    return null;
  }
  return integerLikeToNumber(value);
}

function parseClickHouseDateTime(value: string): Date | null {
  const match = value.match(
    /^(?<date>\d{4}-\d{2}-\d{2}) (?<time>\d{2}:\d{2}:\d{2})(?:\.(?<fraction>\d+))?$/,
  );
  if (!match?.groups) {
    return null;
  }

  const fraction = match.groups.fraction ?? "";
  const milliseconds = fraction.padEnd(3, "0").slice(0, 3);
  const parsedDate = new Date(`${match.groups.date}T${match.groups.time}.${milliseconds}Z`);
  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
}

function assertSafeClickHouseTableName(tableName: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(tableName)) {
    throw new Error(`Unsafe ClickHouse table name: ${tableName}`);
  }
}

function buildFreshnessQuery(mirrorFreshnessChecks: readonly MirrorFreshnessCheck[]): string {
  const tableQueries = mirrorFreshnessChecks.map((check) => {
    assertSafeClickHouseTableName(check.tableName);
    return [
      `SELECT '${check.tableName}' AS table_name,`,
      "count() AS row_count,",
      "max(_peerdb_synced_at) AS latest_peerdb_synced_at",
      `FROM postgres_fitness.${check.tableName}`,
      "WHERE _peerdb_is_deleted = 0",
    ].join(" ");
  });

  return tableQueries.join(" UNION ALL ");
}

function addSlotIssues(
  issues: CdcHealthIssue[],
  slotRows: z.infer<typeof postgresReplicationSlotRowsSchema>["rows"],
  thresholds: CdcHealthThresholds,
): void {
  const slotRowsByName = new Map(slotRows.map((slotRow) => [slotRow.slot_name, slotRow]));

  for (const expectedSlotName of expectedSlotNames) {
    const slotRow = slotRowsByName.get(expectedSlotName);
    if (!slotRow) {
      issues.push({
        severity: "failure",
        message: `Missing required PeerDB replication slot ${expectedSlotName}`,
      });
      continue;
    }

    if (slotRow.wal_status === "lost" || slotRow.restart_lsn === null) {
      issues.push({
        severity: "failure",
        message: `PeerDB replication slot ${expectedSlotName} is lost`,
      });
      continue;
    }

    if (!slotRow.active) {
      issues.push({
        severity: "failure",
        message: `PeerDB replication slot ${expectedSlotName} is inactive`,
      });
    }

    const retainedWalBytes = nullableIntegerLikeToNumber(slotRow.retained_wal_bytes);
    if (retainedWalBytes === null) {
      issues.push({
        severity: "warning",
        message: `PeerDB replication slot ${expectedSlotName} has unknown retained WAL bytes`,
      });
      continue;
    }

    if (retainedWalBytes >= thresholds.retainedWalFailureBytes) {
      issues.push({
        severity: "failure",
        message:
          `PeerDB replication slot ${expectedSlotName} retains ${retainedWalBytes} WAL bytes, ` +
          `above failure threshold ${thresholds.retainedWalFailureBytes}`,
      });
    } else if (retainedWalBytes >= thresholds.retainedWalWarningBytes) {
      issues.push({
        severity: "warning",
        message:
          `PeerDB replication slot ${expectedSlotName} retains ${retainedWalBytes} WAL bytes, ` +
          `above warning threshold ${thresholds.retainedWalWarningBytes}`,
      });
    }
  }
}

function addMirrorFreshnessIssues(
  issues: CdcHealthIssue[],
  freshnessRows: z.infer<typeof clickHouseFreshnessRowsSchema>,
  mirrorFreshnessChecks: readonly MirrorFreshnessCheck[],
  now: Date,
): void {
  const checksByTableName = new Map(
    mirrorFreshnessChecks.map((freshnessCheck) => [freshnessCheck.tableName, freshnessCheck]),
  );

  for (const freshnessRow of freshnessRows) {
    const freshnessCheck = checksByTableName.get(freshnessRow.table_name);
    if (!freshnessCheck) {
      continue;
    }

    const rowCount = integerLikeToNumber(freshnessRow.row_count);
    if (rowCount === 0 || freshnessRow.latest_peerdb_synced_at === null) {
      issues.push({
        severity: "warning",
        message: `ClickHouse mirror postgres_fitness.${freshnessRow.table_name} has no synced rows`,
      });
      continue;
    }

    const latestSyncedAt = parseClickHouseDateTime(freshnessRow.latest_peerdb_synced_at);
    if (!latestSyncedAt) {
      issues.push({
        severity: "failure",
        message:
          `ClickHouse mirror postgres_fitness.${freshnessRow.table_name} returned an ` +
          `unparseable _peerdb_synced_at value: ${freshnessRow.latest_peerdb_synced_at}`,
      });
      continue;
    }

    const ageMilliseconds = now.getTime() - latestSyncedAt.getTime();
    if (ageMilliseconds > freshnessCheck.maxAgeMilliseconds) {
      issues.push({
        severity: "failure",
        message:
          `ClickHouse mirror postgres_fitness.${freshnessRow.table_name} last synced at ` +
          `${freshnessRow.latest_peerdb_synced_at}, older than ` +
          `${Math.round(freshnessCheck.maxAgeMilliseconds / 60_000)} minutes`,
      });
    }
  }
}

export async function checkClickHouseCdcHealth(
  options: CheckClickHouseCdcHealthOptions,
): Promise<CdcHealthReport> {
  const thresholds = { ...defaultThresholds, ...options.thresholds };
  const mirrorFreshnessChecks = options.mirrorFreshnessChecks ?? defaultMirrorFreshnessChecks;
  const now = options.now ?? new Date();

  const slotQueryResult = await options.postgresClient.query(`
    SELECT
      slot_name,
      active,
      wal_status,
      restart_lsn::text AS restart_lsn,
      CASE
        WHEN restart_lsn IS NULL THEN NULL
        ELSE pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)
      END AS retained_wal_bytes
    FROM pg_replication_slots
    WHERE slot_name = ANY (ARRAY[${expectedSlotNames.map((slotName) => `'${slotName}'`).join(", ")}])
    ORDER BY slot_name
  `);
  const parsedSlotRows = postgresReplicationSlotRowsSchema.parse(slotQueryResult).rows;

  const freshnessQueryResult = await options.clickHouseClient.query({
    query: buildFreshnessQuery(mirrorFreshnessChecks),
    format: "JSONEachRow",
  });
  const freshnessRows = clickHouseFreshnessRowsSchema.parse(await freshnessQueryResult.json());

  const issues: CdcHealthIssue[] = [];
  addSlotIssues(issues, parsedSlotRows, thresholds);
  addMirrorFreshnessIssues(issues, freshnessRows, mirrorFreshnessChecks, now);

  return {
    issues,
    slotCount: parsedSlotRows.length,
    mirrorCount: freshnessRows.length,
  };
}

export function assertClickHouseCdcHealth(report: CdcHealthReport): void {
  const failures = report.issues.filter((issue) => issue.severity === "failure");
  if (failures.length === 0) {
    return;
  }

  throw new Error(
    `ClickHouse CDC health check failed:\n${failures
      .map((failure) => `- ${failure.message}`)
      .join("\n")}`,
  );
}
