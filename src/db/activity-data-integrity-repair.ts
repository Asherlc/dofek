import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveProviderTimezoneLocalTimeContext } from "@dofek/format/record-local-time";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  type ActivityIntegrityClickHouseClient,
  assertActivityIntegrityRebuild,
  clickHouseDedupedActivityRowSchema,
  clickHouseDerivedActivityRowSchema,
  clickHouseDerivedMemberRowSchema,
  clickHouseGroupRowSchema,
  clickHouseMatchRowSchema,
  clickHouseSourceRowSchema,
  componentSchema,
  type DerivedSnapshot,
  incompatibleMemberCount,
  snapshotDerivedRows,
  snapshotDerivedRowsOrNull,
  sourceRowsMatchPostgres,
  uint64StringSchema,
  waitForPostgresMirror,
} from "./activity-data-integrity-clickhouse.ts";
import { runActivityIntegrityDbtBuild } from "./activity-data-integrity-dbt.ts";
import {
  assertNoEligibleActivityIntegrityJournal,
  createPostgresCommittedActivityIntegrityJournal,
  readActivityIntegrityJournal,
  retireActivityIntegrityJournal,
  transitionActivityIntegrityJournal,
} from "./activity-data-integrity-journal.ts";
import { withActivityIntegrityLease } from "./activity-data-integrity-lease.ts";
import {
  type ActivityIntegrityRetirementReceipt,
  activityIntegrityRetirementReceiptPath,
  makeActivityIntegrityRetirementReceipt,
  materializeActivityIntegrityRetirementReceipt,
} from "./activity-data-integrity-retirement-receipt.ts";
import { executeWithSchema, type SchemaExecutionDatabase } from "./typed-sql.ts";

const MAXIMUM_BATCH_SIZE = 1_000;
const AUDIT_SCHEMA_VERSION = 2;
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

const acceptanceSchema = z.object({ owner: z.string().min(1), deadline: z.string().datetime() });

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
    "rollback_committed",
    "rolled_back",
  ]),
  rollbackEligibility: z.enum(["not_applicable", "eligible"]),
  artifactChecksum: z.string().regex(/^[0-9a-f]{64}$/),
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
  acceptance: acceptanceSchema.nullable(),
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
      snapshot: z.object(capturedDerivedRowsSchema).nullable(),
    })
    .optional(),
  rollback: z
    .object({ completedAt: z.string().datetime(), refreshVersion: uint64StringSchema })
    .optional(),
  rollbackCommit: z
    .object({ completedAt: z.string().datetime(), updated: z.number().int().nonnegative() })
    .optional(),
});

