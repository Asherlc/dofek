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
  peerDbMirrorCount: number | null;
  evidence: CdcHealthEvidence;
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
  peerDbClient?: PostgresQueryClient;
  clickHouseClient: CdcHealthClickHouseClient;
  now?: Date;
  thresholds?: Partial<CdcHealthThresholds>;
  mirrorFreshnessChecks?: readonly MirrorFreshnessCheck[];
}

export const EXPECTED_PEERDB_REPLICATION_SLOT_NAMES = [
  "peerflow_slot_dofek_fitness_raw_analytics",
  "peerflow_slot_dofek_provider_inventory_raw_analytics",
  "peerflow_slot_dofek_sensor_priority_raw_analytics",
] as const;

const expectedPeerDbMirrorNames = [
  "dofek_fitness_raw_analytics",
  "dofek_provider_inventory_raw_analytics",
  "dofek_sensor_priority_raw_analytics",
] as const;

const defaultThresholds: CdcHealthThresholds = {
  retainedWalWarningBytes: 16 * 1024 * 1024 * 1024,
  retainedWalFailureBytes: 32 * 1024 * 1024 * 1024,
};

const defaultMirrorFreshnessChecks: readonly MirrorFreshnessCheck[] = [
  { tableName: "sleep_session", maxAgeMilliseconds: 36 * 60 * 60 * 1000 },
];

const numericStringSchema = z.string().regex(/^\d+$/);
const nullableIntegerLikeSchema = z.union([
  z.number().int().nonnegative(),
  numericStringSchema,
  z.null(),
]);
const integerLikeSchema = z.union([z.number().int().nonnegative(), numericStringSchema]);
const nullableStringLikeSchema = z.union([z.string(), z.number(), z.date(), z.null()]);

const postgresReplicationSlotRowsSchema = z.object({
  rows: z.array(
    z.object({
      active: z.boolean(),
      restart_lsn: z.string().nullable(),
      retained_wal_bytes: nullableIntegerLikeSchema,
      slot_name: z.enum(EXPECTED_PEERDB_REPLICATION_SLOT_NAMES),
      wal_status: z.string().nullable(),
    }),
  ),
});

