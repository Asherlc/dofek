import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveProviderTimezoneLocalTimeContext } from "@dofek/format/record-local-time";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { runActivityIntegrityDbtBuild } from "./activity-data-integrity-dbt.ts";
import { executeWithSchema, type SchemaExecutionDatabase } from "./typed-sql.ts";

const MAXIMUM_BATCH_SIZE = 1_000;
const MAXIMUM_UINT64 = (1n << 64n) - 1n;
const AUDIT_SCHEMA_VERSION = 1;
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

const uint64StringSchema = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative().safe()])
  .transform((value) => String(value))
  .refine((value) => BigInt(value) <= MAXIMUM_UINT64, "refresh_version exceeds UInt64");

const clickHouseSourceRowSchema = z
  .object({
    activity_id: postgresUuidSchema,
    user_id: postgresUuidSchema,
    refresh_version: uint64StringSchema,
    is_deleted: z.coerce.number().int().min(0).max(1),
  })
  .passthrough();

const clickHouseGroupRowSchema = z
  .object({
    activity_id: postgresUuidSchema,
    group_id: z.string().nullable(),
    refresh_version: uint64StringSchema,
    is_deleted: z.coerce.number().int().min(0).max(1),
  })
  .passthrough();

const clickHouseDerivedActivityRowSchema = z
  .object({
    activity_id: postgresUuidSchema,
    user_id: postgresUuidSchema,
    refresh_version: uint64StringSchema,
    is_deleted: z.coerce.number().int().min(0).max(1),
  })
  .passthrough();

const clickHouseDerivedMemberRowSchema = clickHouseDerivedActivityRowSchema.extend({
  member_activity_id: postgresUuidSchema,
});

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

const componentSchema = z.object({
  groupId: z.string(),
  memberActivityIds: z.array(postgresUuidSchema),
});

const auditArtifactSchema = z.object({
  schemaVersion: z.literal(AUDIT_SCHEMA_VERSION),
  runId: postgresUuidSchema,
  phase: z.enum(["dry_run", "snapshot", "executed"]),
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
  groupRowsBefore: z.array(clickHouseGroupRowSchema),
  dedupedRowsBefore: z.array(clickHouseDerivedActivityRowSchema),
  memberRowsBefore: z.array(clickHouseDerivedMemberRowSchema),
  summaryRowsBefore: z.array(clickHouseDerivedActivityRowSchema),
  componentsBefore: z.array(componentSchema),
  execution: z
    .object({
      completedAt: z.string().datetime(),
      updated: z.number().int().nonnegative(),
      highestDerivedVersion: uint64StringSchema,
      sourceRowsAfter: z.array(clickHouseSourceRowSchema),
      groupRowsAfter: z.array(clickHouseGroupRowSchema),
      dedupedRowsAfter: z.array(clickHouseDerivedActivityRowSchema),
      memberRowsAfter: z.array(clickHouseDerivedMemberRowSchema),
      summaryRowsAfter: z.array(clickHouseDerivedActivityRowSchema),
      componentsAfter: z.array(componentSchema),
    })
    .optional(),
});

type PostgresCandidate = z.infer<typeof postgresCandidateSchema>;
type PostgresArtifactRow = z.infer<typeof postgresArtifactRowSchema>;
type ClickHouseSourceRow = z.infer<typeof clickHouseSourceRowSchema>;
type ClickHouseGroupRow = z.infer<typeof clickHouseGroupRowSchema>;
type ClickHouseDerivedActivityRow = z.infer<typeof clickHouseDerivedActivityRowSchema>;
type ClickHouseDerivedMemberRow = z.infer<typeof clickHouseDerivedMemberRowSchema>;
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

export interface ActivityIntegrityClickHouseClient {
  query(options: {
    query: string;
    format: "JSONEachRow";
    query_params?: Record<string, unknown>;
    clickhouse_settings?: Record<string, string | number | boolean>;
  }): Promise<{ json(): Promise<unknown> }>;
  insert?(options: {
    table: string;
    values: readonly object[];
    format: "JSONEachRow";
  }): Promise<unknown>;
}