type PostgresCandidate = z.infer<typeof postgresCandidateSchema>;
type PostgresArtifactRow = z.infer<typeof postgresArtifactRowSchema>;
type AuditArtifact = z.infer<typeof auditArtifactSchema>;
type AuditArtifactWithoutChecksum = Omit<AuditArtifact, "artifactChecksum">;

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
  rebuildReadModels?: (input: { userId: string; activityIds: readonly string[] }) => Promise<void>;
  cdcReadinessTimeoutMs?: number;
  cdcReadinessPollIntervalMs?: number;
  monotonicNow?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
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
function serializeJson(value: unknown): string {
  return `${JSON.stringify(
    value,
    (_key, nestedValue: unknown) =>
      typeof nestedValue === "bigint" ? nestedValue.toString() : nestedValue,
    2,
  )}\n`;
}
function recoveryArtifactData(artifact: AuditArtifactWithoutChecksum | AuditArtifact) {
  return {
    schemaVersion: artifact.schemaVersion,
    runId: artifact.runId,
    createdAt: artifact.createdAt,
    userId: artifact.userId,
    window: artifact.window,
    bounds: artifact.bounds,
    acceptance: artifact.acceptance,
    selected: artifact.selected,
    changedActivityIds: artifact.changedActivityIds,
    highestDerivedVersion: artifact.highestDerivedVersion,
    postgresActivities: artifact.postgresActivities,
    sourceRowsBefore: artifact.sourceRowsBefore,
    matchRowsBefore: artifact.matchRowsBefore,
    groupRowsBefore: artifact.groupRowsBefore,
    dedupedRowsBefore: artifact.dedupedRowsBefore,
    memberRowsBefore: artifact.memberRowsBefore,
    sensorSummaryRowsBefore: artifact.sensorSummaryRowsBefore,
    summaryRowsBefore: artifact.summaryRowsBefore,
    componentsBefore: artifact.componentsBefore,
  };
}
function checksumArtifact(artifact: AuditArtifactWithoutChecksum | AuditArtifact): string {
  return createHash("sha256")
    .update(serializeJson(recoveryArtifactData(artifact)))
    .digest("hex");
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
  const artifact = auditArtifactSchema.parse(raw);
  if (checksumArtifact(artifact) !== artifact.artifactChecksum) {
    throw new Error("activity integrity audit artifact checksum does not match its recovery data");
  }
  return artifact;
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
  userId: string,
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
              AND activity.user_id = ${userId}::uuid
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
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  if (options.execute) await assertNoEligibleActivityIntegrityJournal(db);

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
    ? acceptanceSchema.parse({
        owner: options.acceptanceOwner?.trim(),
        deadline: options.acceptanceDeadline?.toISOString(),
      })
    : null;
  const artifactWithoutChecksum: AuditArtifactWithoutChecksum = {
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
  const artifact: AuditArtifact = {
    ...artifactWithoutChecksum,
    artifactChecksum: checksumArtifact(artifactWithoutChecksum),
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
      incompatibleMemberCount: incompatibleMemberCount(before),
      beforeComponentCount: before.components.length,
      afterComponentCount: before.components.length,
      artifactPath,
    };
  }

  if (!artifact.acceptance) throw new Error("execute artifact is missing acceptance ownership");
  const acceptedRepair = artifact.acceptance;
  const updated = await db.transaction(async (transaction) => {
    const updatedRows = await updatePostgresActivities(
      transaction,
      options.userId,
      changedRows,
      options.batchSize,
      "repair",
    );
    await createPostgresCommittedActivityIntegrityJournal(transaction, {
      runId,
      userId: options.userId,
      artifactPath,
      artifactChecksum: artifact.artifactChecksum,
      acceptanceOwner: acceptedRepair.owner,
      acceptanceDeadline: new Date(acceptedRepair.deadline),
      createdAt,
    });
    return updatedRows;
  });
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
    const incompatibleMembers = incompatibleMemberCount(after);
    if (incompatibleMembers > 0) {
      throw new Error(
        `activity integrity rebuild retained ${incompatibleMembers} incompatible canonical member${incompatibleMembers === 1 ? "" : "s"}`,
      );
    }
    assertActivityIntegrityRebuild(before, after);
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
    await transitionActivityIntegrityJournal(db, {
      runId,
      artifactPath,
      artifactChecksum: artifact.artifactChecksum,
      from: ["postgres_committed"],
      to: "executed",
      transitionedAt: now(),
    });

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
    const failedState = await snapshotDerivedRowsOrNull(
      clickHouse,
      options.userId,
      before.activityIds,
    );
    const failed: AuditArtifact = {
      ...postgresCommitted,
      phase: "rebuild_failed",
      failure: {
        failedAt: now().toISOString(),
        stage: failureStage,
        message: errorMessage(error),
        snapshot: failedState ? capturedDerivedRows(failedState) : null,
      },
    };
    await replacePrivateJson(artifactPath, failed, generateRunId);
    await transitionActivityIntegrityJournal(db, {
      runId,
      artifactPath,
      artifactChecksum: artifact.artifactChecksum,
      from: ["postgres_committed"],
      to: "rebuild_failed",
      transitionedAt: now(),
    });
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

interface CapturedPostState {
  sourceRowsAfter: DerivedSnapshot["sourceRows"];
  matchRowsAfter: DerivedSnapshot["matchRows"];
  groupRowsAfter: DerivedSnapshot["groupRows"];
  dedupedRowsAfter: DerivedSnapshot["dedupedRows"];
  memberRowsAfter: DerivedSnapshot["memberRows"];
  sensorSummaryRowsAfter: DerivedSnapshot["sensorSummaryRows"];
  summaryRowsAfter: DerivedSnapshot["summaryRows"];
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
  if (artifact.failure?.snapshot) addSnapshotActivityIds(activityIds, artifact.failure.snapshot);
  return [...activityIds];
}

async function rollbackActivityDataIntegrityWithLease(
  db: ActivityIntegrityDatabase,
  clickHouse: ActivityIntegrityClickHouseClient,
  artifactPath: string,
  dependencies: ActivityIntegrityRollbackDependencies = {},
): Promise<ActivityIntegrityRollbackResult> {
  const artifact = await readArtifact(artifactPath);
  const journal = await readActivityIntegrityJournal(db, artifact.runId);
  if (
    resolve(journal.artifact_path) !== resolve(artifactPath) ||
    journal.artifact_checksum !== artifact.artifactChecksum ||
    journal.user_id !== artifact.userId ||
    journal.acceptance_owner !== artifact.acceptance?.owner ||
    journal.acceptance_deadline.toISOString() !== artifact.acceptance?.deadline
  ) {
    throw new Error("activity integrity repair journal does not match the audit artifact");
  }
  if (journal.phase === "retired") {
    throw new Error("retired audit artifact is not rollback-eligible");
  }
  if (
    !["postgres_committed", "rebuild_failed", "executed", "rollback_committed"].includes(
      journal.phase,
    )
  ) {
    throw new Error("audit artifact is not rollback-eligible");
  }
  const affectedIds = affectedArtifactActivityIds(artifact);
  const changedRows = artifact.postgresActivities.filter((row) =>
    artifact.changedActivityIds.includes(row.id),
  );
  const now = dependencies.now ?? (() => new Date());
  const generateRunId = dependencies.generateRunId ?? randomUUID;
  let updated = changedRows.length;
  let rollbackCommit = artifact.rollbackCommit;
  if (journal.phase !== "rollback_committed") {
    const committedAt = now();
    updated = await db.transaction(async (transaction) => {
      const updatedRows = await updatePostgresActivities(
        transaction,
        artifact.userId,
        changedRows,
        artifact.bounds.batchSize,
        "rollback",
      );
      await transitionActivityIntegrityJournal(transaction, {
        runId: artifact.runId,
        artifactPath,
        artifactChecksum: artifact.artifactChecksum,
        from: [journal.phase],
        to: "rollback_committed",
        transitionedAt: committedAt,
      });
      return updatedRows;
    });
    rollbackCommit = { completedAt: committedAt.toISOString(), updated };
    await replacePrivateJson(
      artifactPath,
      { ...artifact, phase: "rollback_committed", rollbackCommit },
      generateRunId,
    );
  }

  const rollbackMirrorRows = changedRows.map((row) => ({ id: row.id, repaired: row.prior }));
  await waitForPostgresMirror(clickHouse, artifact.userId, rollbackMirrorRows, dependencies);
  const rebuildReadModels = dependencies.rebuildReadModels ?? runActivityIntegrityDbtBuild;
  await rebuildReadModels({ userId: artifact.userId, activityIds: affectedIds });
  const verified = await snapshotDerivedRows(clickHouse, artifact.userId, affectedIds);
  if (!sourceRowsMatchPostgres(verified.sourceRows, rollbackMirrorRows)) {
    throw new Error("rollback rebuild did not publish the restored local-time context");
  }
  const version = verified.highestVersion;
  const completedAt = now();
  await replacePrivateJson(
    artifactPath,
    {
      ...artifact,
      phase: "rolled_back",
      rollbackEligibility: "not_applicable",
      rollbackCommit,
      rollback: { completedAt: completedAt.toISOString(), refreshVersion: version },
    },
    generateRunId,
  );
  await transitionActivityIntegrityJournal(db, {
    runId: artifact.runId,
    artifactPath,
    artifactChecksum: artifact.artifactChecksum,
    from: ["rollback_committed"],
    to: "rolled_back",
    transitionedAt: completedAt,
  });
  return { runId: artifact.runId, updated, refreshVersion: version };
}

export async function rollbackActivityDataIntegrity(
  db: ActivityIntegrityDatabase,
  clickHouse: ActivityIntegrityClickHouseClient,
  artifactPath: string,
  dependencies: ActivityIntegrityRollbackDependencies = {},
): Promise<ActivityIntegrityRollbackResult> {
  const resolvedArtifactPath = resolve(artifactPath);
  return withActivityIntegrityLease(db, () =>
    rollbackActivityDataIntegrityWithLease(db, clickHouse, resolvedArtifactPath, dependencies),
  );
}

export async function retireActivityDataIntegrityArtifact(
  db: ActivityIntegrityDatabase,
  artifactPath: string,
  input: { acceptedBy: string; disposition: "accepted" | "superseded" },
  dependencies: ActivityIntegrityRetirementDependencies = {},
): Promise<string> {
  const resolvedArtifactPath = resolve(artifactPath);
  return withActivityIntegrityLease(db, async () => {
    const artifactPath = resolvedArtifactPath;
    const artifact = await readArtifact(artifactPath);
    if (
      artifact.phase !== "executed" ||
      artifact.rollbackEligibility !== "eligible" ||
      !artifact.acceptance
    ) {
      throw new Error("audit artifact is not rollback-eligible");
    }
    const journal = await readActivityIntegrityJournal(db, artifact.runId);
    if (
      resolve(journal.artifact_path) !== resolve(artifactPath) ||
      journal.artifact_checksum !== artifact.artifactChecksum ||
      journal.user_id !== artifact.userId ||
      journal.acceptance_owner !== artifact.acceptance.owner ||
      journal.acceptance_deadline.toISOString() !== artifact.acceptance.deadline
    ) {
      throw new Error("activity integrity repair journal does not match the audit artifact");
    }
    const receiptPath = activityIntegrityRetirementReceiptPath(artifactPath);
    const acceptedBy = input.acceptedBy.trim();
    let receipt: ActivityIntegrityRetirementReceipt;
    if (journal.phase === "executed") {
      if (acceptedBy !== artifact.acceptance.owner) {
        throw new Error(
          `artifact must be retired by acceptance owner ${artifact.acceptance.owner}`,
        );
      }
      const retiredAt = (dependencies.now ?? (() => new Date()))();
      if (input.disposition === "accepted" && retiredAt > new Date(artifact.acceptance.deadline)) {
        throw new Error(
          "acceptance deadline has passed; rollback or explicitly supersede the artifact",
        );
      }
      receipt = makeActivityIntegrityRetirementReceipt({
        schemaVersion: AUDIT_SCHEMA_VERSION,
        runId: artifact.runId,
        artifactPath,
        acceptedBy,
        disposition: input.disposition,
        retiredAt,
      });
      await db.transaction((transaction) =>
        retireActivityIntegrityJournal(transaction, {
          runId: artifact.runId,
          artifactPath,
          artifactChecksum: artifact.artifactChecksum,
          acceptedBy,
          disposition: input.disposition,
          retiredAt,
          receiptPath,
          receiptChecksum: receipt.receiptChecksum,
        }),
      );
    } else if (journal.phase === "retired") {
      if (
        acceptedBy !== journal.accepted_by ||
        input.disposition !== journal.retirement_disposition
      ) {
        throw new Error("retirement retry conflicts with durable retirement decision");
      }
      if (resolve(journal.retirement_receipt_path) !== resolve(receiptPath)) {
        throw new Error("retired activity integrity journal does not match its receipt path");
      }
      receipt = makeActivityIntegrityRetirementReceipt({
        schemaVersion: AUDIT_SCHEMA_VERSION,
        runId: artifact.runId,
        artifactPath,
        acceptedBy: journal.accepted_by,
        disposition: journal.retirement_disposition,
        retiredAt: journal.retired_at,
      });
      if (receipt.receiptChecksum !== journal.retirement_receipt_checksum) {
        throw new Error("retired activity integrity journal does not match its receipt checksum");
      }
    } else {
      throw new Error("audit artifact is not rollback-eligible");
    }
    await materializeActivityIntegrityRetirementReceipt(receiptPath, receipt);
    return receiptPath;
  });
}