const peerDbMirrorRowsSchema = z.object({
  rows: z.array(
    z.object({
      name: z.enum(expectedPeerDbMirrorNames),
      status: nullableStringLikeSchema,
      updated_at: nullableStringLikeSchema,
      workflow_id: z.string().nullable(),
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

export interface CdcHealthReplicationSlotEvidence {
  active: boolean;
  retainedWalBytes: string | null;
  slotName: string;
  walStatus: string | null;
}

export interface CdcHealthPeerDbMirrorEvidence {
  name: string;
  status: string | null;
  updatedAt: string | null;
  workflowId: string | null;
}

export interface CdcHealthEvidence {
  peerDbMirrors: CdcHealthPeerDbMirrorEvidence[];
  replicationSlots: CdcHealthReplicationSlotEvidence[];
}

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

function nullableStringLikeToString(
  value: z.infer<typeof nullableStringLikeSchema>,
): string | null {
  if (value === null) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
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

function buildExpectedValues(values: readonly string[]): string {
  return values.map((value) => `('${value}')`).join(", ");
}

function assertSafeClickHouseTableName(tableName: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(tableName)) {
    throw new Error(`Unsafe ClickHouse table name: ${tableName}`);
  }
}

function buildPeerDbMirrorQuery(): string {
  return `
    SELECT
      flows.name,
      flows.status,
      flows.updated_at,
      flows.workflow_id
    FROM public.flows
    JOIN (VALUES ${buildExpectedValues(expectedPeerDbMirrorNames)}) AS expected_mirrors(name)
      ON expected_mirrors.name = flows.name
    ORDER BY flows.name
  `;
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

function addPeerDbMirrorIssues(
  issues: CdcHealthIssue[],
  mirrorRows: z.infer<typeof peerDbMirrorRowsSchema>["rows"],
): void {
  const mirrorRowsByName = new Map(mirrorRows.map((mirrorRow) => [mirrorRow.name, mirrorRow]));

  for (const expectedMirrorName of expectedPeerDbMirrorNames) {
    if (!mirrorRowsByName.has(expectedMirrorName)) {
      issues.push({
        severity: "failure",
        message: `Missing required PeerDB raw mirror ${expectedMirrorName}`,
      });
    }
  }
}

function addSlotIssues(
  issues: CdcHealthIssue[],
  slotRows: z.infer<typeof postgresReplicationSlotRowsSchema>["rows"],
  thresholds: CdcHealthThresholds,
): void {
  const slotRowsByName = new Map(slotRows.map((slotRow) => [slotRow.slot_name, slotRow]));

  for (const expectedSlotName of EXPECTED_PEERDB_REPLICATION_SLOT_NAMES) {
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

function buildEvidence(
  slotRows: z.infer<typeof postgresReplicationSlotRowsSchema>["rows"],
  mirrorRows: z.infer<typeof peerDbMirrorRowsSchema>["rows"],
): CdcHealthEvidence {
  return {
    peerDbMirrors: mirrorRows.map((mirrorRow) => ({
      name: mirrorRow.name,
      status: nullableStringLikeToString(mirrorRow.status),
      updatedAt: nullableStringLikeToString(mirrorRow.updated_at),
      workflowId: mirrorRow.workflow_id,
    })),
    replicationSlots: slotRows.map((slotRow) => ({
      active: slotRow.active,
      retainedWalBytes: nullableStringLikeToString(slotRow.retained_wal_bytes),
      slotName: slotRow.slot_name,
      walStatus: slotRow.wal_status,
    })),
  };
}

function formatPeerDbMirrorEvidence(mirror: CdcHealthPeerDbMirrorEvidence): string {
  const status = mirror.status ?? "unknown";
  const workflowId = mirror.workflowId ?? "unknown";
  return `${mirror.name}(status=${status}, workflow=${workflowId})`;
}

function formatReplicationSlotEvidence(slot: CdcHealthReplicationSlotEvidence): string {
  const walStatus = slot.walStatus ?? "unknown";
  const retainedWalBytes = slot.retainedWalBytes ?? "unknown";
  return `${slot.slotName}(active=${slot.active}, wal_status=${walStatus}, retained_wal_bytes=${retainedWalBytes})`;
}

export function formatCdcHealthEvidence(evidence: CdcHealthEvidence): string {
  const mirrorSummary =
    evidence.peerDbMirrors.length === 0
      ? "none"
      : evidence.peerDbMirrors.map(formatPeerDbMirrorEvidence).join(", ");
  const slotSummary =
    evidence.replicationSlots.length === 0
      ? "none"
      : evidence.replicationSlots.map(formatReplicationSlotEvidence).join(", ");

  return [
    "CDC health evidence:",
    `- PeerDB raw mirrors observed: ${mirrorSummary}`,
    `- Postgres replication slots observed: ${slotSummary}`,
  ].join("\n");
}

export async function checkClickHouseCdcHealth(
  options: CheckClickHouseCdcHealthOptions,
): Promise<CdcHealthReport> {
  const thresholds = { ...defaultThresholds, ...options.thresholds };
  const mirrorFreshnessChecks = options.mirrorFreshnessChecks ?? defaultMirrorFreshnessChecks;
  const now = options.now ?? new Date();
  const peerDbClient = options.peerDbClient;
  const shouldCheckPeerDbMirrors = peerDbClient !== undefined;

  const peerDbMirrorRows = !shouldCheckPeerDbMirrors
    ? []
    : peerDbMirrorRowsSchema.parse(await peerDbClient.query(buildPeerDbMirrorQuery())).rows;

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
    WHERE slot_name = ANY (ARRAY[${EXPECTED_PEERDB_REPLICATION_SLOT_NAMES.map((slotName) => `'${slotName}'`).join(", ")}])
    ORDER BY slot_name
  `);
  const parsedSlotRows = postgresReplicationSlotRowsSchema.parse(slotQueryResult).rows;

  const freshnessQueryResult = await options.clickHouseClient.query({
    query: buildFreshnessQuery(mirrorFreshnessChecks),
    format: "JSONEachRow",
  });
  const freshnessRows = clickHouseFreshnessRowsSchema.parse(await freshnessQueryResult.json());

  const issues: CdcHealthIssue[] = [];
  if (shouldCheckPeerDbMirrors) {
    addPeerDbMirrorIssues(issues, peerDbMirrorRows);
  }
  addSlotIssues(issues, parsedSlotRows, thresholds);
  addMirrorFreshnessIssues(issues, freshnessRows, mirrorFreshnessChecks, now);

  return {
    issues,
    slotCount: parsedSlotRows.length,
    mirrorCount: freshnessRows.length,
    peerDbMirrorCount: shouldCheckPeerDbMirrors ? peerDbMirrorRows.length : null,
    evidence: buildEvidence(parsedSlotRows, peerDbMirrorRows),
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
      .join("\n")}\n${formatCdcHealthEvidence(report.evidence)}`,
  );
}
