import { z } from "zod";

const MAXIMUM_UINT64 = (1n << 64n) - 1n;
const DEFAULT_CDC_READINESS_TIMEOUT_MS = 120_000;
const DEFAULT_CDC_READINESS_POLL_INTERVAL_MS = 2_000;
const postgresUuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "must be a UUID");

export const uint64StringSchema = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative().safe()])
  .transform((value) => String(value))
  .refine((value) => BigInt(value) <= MAXIMUM_UINT64, "refresh_version exceeds UInt64");

export const clickHouseSourceRowSchema = z
  .object({
    activity_id: postgresUuidSchema,
    provider_id: z.string().min(1),
    user_id: postgresUuidSchema,
    canonical_type: z.string().min(1),
    refresh_version: uint64StringSchema,
    is_deleted: z.coerce.number().int().min(0).max(1),
  })
  .passthrough();

export const clickHouseGroupRowSchema = z
  .object({
    activity_id: postgresUuidSchema,
    group_id: z.string().nullable(),
    refresh_version: uint64StringSchema,
    is_deleted: z.coerce.number().int().min(0).max(1),
  })
  .passthrough();

export const clickHouseMatchRowSchema = z
  .object({
    activity_id: postgresUuidSchema,
    duplicate_activity_id: postgresUuidSchema,
    refresh_version: uint64StringSchema,
    is_deleted: z.coerce.number().int().min(0).max(1),
  })
  .passthrough();

export const clickHouseDerivedActivityRowSchema = z
  .object({
    activity_id: postgresUuidSchema,
    user_id: postgresUuidSchema,
    refresh_version: uint64StringSchema,
    is_deleted: z.coerce.number().int().min(0).max(1),
  })
  .passthrough();

export const clickHouseDedupedActivityRowSchema = clickHouseDerivedActivityRowSchema.extend({
  provider_id: z.string().min(1),
  canonical_type: z.string().min(1),
  member_activity_ids: z.array(postgresUuidSchema),
});

export const clickHouseDerivedMemberRowSchema = clickHouseDerivedActivityRowSchema.extend({
  member_activity_id: postgresUuidSchema,
});

export const componentSchema = z.object({
  groupId: z.string(),
  memberActivityIds: z.array(postgresUuidSchema),
});

export type ClickHouseSourceRow = z.infer<typeof clickHouseSourceRowSchema>;
export type ClickHouseMatchRow = z.infer<typeof clickHouseMatchRowSchema>;
export type ClickHouseGroupRow = z.infer<typeof clickHouseGroupRowSchema>;
export type ClickHouseDerivedActivityRow = z.infer<typeof clickHouseDerivedActivityRowSchema>;
export type ClickHouseDedupedActivityRow = z.infer<typeof clickHouseDedupedActivityRowSchema>;
export type ClickHouseDerivedMemberRow = z.infer<typeof clickHouseDerivedMemberRowSchema>;

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