export interface ActivityIntegrityDatabase extends SchemaExecutionDatabase {
  transaction<T>(operation: (transaction: SchemaExecutionDatabase) => Promise<T>): Promise<T>;
}

interface ActivityIntegrityRepairDependencies {
  artifactDirectory?: string;
  generateRunId?: () => string;
  now?: () => Date;
  rebuildReadModels?: (input: {
    userId: string;
    startAt: Date;
    endAt: Date;
    batchSize: number;
    maxBatches: number;
    activityIds: readonly string[];
  }) => Promise<void>;
}

interface ActivityIntegrityRollbackDependencies {
  now?: () => Date;
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

interface DerivedSnapshot {
  sourceRows: ClickHouseSourceRow[];
  groupRows: ClickHouseGroupRow[];
  dedupedRows: ClickHouseDerivedActivityRow[];
  memberRows: ClickHouseDerivedMemberRow[];
  summaryRows: ClickHouseDerivedActivityRow[];
  components: Array<z.infer<typeof componentSchema>>;
  highestVersion: string;
  activityIds: string[];
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

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

async function queryClickHouseRows<T extends object>(
  client: ActivityIntegrityClickHouseClient,
  schema: z.ZodType<T>,
  query: string,
  queryParams: Record<string, unknown>,
): Promise<T[]> {
  const response = await client.query({
    query,
    query_params: queryParams,
    format: "JSONEachRow",
    clickhouse_settings: { output_format_json_quote_64bit_integers: 1 },
  });
  return z.array(schema).parse(await response.json());
}

function buildComponents(groupRows: ClickHouseGroupRow[]) {
  const membersByGroup = new Map<string, string[]>();
  for (const row of groupRows) {
    if (row.is_deleted !== 0 || row.group_id == null) continue;
    const members = membersByGroup.get(row.group_id) ?? [];
    members.push(row.activity_id);
    membersByGroup.set(row.group_id, members);
  }
  return [...membersByGroup.entries()]
    .map(([groupId, memberActivityIds]) => ({
      groupId,
      memberActivityIds: unique(memberActivityIds).sort(),
    }))
    .sort((left, right) => left.groupId.localeCompare(right.groupId));
}

function maxVersion(rows: Array<{ refresh_version: string }>): string {
  let highest = 0n;
  for (const row of rows) {
    const version = BigInt(row.refresh_version);
    if (version > highest) highest = version;
  }
  return highest.toString();
}

async function snapshotDerivedRows(
  client: ActivityIntegrityClickHouseClient,
  userId: string,
  selectedActivityIds: readonly string[],
): Promise<DerivedSnapshot> {
  if (selectedActivityIds.length === 0) {
    return {
      sourceRows: [],
      groupRows: [],
      dedupedRows: [],
      memberRows: [],
      summaryRows: [],
      components: [],
      highestVersion: "0",
      activityIds: [],
    };
  }
  const queryParams = { userId, activityIds: unique(selectedActivityIds) };
  const groupRows = await queryClickHouseRows(
    client,
    clickHouseGroupRowSchema,
    `WITH selected_groups AS (
  SELECT group_id
  FROM analytics.activity_duplicate_groups FINAL
  WHERE activity_id IN {activityIds:Array(UUID)}
    AND is_deleted = 0
)
SELECT duplicate_groups.* REPLACE(
  toString(duplicate_groups.refresh_version) AS refresh_version
)
FROM analytics.activity_duplicate_groups AS duplicate_groups FINAL
INNER JOIN analytics.activity_source_records AS source_records FINAL
  ON source_records.activity_id = duplicate_groups.activity_id
WHERE source_records.user_id = {userId:UUID}
  AND source_records.is_deleted = 0
  AND duplicate_groups.is_deleted = 0
  AND (
    duplicate_groups.activity_id IN {activityIds:Array(UUID)}
    OR duplicate_groups.group_id IN (SELECT group_id FROM selected_groups)
  )
ORDER BY duplicate_groups.activity_id`,
    queryParams,
  );
  const activityIds = unique([...selectedActivityIds, ...groupRows.map((row) => row.activity_id)]);
  const sourceRows = await queryClickHouseRows(
    client,
    clickHouseSourceRowSchema,
    `SELECT source_records.* REPLACE(
  toString(source_records.refresh_version) AS refresh_version
)
FROM analytics.activity_source_records AS source_records FINAL
WHERE source_records.user_id = {userId:UUID}
  AND source_records.is_deleted = 0
  AND source_records.activity_id IN {activityIds:Array(UUID)}
ORDER BY source_records.activity_id`,
    { userId, activityIds },
  );
  const dedupedRows = await queryClickHouseRows(
    client,
    clickHouseDerivedActivityRowSchema,
    `SELECT deduped.* REPLACE(toString(deduped.refresh_version) AS refresh_version)
FROM analytics.deduped_activities AS deduped FINAL
WHERE deduped.user_id = {userId:UUID}
  AND deduped.is_deleted = 0
  AND (
    deduped.activity_id IN {activityIds:Array(UUID)}
    OR hasAny(deduped.member_activity_ids, {activityIds:Array(UUID)})
  )
ORDER BY deduped.activity_id`,
    { userId, activityIds },
  );
  const canonicalActivityIds = unique(dedupedRows.map((row) => row.activity_id));
  const memberRows = await queryClickHouseRows(
    client,
    clickHouseDerivedMemberRowSchema,
    `SELECT members.* REPLACE(toString(members.refresh_version) AS refresh_version)
FROM analytics.deduped_activity_members AS members FINAL
WHERE members.user_id = {userId:UUID}
  AND members.is_deleted = 0
  AND (
    members.member_activity_id IN {activityIds:Array(UUID)}
    OR members.activity_id IN {canonicalActivityIds:Array(UUID)}
  )
ORDER BY members.member_activity_id`,
    { userId, activityIds, canonicalActivityIds },
  );
  const summaryRows = await queryClickHouseRows(
    client,
    clickHouseDerivedActivityRowSchema,
    `SELECT summary.* REPLACE(toString(summary.refresh_version) AS refresh_version)
FROM analytics.activity_summary_rows AS summary FINAL
WHERE summary.user_id = {userId:UUID}
  AND summary.is_deleted = 0
  AND summary.activity_id IN {canonicalActivityIds:Array(UUID)}
ORDER BY summary.activity_id`,
    { userId, canonicalActivityIds },
  );
  return {
    sourceRows,
    groupRows,
    dedupedRows,
    memberRows,
    summaryRows,
    components: buildComponents(groupRows),
    highestVersion: maxVersion([
      ...sourceRows,
      ...groupRows,
      ...dedupedRows,
      ...memberRows,
      ...summaryRows,
    ]),
    activityIds,
  };
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

function separatedMemberCount(
  before: Array<z.infer<typeof componentSchema>>,
  after: Array<z.infer<typeof componentSchema>>,
): number {
  const groupAfter = new Map<string, string>();
  for (const component of after) {
    for (const activityId of component.memberActivityIds)
      groupAfter.set(activityId, component.groupId);
  }
  let count = 0;
  for (const component of before) {
    const resultingGroups = new Set(
      component.memberActivityIds.map((activityId) => groupAfter.get(activityId) ?? activityId),
    );
    count += Math.max(0, resultingGroups.size - 1);
  }
  return count;
}

function sourceRowsMatchPostgres(
  sourceRows: ClickHouseSourceRow[],
  repairedRows: readonly PostgresArtifactRow[],
): boolean {
  const sourcesById = new Map(sourceRows.map((row) => [row.activity_id, row]));
  return repairedRows.every((row) => {
    const source = sourcesById.get(row.id);
    return (
      source != null &&
      source.is_deleted === 0 &&
      (source.timezone ?? null) === row.repaired.timezone &&
      (source.start_utc_offset_minutes ?? null) === row.repaired.startUtcOffsetMinutes &&
      (source.end_utc_offset_minutes ?? null) === row.repaired.endUtcOffsetMinutes &&
      source.local_time_source === row.repaired.localTimeSource
    );
  });
}

export async function repairActivityDataIntegrity(
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
    groupRowsBefore: before.groupRows,
    dedupedRowsBefore: before.dedupedRows,
    memberRowsBefore: before.memberRows,
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
          highestDerivedVersion: before.highestVersion,
          sourceRowsAfter: before.sourceRows,
          groupRowsAfter: before.groupRows,
          dedupedRowsAfter: before.dedupedRows,
          memberRowsAfter: before.memberRows,
          summaryRowsAfter: before.summaryRows,
          componentsAfter: before.components,
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
  const rebuildReadModels = dependencies.rebuildReadModels ?? runActivityIntegrityDbtBuild;
  await rebuildReadModels({
    userId: options.userId,
    startAt: options.startAt,
    endAt: options.endAt,
    batchSize: options.batchSize,
    maxBatches: options.maxBatches,
    activityIds: before.activityIds,
  });
  const after = await snapshotDerivedRows(clickHouse, options.userId, before.activityIds);
  if (!sourceRowsMatchPostgres(after.sourceRows, changedRows)) {
    throw new Error("activity integrity rebuild did not publish the repaired local-time context");
  }
  const completed: AuditArtifact = {
    ...artifact,
    phase: "executed",
    execution: {
      completedAt: now().toISOString(),
      updated,
      highestDerivedVersion: after.highestVersion,
      sourceRowsAfter: after.sourceRows,
      groupRowsAfter: after.groupRows,
      dedupedRowsAfter: after.dedupedRows,
      memberRowsAfter: after.memberRows,
      summaryRowsAfter: after.summaryRows,
      componentsAfter: after.components,
    },
  };
  await replacePrivateJson(artifactPath, completed, generateRunId);

  return {
    runId,
    selected: selectedRows.length,
    changed: changedRows.length,
    updated,
    changedIds: changedRows.map((row) => row.id),
    incompatibleMemberCount: separatedMemberCount(before.components, after.components),
    beforeComponentCount: before.components.length,
    afterComponentCount: after.components.length,
    artifactPath,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

function rowsEqual(left: readonly object[], right: readonly object[]): boolean {
  const normalize = (rows: readonly object[]) =>
    rows.map((row) => JSON.stringify(stableValue(row))).sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function restoredRowsEqual(
  current: readonly Record<string, unknown>[],
  captured: readonly Record<string, unknown>[],
  refreshVersion: string,
): boolean {
  if (
    current.some((row) => String(row.refresh_version) !== refreshVersion) ||
    current.length !== captured.length
  ) {
    return false;
  }
  const withoutLifecycle = (rows: readonly Record<string, unknown>[]) =>
    rows.map(({ refresh_version: _version, refreshed_at: _refreshedAt, ...row }) => row);
  return rowsEqual(withoutLifecycle(current), withoutLifecycle(captured));
}

function rowKey(row: Record<string, unknown>, columns: readonly string[]): string {
  return columns.map((column) => String(row[column] ?? "")).join("\u0000");
}

function capturedRowsWithAfterOnlyTombstones(
  before: readonly Record<string, unknown>[],
  after: readonly Record<string, unknown>[],
  keyColumns: readonly string[],
): Record<string, unknown>[] {
  const capturedKeys = new Set(before.map((row) => rowKey(row, keyColumns)));
  return [
    ...before,
    ...after
      .filter((row) => !capturedKeys.has(rowKey(row, keyColumns)))
      .map((row) => ({ ...row, is_deleted: 1 })),
  ];
}

function rollbackVersion(artifact: AuditArtifact, current: DerivedSnapshot): string {
  const candidates = [
    artifact.highestDerivedVersion,
    artifact.execution?.highestDerivedVersion ?? "0",
    current.highestVersion,
  ].map(BigInt);
  const next = candidates.reduce((highest, value) => (value > highest ? value : highest), 0n) + 1n;
  if (next > MAXIMUM_UINT64) throw new Error("cannot allocate a newer UInt64 rollback version");
  return next.toString();
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

export async function rollbackActivityDataIntegrity(
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
    artifact.phase !== "executed" ||
    artifact.rollbackEligibility !== "eligible" ||
    !artifact.execution
  ) {
    throw new Error("audit artifact is not rollback-eligible");
  }
  const affectedIds = unique([
    ...artifact.sourceRowsBefore.map((row) => row.activity_id),
    ...artifact.groupRowsBefore.map((row) => row.activity_id),
    ...artifact.changedActivityIds,
  ]);
  const current = await snapshotDerivedRows(clickHouse, artifact.userId, affectedIds);
  if (
    !rowsEqual(current.sourceRows, artifact.execution.sourceRowsAfter) ||
    !rowsEqual(current.groupRows, artifact.execution.groupRowsAfter) ||
    !rowsEqual(current.dedupedRows, artifact.execution.dedupedRowsAfter) ||
    !rowsEqual(current.memberRows, artifact.execution.memberRowsAfter) ||
    !rowsEqual(current.summaryRows, artifact.execution.summaryRowsAfter)
  ) {
    throw new Error("stale audit artifact: ClickHouse derived state changed after repair");
  }
  const changedRows = artifact.postgresActivities.filter((row) =>
    artifact.changedActivityIds.includes(row.id),
  );
  const updated = await db.transaction((transaction) =>
    updatePostgresActivities(transaction, changedRows, artifact.bounds.batchSize, "rollback"),
  );
  const version = rollbackVersion(artifact, current);
  const refreshedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  await insertRollbackRows(
    clickHouse,
    "analytics.activity_source_records",
    artifact.sourceRowsBefore,
    version,
    refreshedAt,
    artifact.bounds.batchSize,
  );
  await insertRollbackRows(
    clickHouse,
    "analytics.activity_duplicate_groups",
    artifact.groupRowsBefore,
    version,
    refreshedAt,
    artifact.bounds.batchSize,
  );
  await insertRollbackRows(
    clickHouse,
    "analytics.deduped_activities",
    capturedRowsWithAfterOnlyTombstones(
      artifact.dedupedRowsBefore,
      artifact.execution.dedupedRowsAfter,
      ["activity_id"],
    ),
    version,
    refreshedAt,
    artifact.bounds.batchSize,
  );
  await insertRollbackRows(
    clickHouse,
    "analytics.deduped_activity_members",
    capturedRowsWithAfterOnlyTombstones(
      artifact.memberRowsBefore,
      artifact.execution.memberRowsAfter,
      ["user_id", "member_activity_id"],
    ),
    version,
    refreshedAt,
    artifact.bounds.batchSize,
  );
  await insertRollbackRows(
    clickHouse,
    "analytics.activity_summary_rows",
    capturedRowsWithAfterOnlyTombstones(
      artifact.summaryRowsBefore,
      artifact.execution.summaryRowsAfter,
      ["activity_id"],
    ),
    version,
    refreshedAt,
    artifact.bounds.batchSize,
  );
  const verified = await snapshotDerivedRows(clickHouse, artifact.userId, affectedIds);
  if (
    !restoredRowsEqual(verified.sourceRows, artifact.sourceRowsBefore, version) ||
    !restoredRowsEqual(verified.groupRows, artifact.groupRowsBefore, version) ||
    !restoredRowsEqual(verified.dedupedRows, artifact.dedupedRowsBefore, version) ||
    !restoredRowsEqual(verified.memberRows, artifact.memberRowsBefore, version) ||
    !restoredRowsEqual(verified.summaryRows, artifact.summaryRowsBefore, version)
  ) {
    throw new Error("rollback FINAL verification did not expose the captured derived values");
  }
  return { runId: artifact.runId, updated, refreshVersion: version };
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
