import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveProviderTimezoneLocalTimeContext } from "@dofek/format/record-local-time";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  type ActivityIntegrityClickHouseClient,
  capturedRowsWithAfterOnlyTombstones,
  clickHouseDedupedActivityRowSchema,
  clickHouseDerivedActivityRowSchema,
  clickHouseDerivedMemberRowSchema,
  clickHouseGroupRowSchema,
  clickHouseMatchRowSchema,
  clickHouseSourceRowSchema,
  componentSchema,
  type DerivedSnapshot,
  incompatibleMemberCount,
  restoredRowsEqual,
  rowsEqual,
  snapshotDerivedRows,
  sourceRowsMatchPostgres,
  uint64StringSchema,
  waitForPostgresMirror,
} from "./activity-data-integrity-clickhouse.ts";
import { runActivityIntegrityDbtBuild } from "./activity-data-integrity-dbt.ts";
import { executeWithSchema, type SchemaExecutionDatabase } from "./typed-sql.ts";

const MAXIMUM_BATCH_SIZE = 1_000;
const MAXIMUM_UINT64 = (1n << 64n) - 1n;
const AUDIT_SCHEMA_VERSION = 1;
const ACTIVITY_INTEGRITY_LEASE_NAME = "dofek:activity-data-integrity-repair:v1";
export const ACTIVITY_INTEGRITY_MAX_ACCEPTANCE_WINDOW_MS = 24 * 60 * 60 * 1_000;
const postgresUuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "must be a UUID");

const localTimeSourceSchema = z.enum([
  "unknown",
  "provider_timezone",
  "provider_offset",
  "device_timezone",
  "device_offset",
  "user_home_timezone",
]);

const postgresCandidateSchema = z.object({
  id: postgresUuidSchema,
  provider_id: z.string().min(1),
  external_id: z.string().min(1),
  user_id: postgresUuidSchema,
  started_at: z.coerce.date(),
  ended_at: z.coerce.date().nullable(),
  timezone: z.string().nullable(),
  start_utc_offset_minutes: z.coerce.number().int().nullable(),
  end_utc_offset_minutes: z.coerce.number().int().nullable(),
  local_time_source: localTimeSourceSchema,
});

const updatedActivitySchema = z.object({ id: postgresUuidSchema });

const localTimeContextSchema = z.object({
  timezone: z.string().nullable(),
  startUtcOffsetMinutes: z.number().int().nullable(),
  endUtcOffsetMinutes: z.number().int().nullable(),
  localTimeSource: localTimeSourceSchema,
});

const postgresArtifactRowSchema = z.object({
  id: postgresUuidSchema,
  providerId: z.string().min(1),
  externalId: z.string().min(1),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  prior: localTimeContextSchema,
  repaired: localTimeContextSchema,
});

const capturedDerivedRowsSchema = {
  sourceRowsAfter: z.array(clickHouseSourceRowSchema),
  matchRowsAfter: z.array(clickHouseMatchRowSchema),
  groupRowsAfter: z.array(clickHouseGroupRowSchema),
  dedupedRowsAfter: z.array(clickHouseDedupedActivityRowSchema),
  memberRowsAfter: z.array(clickHouseDerivedMemberRowSchema),
  sensorSummaryRowsAfter: z.array(clickHouseDerivedActivityRowSchema),
  summaryRowsAfter: z.array(clickHouseDerivedActivityRowSchema),
  componentsAfter: z.array(componentSchema),
  highestDerivedVersion: uint64StringSchema,
};

const auditArtifactSchema = z.object({
  schemaVersion: z.literal(AUDIT_SCHEMA_VERSION),
  runId: postgresUuidSchema,
  phase: z.enum([
    "dry_run",
    "snapshot",
    "postgres_committed",
    "rebuild_failed",
    "executed",
    "rolled_back",
  ]),
  rollbackEligibility: z.enum(["not_applicable", "eligible"]),
  createdAt: z.string().datetime(),
  userId: postgresUuidSchema,
  window: z.object({
    startAt: z.string().datetime(),
    endAt: z.string().datetime(),
  }),
  bounds: z.object({
    batchSize: z.number().int().positive(),
    maxBatches: z.number().int().positive(),
  }),
  acceptance: z.object({ owner: z.string().min(1), deadline: z.string().datetime() }).nullable(),
  selected: z.number().int().nonnegative(),
  changedActivityIds: z.array(postgresUuidSchema),
  highestDerivedVersion: uint64StringSchema,
  postgresActivities: z.array(postgresArtifactRowSchema),
  sourceRowsBefore: z.array(clickHouseSourceRowSchema),
  matchRowsBefore: z.array(clickHouseMatchRowSchema),
  groupRowsBefore: z.array(clickHouseGroupRowSchema),
  dedupedRowsBefore: z.array(clickHouseDedupedActivityRowSchema),
  memberRowsBefore: z.array(clickHouseDerivedMemberRowSchema),
  sensorSummaryRowsBefore: z.array(clickHouseDerivedActivityRowSchema),
  summaryRowsBefore: z.array(clickHouseDerivedActivityRowSchema),
  componentsBefore: z.array(componentSchema),
  postgresCommit: z
    .object({ completedAt: z.string().datetime(), updated: z.number().int().nonnegative() })
    .optional(),
  execution: z
    .object({
      completedAt: z.string().datetime(),
      updated: z.number().int().nonnegative(),
      ...capturedDerivedRowsSchema,
    })
    .optional(),
  failure: z
    .object({
      failedAt: z.string().datetime(),
      stage: z.enum(["cdc_readiness", "dbt_rebuild", "verification"]),
      message: z.string().min(1),
      ...capturedDerivedRowsSchema,
    })
    .optional(),
  rollback: z
    .object({ completedAt: z.string().datetime(), refreshVersion: uint64StringSchema })
    .optional(),
});