export interface DerivedSnapshot {
  sourceRows: ClickHouseSourceRow[];
  matchRows: ClickHouseMatchRow[];
  groupRows: ClickHouseGroupRow[];
  dedupedRows: ClickHouseDedupedActivityRow[];
  memberRows: ClickHouseDerivedMemberRow[];
  sensorSummaryRows: ClickHouseDerivedActivityRow[];
  summaryRows: ClickHouseDerivedActivityRow[];
  components: Array<z.infer<typeof componentSchema>>;
  highestVersion: string;
  activityIds: string[];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export async function queryClickHouseRows<T extends object>(
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

export async function snapshotDerivedRows(
  client: ActivityIntegrityClickHouseClient,
  userId: string,
  selectedActivityIds: readonly string[],
  includeDeleted = false,
): Promise<DerivedSnapshot> {
  if (selectedActivityIds.length === 0) {
    return {
      sourceRows: [],
      matchRows: [],
      groupRows: [],
      dedupedRows: [],
      memberRows: [],
      sensorSummaryRows: [],
      summaryRows: [],
      components: [],
      highestVersion: "0",
      activityIds: [],
    };
  }
  const selectedIds = unique(selectedActivityIds);
  const lifecycleFilter = includeDeleted ? "" : "AND is_deleted = 0";
  const queryMatchRows = (activityIds: readonly string[]) =>
    queryClickHouseRows(
      client,
      clickHouseMatchRowSchema,
      `SELECT duplicate_matches.* REPLACE(
  toString(duplicate_matches.refresh_version) AS refresh_version
)
FROM analytics.activity_duplicate_matches AS duplicate_matches FINAL
WHERE (
    duplicate_matches.activity_id IN {activityIds:Array(UUID)}
    OR duplicate_matches.duplicate_activity_id IN {activityIds:Array(UUID)}
  )
  ${includeDeleted ? "" : "AND duplicate_matches.is_deleted = 0"}
ORDER BY duplicate_matches.activity_id, duplicate_matches.duplicate_activity_id`,
      { activityIds },
    );
  const queryGroupRows = (activityIds: readonly string[]) =>
    queryClickHouseRows(
      client,
      clickHouseGroupRowSchema,
      `WITH selected_groups AS (
  SELECT group_id
  FROM analytics.activity_duplicate_groups FINAL
  WHERE activity_id IN {activityIds:Array(UUID)}
    ${lifecycleFilter}
)
SELECT duplicate_groups.* REPLACE(
  toString(duplicate_groups.refresh_version) AS refresh_version
)
FROM analytics.activity_duplicate_groups AS duplicate_groups FINAL
WHERE (
    duplicate_groups.activity_id IN {activityIds:Array(UUID)}
    OR duplicate_groups.group_id IN (SELECT group_id FROM selected_groups)
  )
  ${includeDeleted ? "" : "AND duplicate_groups.is_deleted = 0"}
ORDER BY duplicate_groups.activity_id`,
      { activityIds },
    );

  let activityIds = selectedIds;
  let matchRows: ClickHouseMatchRow[] = [];
  let groupRows: ClickHouseGroupRow[] = [];
  while (true) {
    matchRows = await queryMatchRows(activityIds);
    groupRows = await queryGroupRows(activityIds);
    const expandedActivityIds = unique([
      ...activityIds,
      ...matchRows.flatMap((row) => [row.activity_id, row.duplicate_activity_id]),
      ...groupRows.map((row) => row.activity_id),
    ]);
    if (expandedActivityIds.length === activityIds.length) break;
    activityIds = expandedActivityIds;
  }
  const sourceRows = await queryClickHouseRows(
    client,
    clickHouseSourceRowSchema,
    `SELECT source_records.* REPLACE(
  toString(source_records.refresh_version) AS refresh_version
)
FROM analytics.activity_source_records AS source_records FINAL
WHERE source_records.user_id = {userId:UUID}
  AND source_records.activity_id IN {activityIds:Array(UUID)}
  ${includeDeleted ? "" : "AND source_records.is_deleted = 0"}
ORDER BY source_records.activity_id`,
    { userId, activityIds },
  );
  const dedupedRows = await queryClickHouseRows(
    client,
    clickHouseDedupedActivityRowSchema,
    `SELECT deduped.* REPLACE(toString(deduped.refresh_version) AS refresh_version)
FROM analytics.deduped_activities AS deduped FINAL
WHERE deduped.user_id = {userId:UUID}
  AND (
    deduped.activity_id IN {activityIds:Array(UUID)}
    OR hasAny(deduped.member_activity_ids, {activityIds:Array(UUID)})
  )
  ${includeDeleted ? "" : "AND deduped.is_deleted = 0"}
ORDER BY deduped.activity_id`,
    { userId, activityIds },
  );
  const canonicalActivityIds = unique([
    ...activityIds,
    ...dedupedRows.map((row) => row.activity_id),
  ]);
  const memberRows = await queryClickHouseRows(
    client,
    clickHouseDerivedMemberRowSchema,
    `SELECT members.* REPLACE(toString(members.refresh_version) AS refresh_version)
FROM analytics.deduped_activity_members AS members FINAL
WHERE members.user_id = {userId:UUID}
  AND (
    members.member_activity_id IN {activityIds:Array(UUID)}
    OR members.activity_id IN {canonicalActivityIds:Array(UUID)}
  )
  ${includeDeleted ? "" : "AND members.is_deleted = 0"}
ORDER BY members.member_activity_id`,
    { userId, activityIds, canonicalActivityIds },
  );
  const sensorSummaryRows = await queryClickHouseRows(
    client,
    clickHouseDerivedActivityRowSchema,
    `SELECT summary.* REPLACE(toString(summary.refresh_version) AS refresh_version)
FROM analytics.activity_sensor_summary_rows AS summary FINAL
WHERE summary.user_id = {userId:UUID}
  AND summary.activity_id IN {canonicalActivityIds:Array(UUID)}
  ${includeDeleted ? "" : "AND summary.is_deleted = 0"}
ORDER BY summary.activity_id`,
    { userId, canonicalActivityIds },
  );
  const summaryRows = await queryClickHouseRows(
    client,
    clickHouseDerivedActivityRowSchema,
    `SELECT summary.* REPLACE(toString(summary.refresh_version) AS refresh_version)
FROM analytics.activity_summary_rows AS summary FINAL
WHERE summary.user_id = {userId:UUID}
  AND summary.activity_id IN {canonicalActivityIds:Array(UUID)}
  ${includeDeleted ? "" : "AND summary.is_deleted = 0"}
ORDER BY summary.activity_id`,
    { userId, canonicalActivityIds },
  );
  return {
    sourceRows,
    matchRows,
    groupRows,
    dedupedRows,
    memberRows,
    sensorSummaryRows,
    summaryRows,
    components: buildComponents(groupRows),
    highestVersion: maxVersion([
      ...sourceRows,
      ...matchRows,
      ...groupRows,
      ...dedupedRows,
      ...memberRows,
      ...sensorSummaryRows,
      ...summaryRows,
    ]),
    activityIds,
  };
}

export function incompatibleMemberCount(snapshot: DerivedSnapshot): number {
  const sourceById = new Map(snapshot.sourceRows.map((row) => [row.activity_id, row]));
  let count = 0;
  for (const deduped of snapshot.dedupedRows) {
    for (const memberActivityId of deduped.member_activity_ids) {
      const member = sourceById.get(memberActivityId);
      if (!member) continue;
      if (
        member.canonical_type !== deduped.canonical_type ||
        (deduped.canonical_type === "other" && member.provider_id !== deduped.provider_id)
      ) {
        count += 1;
      }
    }
  }
  return count;
}

interface RepairedActivityLocalTime {
  id: string;
  repaired: {
    timezone: string | null;
    startUtcOffsetMinutes: number | null;
    endUtcOffsetMinutes: number | null;
    localTimeSource: string;
  };
}

export function sourceRowsMatchPostgres(
  sourceRows: ClickHouseSourceRow[],
  repairedRows: readonly RepairedActivityLocalTime[],
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

interface CdcReadinessDependencies {
  cdcReadinessTimeoutMs?: number;
  cdcReadinessPollIntervalMs?: number;
  monotonicNow?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

export async function waitForPostgresMirror(
  clickHouse: ActivityIntegrityClickHouseClient,
  userId: string,
  changedRows: readonly RepairedActivityLocalTime[],
  dependencies: CdcReadinessDependencies,
): Promise<void> {
  const monotonicNow = dependencies.monotonicNow ?? Date.now;
  const timeoutMs = dependencies.cdcReadinessTimeoutMs ?? DEFAULT_CDC_READINESS_TIMEOUT_MS;
  const pollIntervalMs =
    dependencies.cdcReadinessPollIntervalMs ?? DEFAULT_CDC_READINESS_POLL_INTERVAL_MS;
  const sleep = dependencies.sleep ?? defaultSleep;
  const deadline = monotonicNow() + timeoutMs;
  while (true) {
    const mirroredRows = await queryClickHouseRows(
      clickHouse,
      clickHouseSourceRowSchema,
      `SELECT
  activity.id AS activity_id,
  activity.provider_id AS provider_id,
  activity.user_id AS user_id,
  activity.canonical_type AS canonical_type,
  activity.timezone AS timezone,
  activity.start_utc_offset_minutes AS start_utc_offset_minutes,
  activity.end_utc_offset_minutes AS end_utc_offset_minutes,
  activity.local_time_source AS local_time_source,
  toString(toUInt64(toUnixTimestamp64Nano(activity._peerdb_synced_at))) AS refresh_version,
  toUInt8(activity._peerdb_is_deleted) AS is_deleted
FROM postgres_fitness.activity AS activity FINAL
WHERE activity.user_id = {userId:UUID}
  AND activity.id IN {activityIds:Array(UUID)}
ORDER BY activity.id`,
      { userId, activityIds: changedRows.map((row) => row.id) },
    );
    if (sourceRowsMatchPostgres(mirroredRows, changedRows)) return;
    if (monotonicNow() >= deadline) {
      throw new Error(
        `PostgreSQL CDC mirror did not publish ${changedRows.length} repaired activities within ${timeoutMs}ms`,
      );
    }
    await sleep(pollIntervalMs);
  }
}