type PostgresCandidate = z.infer<typeof postgresCandidateSchema>;
type PostgresArtifactRow = z.infer<typeof postgresArtifactRowSchema>;
type AuditArtifact = z.infer<typeof auditArtifactSchema>;

export interface ActivityIntegrityRepairOptions {
  userId: string;
  startAt: Date;
  endAt: Date;
  execute: boolean;
  batchSize: number;
  maxBatches: number;
  artifactDirectory?: string;
  acceptanceOwner?: string;
  acceptanceDeadline?: Date;
}

export type { ActivityIntegrityClickHouseClient } from "./activity-data-integrity-clickhouse.ts";

export interface ActivityIntegrityDatabase extends SchemaExecutionDatabase {
  $client: {
    connect(): Promise<{
      query(query: string, values?: unknown[]): Promise<{ rows: object[] }>;
      release(): void;
    }>;
  };
  transaction<T>(operation: (transaction: SchemaExecutionDatabase) => Promise<T>): Promise<T>;
}

interface ActivityIntegrityRepairDependencies {
  artifactDirectory?: string;
  generateRunId?: () => string;
  now?: () => Date;
  rebuildReadModels?: (input: { userId: string; activityIds: readonly string[] }) => Promise<void>;
  cdcReadinessTimeoutMs?: number;
  cdcReadinessPollIntervalMs?: number;
  monotonicNow?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface ActivityIntegrityRollbackDependencies {
  now?: () => Date;
  generateRunId?: () => string;
}

interface ActivityIntegrityRetirementDependencies {
  now?: () => Date;
}

export interface ActivityIntegrityRepairResult {
  runId: string;
  selected: number;
  changed: number;
  updated: number;
  changedIds: string[];
  incompatibleMemberCount: number;
  beforeComponentCount: number;
  afterComponentCount: number;
  artifactPath: string;
}

export interface ActivityIntegrityRollbackResult {
  runId: string;
  updated: number;
  refreshVersion: string;
}

function validateOptions(options: ActivityIntegrityRepairOptions, now: Date): void {
  if (!postgresUuidSchema.safeParse(options.userId).success) {
    throw new Error("userId must be a UUID");
  }
  if (!Number.isFinite(options.startAt.getTime())) throw new Error("startAt must be a valid date");
  if (!Number.isFinite(options.endAt.getTime())) throw new Error("endAt must be a valid date");
  if (options.startAt >= options.endAt) throw new Error("startAt must be earlier than endAt");
  if (
    !Number.isInteger(options.batchSize) ||
    options.batchSize < 1 ||
    options.batchSize > MAXIMUM_BATCH_SIZE
  ) {
    throw new Error(`batchSize must be an integer between 1 and ${MAXIMUM_BATCH_SIZE}`);
  }
  if (!Number.isInteger(options.maxBatches) || options.maxBatches < 1) {
    throw new Error("maxBatches must be a positive integer");
  }
  if (!options.execute) return;
  if (!options.acceptanceOwner?.trim()) {
    throw new Error("acceptanceOwner is required for execute mode");
  }
  if (!options.acceptanceDeadline || !Number.isFinite(options.acceptanceDeadline.getTime())) {
    throw new Error("acceptanceDeadline is required for execute mode");
  }
  if (options.acceptanceDeadline <= now) {
    throw new Error("acceptanceDeadline must be in the future");
  }
  if (
    options.acceptanceDeadline.getTime() - now.getTime() >
    ACTIVITY_INTEGRITY_MAX_ACCEPTANCE_WINDOW_MS
  ) {
    throw new Error("acceptanceDeadline must be within 24 hours");
  }
}

function defaultArtifactDirectory(): string {
  return resolve(process.cwd(), "activity-data-integrity-artifacts");
}

function artifactPathFor(directory: string, createdAt: Date, runId: string): string {
  return resolve(directory, `${createdAt.toISOString().replaceAll(":", "-")}-${runId}.audit.json`);
}

function retirementReceiptPath(artifactPath: string): string {
  return `${artifactPath}.retired.json`;
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(
    value,
    (_key, nestedValue: unknown) =>
      typeof nestedValue === "bigint" ? nestedValue.toString() : nestedValue,
    2,
  )}\n`;
}

async function writeNewPrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, serializeJson(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
}

async function replacePrivateJson(
  path: string,
  value: unknown,
  generateRunId: () => string,
): Promise<void> {
  const temporaryPath = `${path}.${generateRunId()}.tmp`;
  await writeNewPrivateJson(temporaryPath, value);
  await rename(temporaryPath, path);
}

async function readArtifact(path: string): Promise<AuditArtifact> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  return auditArtifactSchema.parse(raw);
}

async function rejectActiveArtifacts(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const fileNames = await readdir(directory);
  for (const fileName of fileNames.filter((name) => name.endsWith(".audit.json")).sort()) {
    const artifactPath = resolve(directory, fileName);
    const artifact = await readArtifact(artifactPath);
    if (
      artifact.rollbackEligibility === "eligible" &&
      !existsSync(retirementReceiptPath(artifactPath))
    ) {
      throw new Error(`rollback-eligible audit artifact must be retired first: ${artifactPath}`);
    }
  }
}

async function withActivityIntegrityLease<T>(
  db: ActivityIntegrityDatabase,
  operation: () => Promise<T>,
): Promise<T> {
  const connection = await db.$client.connect();
  let acquired = false;
  try {
    const result = await connection.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS acquired",
      [ACTIVITY_INTEGRITY_LEASE_NAME],
    );
    acquired =
      result.rows[0] != null && "acquired" in result.rows[0] && result.rows[0].acquired === true;
    if (!acquired) throw new Error("activity integrity repair is already running");
    return await operation();
  } finally {
    if (acquired) {
      await connection.query("SELECT pg_advisory_unlock(hashtextextended($1::text, 0))", [
        ACTIVITY_INTEGRITY_LEASE_NAME,
      ]);
    }
    connection.release();
  }
}

async function selectPostgresActivities(
  db: SchemaExecutionDatabase,
  options: ActivityIntegrityRepairOptions,
): Promise<PostgresCandidate[]> {
  const selected: PostgresCandidate[] = [];
  let cursorStartedAt: Date | null = null;
  let cursorId: string | null = null;
  for (let batchIndex = 0; batchIndex < options.maxBatches; batchIndex += 1) {
    const rows: PostgresCandidate[] = await executeWithSchema(
      db,
      postgresCandidateSchema,
      sql`SELECT
            activity.id::text AS id,
            activity.provider_id,
            activity.external_id,
            activity.user_id::text AS user_id,
            activity.started_at,
            activity.ended_at,
            activity.timezone,
            activity.start_utc_offset_minutes::integer AS start_utc_offset_minutes,
            activity.end_utc_offset_minutes::integer AS end_utc_offset_minutes,
            activity.local_time_source
          FROM fitness.activity AS activity
          WHERE activity.user_id = ${options.userId}::uuid
            AND activity.started_at >= ${options.startAt}
            AND activity.started_at < ${options.endAt}
            ${
              cursorStartedAt == null || cursorId == null
                ? sql``
                : sql`AND (activity.started_at, activity.id) > (${cursorStartedAt}, ${cursorId}::uuid)`
            }
          ORDER BY activity.started_at, activity.id
          LIMIT ${options.batchSize}`,
    );
    selected.push(...rows);
    if (rows.length < options.batchSize) break;
    const cursor: PostgresCandidate | undefined = rows.at(-1);
    if (!cursor) break;
    cursorStartedAt = cursor.started_at;
    cursorId = cursor.id;
  }
  return selected;
}

function localTimeContext(row: PostgresCandidate): z.infer<typeof localTimeContextSchema> {
  return {
    timezone: row.timezone,
    startUtcOffsetMinutes: row.start_utc_offset_minutes,
    endUtcOffsetMinutes: row.end_utc_offset_minutes,
    localTimeSource: row.local_time_source,
  };
}

function normalizedLocalTimeContext(
  row: PostgresCandidate,
): z.infer<typeof localTimeContextSchema> {
  if (
    row.timezone?.trim() &&
    (row.local_time_source === "provider_timezone" || row.local_time_source === "unknown")
  ) {
    const normalized = resolveProviderTimezoneLocalTimeContext({
      startedAt: row.started_at,
      endedAt: row.ended_at,
      timezone: row.timezone,
      suppliedOffsets: {
        startUtcOffsetMinutes: row.start_utc_offset_minutes,
        endUtcOffsetMinutes: row.end_utc_offset_minutes,
      },
    });
    return {
      timezone: normalized.timezone,
      startUtcOffsetMinutes: normalized.startUtcOffsetMinutes,
      endUtcOffsetMinutes: normalized.endUtcOffsetMinutes,
      localTimeSource: normalized.source,
    };
  }
  return localTimeContext(row);
}

function artifactPostgresRows(rows: PostgresCandidate[]): PostgresArtifactRow[] {
  return rows.map((row) => ({
    id: row.id,
    providerId: row.provider_id,
    externalId: row.external_id,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at?.toISOString() ?? null,
    prior: localTimeContext(row),
    repaired: normalizedLocalTimeContext(row),
  }));
}

function localTimeContextsEqual(
  left: z.infer<typeof localTimeContextSchema>,
  right: z.infer<typeof localTimeContextSchema>,
): boolean {
  return (
    left.timezone === right.timezone &&
    left.startUtcOffsetMinutes === right.startUtcOffsetMinutes &&
    left.endUtcOffsetMinutes === right.endUtcOffsetMinutes &&
    left.localTimeSource === right.localTimeSource
  );
}

function valuesForPostgresUpdate(
  rows: readonly PostgresArtifactRow[],
  direction: "repair" | "rollback",
) {
  return sql.join(
    rows.map((row) => {
      const target = direction === "repair" ? row.repaired : row.prior;
      const expected = direction === "repair" ? row.prior : row.repaired;
      return sql`(
        ${row.id}::uuid,
        ${row.providerId}::text,
        ${row.externalId}::text,
        ${new Date(row.startedAt)}::timestamptz,
        ${row.endedAt == null ? null : new Date(row.endedAt)}::timestamptz,
        ${target.timezone}::text,
        ${target.startUtcOffsetMinutes}::bigint,
        ${target.endUtcOffsetMinutes}::bigint,
        ${target.localTimeSource}::text,
        ${expected.timezone}::text,
        ${expected.startUtcOffsetMinutes}::bigint,
        ${expected.endUtcOffsetMinutes}::bigint,
        ${expected.localTimeSource}::text
      )`;
    }),
    sql`, `,
  );
}

async function updatePostgresActivities(
  db: SchemaExecutionDatabase,
  rows: readonly PostgresArtifactRow[],
  batchSize: number,
  direction: "repair" | "rollback",
): Promise<number> {
  let updated = 0;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values = valuesForPostgresUpdate(batch, direction);
    const updatedRows = await executeWithSchema(
      db,
      updatedActivitySchema,
      sql`WITH context_values (
            id,
            provider_id,
            external_id,
            started_at,
            ended_at,
            target_timezone,
            target_start_utc_offset_minutes,
            target_end_utc_offset_minutes,
            target_local_time_source,
            expected_timezone,
            expected_start_utc_offset_minutes,
            expected_end_utc_offset_minutes,
            expected_local_time_source
          ) AS (
            VALUES ${values}
          ),
          updated AS (
            UPDATE fitness.activity AS activity
            SET
              timezone = context_values.target_timezone,
              start_utc_offset_minutes = context_values.target_start_utc_offset_minutes,
              end_utc_offset_minutes = context_values.target_end_utc_offset_minutes,
              local_time_source = context_values.target_local_time_source
            FROM context_values
            WHERE activity.id = context_values.id
              AND activity.provider_id = context_values.provider_id
              AND activity.external_id = context_values.external_id
              AND activity.started_at = context_values.started_at
              AND activity.ended_at IS NOT DISTINCT FROM context_values.ended_at
              AND activity.timezone IS NOT DISTINCT FROM context_values.expected_timezone
              AND activity.start_utc_offset_minutes IS NOT DISTINCT FROM context_values.expected_start_utc_offset_minutes
              AND activity.end_utc_offset_minutes IS NOT DISTINCT FROM context_values.expected_end_utc_offset_minutes
              AND activity.local_time_source = context_values.expected_local_time_source
            RETURNING activity.id::text AS id
          )
          SELECT id FROM updated`,
    );
    if (updatedRows.length !== batch.length) {
      throw new Error(
        `stale audit artifact: Postgres compare-and-swap matched ${updatedRows.length} of ${batch.length} activities`,
      );
    }
    updated += updatedRows.length;
  }
  return updated;
}

function capturedDerivedRows(snapshot: DerivedSnapshot) {
  return {
    highestDerivedVersion: snapshot.highestVersion,
    sourceRowsAfter: snapshot.sourceRows,
    matchRowsAfter: snapshot.matchRows,
    groupRowsAfter: snapshot.groupRows,
    dedupedRowsAfter: snapshot.dedupedRows,
    memberRowsAfter: snapshot.memberRows,
    sensorSummaryRowsAfter: snapshot.sensorSummaryRows,
    summaryRowsAfter: snapshot.summaryRows,
    componentsAfter: snapshot.components,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function repairActivityDataIntegrityWithLease(
  db: ActivityIntegrityDatabase,
  clickHouse: ActivityIntegrityClickHouseClient,
  options: ActivityIntegrityRepairOptions,
  dependencies: ActivityIntegrityRepairDependencies = {},
): Promise<ActivityIntegrityRepairResult> {
  const now = dependencies.now ?? (() => new Date());
  const generateRunId = dependencies.generateRunId ?? randomUUID;
  const createdAt = now();
  validateOptions(options, createdAt);
  const artifactDirectory = resolve(
    options.artifactDirectory ?? dependencies.artifactDirectory ?? defaultArtifactDirectory(),
  );
  if (options.execute) await rejectActiveArtifacts(artifactDirectory);
  else await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });

  const runId = generateRunId();
  const selectedRows = await selectPostgresActivities(db, options);
  const postgresActivities = artifactPostgresRows(selectedRows);
  const changedRows = postgresActivities.filter(
    (row) => !localTimeContextsEqual(row.prior, row.repaired),
  );
  const before = await snapshotDerivedRows(
    clickHouse,
    options.userId,
    selectedRows.map((row) => row.id),
  );
  const artifactPath = artifactPathFor(artifactDirectory, createdAt, runId);
  const acceptance = options.execute
    ? {
        owner: options.acceptanceOwner?.trim() ?? "",
        deadline: options.acceptanceDeadline?.toISOString() ?? "",
      }
    : null;
  const artifact: AuditArtifact = {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    runId,
    phase: options.execute ? "snapshot" : "dry_run",
    rollbackEligibility: options.execute && changedRows.length > 0 ? "eligible" : "not_applicable",
    createdAt: createdAt.toISOString(),
    userId: options.userId,
    window: { startAt: options.startAt.toISOString(), endAt: options.endAt.toISOString() },
    bounds: { batchSize: options.batchSize, maxBatches: options.maxBatches },
    acceptance,
    selected: selectedRows.length,
    changedActivityIds: changedRows.map((row) => row.id),
    highestDerivedVersion: before.highestVersion,
    postgresActivities,
    sourceRowsBefore: before.sourceRows,
    matchRowsBefore: before.matchRows,
    groupRowsBefore: before.groupRows,
    dedupedRowsBefore: before.dedupedRows,
    memberRowsBefore: before.memberRows,
    sensorSummaryRowsBefore: before.sensorSummaryRows,
    summaryRowsBefore: before.summaryRows,
    componentsBefore: before.components,
  };
  await writeNewPrivateJson(artifactPath, artifact);

  if (!options.execute || changedRows.length === 0) {
    if (options.execute) {
      const completed: AuditArtifact = {
        ...artifact,
        phase: "executed",
        execution: {
          completedAt: now().toISOString(),
          updated: 0,
          ...capturedDerivedRows(before),
        },
      };
      await replacePrivateJson(artifactPath, completed, generateRunId);
    }
    return {
      runId,
      selected: selectedRows.length,
      changed: changedRows.length,
      updated: 0,
      changedIds: changedRows.map((row) => row.id),
      incompatibleMemberCount: 0,
      beforeComponentCount: before.components.length,
      afterComponentCount: before.components.length,
      artifactPath,
    };
  }

  const updated = await db.transaction((transaction) =>
    updatePostgresActivities(transaction, changedRows, options.batchSize, "repair"),
  );
  const postgresCommitted: AuditArtifact = {
    ...artifact,
    phase: "postgres_committed",
    postgresCommit: { completedAt: now().toISOString(), updated },
  };
  await replacePrivateJson(artifactPath, postgresCommitted, generateRunId);
  const rebuildReadModels = dependencies.rebuildReadModels ?? runActivityIntegrityDbtBuild;
  let failureStage: "cdc_readiness" | "dbt_rebuild" | "verification" = "cdc_readiness";
  try {
    await waitForPostgresMirror(clickHouse, options.userId, changedRows, dependencies);
    failureStage = "dbt_rebuild";
    await rebuildReadModels({
      userId: options.userId,
      activityIds: before.activityIds,
    });
    failureStage = "verification";
    const after = await snapshotDerivedRows(clickHouse, options.userId, before.activityIds);
    if (!sourceRowsMatchPostgres(after.sourceRows, changedRows)) {
      throw new Error("activity integrity rebuild did not publish the repaired local-time context");
    }
    const completed: AuditArtifact = {
      ...postgresCommitted,
      phase: "executed",
      execution: {
        completedAt: now().toISOString(),
        updated,
        ...capturedDerivedRows(after),
      },
    };
    await replacePrivateJson(artifactPath, completed, generateRunId);

    return {
      runId,
      selected: selectedRows.length,
      changed: changedRows.length,
      updated,
      changedIds: changedRows.map((row) => row.id),
      incompatibleMemberCount: incompatibleMemberCount(after),
      beforeComponentCount: before.components.length,
      afterComponentCount: after.components.length,
      artifactPath,
    };
  } catch (error) {
    const failedState = await snapshotDerivedRows(clickHouse, options.userId, before.activityIds);
    const failed: AuditArtifact = {
      ...postgresCommitted,
      phase: "rebuild_failed",
      failure: {
        failedAt: now().toISOString(),
        stage: failureStage,
        message: errorMessage(error),
        ...capturedDerivedRows(failedState),
      },
    };
    await replacePrivateJson(artifactPath, failed, generateRunId);
    throw error;
  }
}

export async function repairActivityDataIntegrity(
  db: ActivityIntegrityDatabase,
  clickHouse: ActivityIntegrityClickHouseClient,
  options: ActivityIntegrityRepairOptions,
  dependencies: ActivityIntegrityRepairDependencies = {},
): Promise<ActivityIntegrityRepairResult> {
  return withActivityIntegrityLease(db, () =>
    repairActivityDataIntegrityWithLease(db, clickHouse, options, dependencies),
  );
}

function rollbackVersion(artifact: AuditArtifact, current: DerivedSnapshot): string {
  const candidates = [
    artifact.highestDerivedVersion,
    artifact.execution?.highestDerivedVersion ?? "0",
    artifact.failure?.highestDerivedVersion ?? "0",
    current.highestVersion,
  ].map(BigInt);
  const next = candidates.reduce((highest, value) => (value > highest ? value : highest), 0n) + 1n;
  if (next > MAXIMUM_UINT64) throw new Error("cannot allocate a newer UInt64 rollback version");
  return next.toString();
}

interface CapturedPostState {
  sourceRowsAfter: DerivedSnapshot["sourceRows"];
  matchRowsAfter: DerivedSnapshot["matchRows"];
  groupRowsAfter: DerivedSnapshot["groupRows"];
  dedupedRowsAfter: DerivedSnapshot["dedupedRows"];
  memberRowsAfter: DerivedSnapshot["memberRows"];
  sensorSummaryRowsAfter: DerivedSnapshot["sensorSummaryRows"];
  summaryRowsAfter: DerivedSnapshot["summaryRows"];
}

function snapshotMatchesCaptured(current: DerivedSnapshot, captured: CapturedPostState): boolean {
  return (
    rowsEqual(current.sourceRows, captured.sourceRowsAfter) &&
    rowsEqual(current.matchRows, captured.matchRowsAfter) &&
    rowsEqual(current.groupRows, captured.groupRowsAfter) &&
    rowsEqual(current.dedupedRows, captured.dedupedRowsAfter) &&
    rowsEqual(current.memberRows, captured.memberRowsAfter) &&
    rowsEqual(current.sensorSummaryRows, captured.sensorSummaryRowsAfter) &&
    rowsEqual(current.summaryRows, captured.summaryRowsAfter)
  );
}

function addSnapshotActivityIds(activityIds: Set<string>, snapshot: CapturedPostState): void {
  for (const row of snapshot.sourceRowsAfter) activityIds.add(row.activity_id);
  for (const row of snapshot.matchRowsAfter) {
    activityIds.add(row.activity_id);
    activityIds.add(row.duplicate_activity_id);
  }
  for (const row of snapshot.groupRowsAfter) {
    activityIds.add(row.activity_id);
    if (row.group_id && postgresUuidSchema.safeParse(row.group_id).success)
      activityIds.add(row.group_id);
  }
  for (const row of snapshot.dedupedRowsAfter) {
    activityIds.add(row.activity_id);
    for (const memberActivityId of row.member_activity_ids) activityIds.add(memberActivityId);
  }
  for (const row of snapshot.memberRowsAfter) {
    activityIds.add(row.activity_id);
    activityIds.add(row.member_activity_id);
  }
  for (const row of snapshot.sensorSummaryRowsAfter) activityIds.add(row.activity_id);
  for (const row of snapshot.summaryRowsAfter) activityIds.add(row.activity_id);
}

function affectedArtifactActivityIds(artifact: AuditArtifact): string[] {
  const activityIds = new Set(artifact.changedActivityIds);
  addSnapshotActivityIds(activityIds, {
    sourceRowsAfter: artifact.sourceRowsBefore,
    matchRowsAfter: artifact.matchRowsBefore,
    groupRowsAfter: artifact.groupRowsBefore,
    dedupedRowsAfter: artifact.dedupedRowsBefore,
    memberRowsAfter: artifact.memberRowsBefore,
    sensorSummaryRowsAfter: artifact.sensorSummaryRowsBefore,
    summaryRowsAfter: artifact.summaryRowsBefore,
  });
  if (artifact.execution) addSnapshotActivityIds(activityIds, artifact.execution);
  if (artifact.failure) addSnapshotActivityIds(activityIds, artifact.failure);
  return [...activityIds];
}

async function insertRollbackRows(
  clickHouse: ActivityIntegrityClickHouseClient,
  table: string,
  rows: readonly Record<string, unknown>[],
  version: string,
  refreshedAt: string,
  batchSize: number,
): Promise<void> {
  if (rows.length === 0) return;
  if (!clickHouse.insert) throw new Error("ClickHouse rollback requires an insert-capable client");
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const values = rows.slice(offset, offset + batchSize).map((row) => ({
      ...row,
      refresh_version: version,
      refreshed_at: refreshedAt,
    }));
    await clickHouse.insert({ table, values, format: "JSONEachRow" });
  }
}

async function rollbackActivityDataIntegrityWithLease(
  db: ActivityIntegrityDatabase,
  clickHouse: ActivityIntegrityClickHouseClient,
  artifactPath: string,
  dependencies: ActivityIntegrityRollbackDependencies = {},
): Promise<ActivityIntegrityRollbackResult> {
  if (existsSync(retirementReceiptPath(artifactPath))) {
    throw new Error("retired audit artifact cannot be rolled back");
  }
  const artifact = await readArtifact(artifactPath);
  if (
    !["postgres_committed", "rebuild_failed", "executed"].includes(artifact.phase) ||
    artifact.rollbackEligibility !== "eligible"
  ) {
    throw new Error("audit artifact is not rollback-eligible");
  }
  const capturedPostState = artifact.execution ?? artifact.failure;
  const affectedIds = affectedArtifactActivityIds(artifact);
  const current = await snapshotDerivedRows(clickHouse, artifact.userId, affectedIds);
  if (capturedPostState && !snapshotMatchesCaptured(current, capturedPostState)) {
    throw new Error("stale audit artifact: ClickHouse derived state changed after repair");
  }
  const changedRows = artifact.postgresActivities.filter((row) =>
    artifact.changedActivityIds.includes(row.id),
  );
  const updated = await db.transaction((transaction) =>
    updatePostgresActivities(transaction, changedRows, artifact.bounds.batchSize, "rollback"),
  );
  const version = rollbackVersion(artifact, current);
  const completedAt = (dependencies.now ?? (() => new Date()))();
  const refreshedAt = completedAt.toISOString();
  const sourceRows = capturedRowsWithAfterOnlyTombstones(
    artifact.sourceRowsBefore,
    current.sourceRows,
    ["activity_id"],
  );
  const matchRows = capturedRowsWithAfterOnlyTombstones(
    artifact.matchRowsBefore,
    current.matchRows,
    ["activity_id", "duplicate_activity_id"],
  );
  const groupRows = capturedRowsWithAfterOnlyTombstones(
    artifact.groupRowsBefore,
    current.groupRows,
    ["activity_id"],
  );
  const dedupedRows = capturedRowsWithAfterOnlyTombstones(
    artifact.dedupedRowsBefore,
    current.dedupedRows,
    ["activity_id"],
  );
  const memberRows = capturedRowsWithAfterOnlyTombstones(
    artifact.memberRowsBefore,
    current.memberRows,
    ["user_id", "member_activity_id"],
  );
  const sensorSummaryRows = capturedRowsWithAfterOnlyTombstones(
    artifact.sensorSummaryRowsBefore,
    current.sensorSummaryRows,
    ["activity_id"],
  );
  const summaryRows = capturedRowsWithAfterOnlyTombstones(
    artifact.summaryRowsBefore,
    current.summaryRows,
    ["activity_id"],
  );
  await insertRollbackRows(
    clickHouse,
    "analytics.activity_source_records",
    sourceRows,
    version,
    refreshedAt,
    artifact.bounds.batchSize,
  );
  await insertRollbackRows(
    clickHouse,
    "analytics.activity_duplicate_matches",
    matchRows,
    version,
    refreshedAt,
    artifact.bounds.batchSize,
  );
  await insertRollbackRows(
    clickHouse,
    "analytics.activity_duplicate_groups",
    groupRows,
    version,
    refreshedAt,
    artifact.bounds.batchSize,
  );
  await insertRollbackRows(
    clickHouse,
    "analytics.deduped_activities",
    dedupedRows,
    version,
    refreshedAt,
    artifact.bounds.batchSize,
  );
  await insertRollbackRows(
    clickHouse,
    "analytics.deduped_activity_members",
    memberRows,
    version,
    refreshedAt,
    artifact.bounds.batchSize,
  );
  await insertRollbackRows(
    clickHouse,
    "analytics.activity_sensor_summary_rows",
    sensorSummaryRows,
    version,
    refreshedAt,
    artifact.bounds.batchSize,
  );
  await insertRollbackRows(
    clickHouse,
    "analytics.activity_summary_rows",
    summaryRows,
    version,
    refreshedAt,
    artifact.bounds.batchSize,
  );
  const verified = await snapshotDerivedRows(clickHouse, artifact.userId, affectedIds);
  if (
    !restoredRowsEqual(verified.sourceRows, artifact.sourceRowsBefore, version) ||
    !restoredRowsEqual(verified.matchRows, artifact.matchRowsBefore, version) ||
    !restoredRowsEqual(verified.groupRows, artifact.groupRowsBefore, version) ||
    !restoredRowsEqual(verified.dedupedRows, artifact.dedupedRowsBefore, version) ||
    !restoredRowsEqual(verified.memberRows, artifact.memberRowsBefore, version) ||
    !restoredRowsEqual(verified.sensorSummaryRows, artifact.sensorSummaryRowsBefore, version) ||
    !restoredRowsEqual(verified.summaryRows, artifact.summaryRowsBefore, version)
  ) {
    throw new Error("rollback FINAL verification did not expose the captured derived values");
  }
  const lifecycle = await snapshotDerivedRows(clickHouse, artifact.userId, affectedIds, true);
  if (
    !restoredRowsEqual(lifecycle.sourceRows, sourceRows, version) ||
    !restoredRowsEqual(lifecycle.matchRows, matchRows, version) ||
    !restoredRowsEqual(lifecycle.groupRows, groupRows, version) ||
    !restoredRowsEqual(lifecycle.dedupedRows, dedupedRows, version) ||
    !restoredRowsEqual(lifecycle.memberRows, memberRows, version) ||
    !restoredRowsEqual(lifecycle.sensorSummaryRows, sensorSummaryRows, version) ||
    !restoredRowsEqual(lifecycle.summaryRows, summaryRows, version)
  ) {
    throw new Error("rollback FINAL lifecycle verification did not expose every tombstone");
  }
  await replacePrivateJson(
    artifactPath,
    {
      ...artifact,
      phase: "rolled_back",
      rollbackEligibility: "not_applicable",
      rollback: { completedAt: completedAt.toISOString(), refreshVersion: version },
    },
    dependencies.generateRunId ?? randomUUID,
  );
  return { runId: artifact.runId, updated, refreshVersion: version };
}

export async function rollbackActivityDataIntegrity(
  db: ActivityIntegrityDatabase,
  clickHouse: ActivityIntegrityClickHouseClient,
  artifactPath: string,
  dependencies: ActivityIntegrityRollbackDependencies = {},
): Promise<ActivityIntegrityRollbackResult> {
  return withActivityIntegrityLease(db, () =>
    rollbackActivityDataIntegrityWithLease(db, clickHouse, artifactPath, dependencies),
  );
}

export async function retireActivityDataIntegrityArtifact(
  artifactPath: string,
  input: { acceptedBy: string; disposition: "accepted" | "superseded" },
  dependencies: ActivityIntegrityRetirementDependencies = {},
): Promise<string> {
  const artifact = await readArtifact(artifactPath);
  if (
    artifact.phase !== "executed" ||
    artifact.rollbackEligibility !== "eligible" ||
    !artifact.acceptance
  ) {
    throw new Error("audit artifact is not rollback-eligible");
  }
  if (input.acceptedBy.trim() !== artifact.acceptance.owner) {
    throw new Error(`artifact must be retired by acceptance owner ${artifact.acceptance.owner}`);
  }
  const retiredAt = (dependencies.now ?? (() => new Date()))();
  if (input.disposition === "accepted" && retiredAt > new Date(artifact.acceptance.deadline)) {
    throw new Error(
      "acceptance deadline has passed; rollback or explicitly supersede the artifact",
    );
  }
  const receiptPath = retirementReceiptPath(artifactPath);
  await writeNewPrivateJson(receiptPath, {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    runId: artifact.runId,
    artifactPath: resolve(artifactPath),
    acceptedBy: input.acceptedBy.trim(),
    disposition: input.disposition,
    retiredAt: retiredAt.toISOString(),
    rollbackEligibility: "retired",
  });
  return receiptPath;
}
