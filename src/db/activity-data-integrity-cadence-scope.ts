import { z } from "zod";
import {
  type ActivityIntegrityClickHouseClient,
  queryClickHouseRows,
  uint64StringSchema,
} from "./activity-data-integrity-clickhouse.ts";
import {
  type ActivityIntegrityScopeInput,
  MAXIMUM_EXPANDED_ACTIVITY_IDS,
  MAXIMUM_EXPANSION_ITERATIONS,
} from "./activity-data-integrity-scope-policy.ts";

const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const identityRow = z.object({ activity_id: uuidSchema.nullable() });

function parameters(input: ActivityIntegrityScopeInput) {
  return {
    userId: input.userId,
    activityIds: input.activityIds,
    analyticsSchema: process.env.DBT_CLICKHOUSE_SCHEMA ?? "analytics",
    mirrorSchema: process.env.DBT_POSTGRES_FITNESS_SOURCE_SCHEMA ?? "postgres_fitness",
  };
}

function boundedIds(ids: readonly string[]): string[] {
  const unique = [...new Set(ids.map((id) => uuidSchema.parse(id).toLowerCase()))].sort();
  if (unique.length > MAXIMUM_EXPANDED_ACTIVITY_IDS) {
    throw new Error(
      `activity integrity expansion exceeded ${MAXIMUM_EXPANDED_ACTIVITY_IDS} activities`,
    );
  }
  return unique;
}

async function cadenceTargetExists(client: ActivityIntegrityClickHouseClient): Promise<boolean> {
  const rows = await queryClickHouseRows(
    client,
    z.object({ name: z.literal("activity_step_cadence_rows") }),
    `SELECT name FROM system.tables WHERE database = {analyticsSchema:String} AND name = 'activity_step_cadence_rows'`,
    { analyticsSchema: process.env.DBT_CLICKHOUSE_SCHEMA ?? "analytics" },
  );
  return rows.length > 0;
}

export async function readActivityIntegrityCadenceVersions(
  client: ActivityIntegrityClickHouseClient,
  input: ActivityIntegrityScopeInput,
): Promise<Map<string, bigint>> {
  if (!(await cadenceTargetExists(client))) return new Map();
  const rows = await queryClickHouseRows(
    client,
    z.object({ activity_id: uuidSchema, refresh_version: uint64StringSchema }),
    `SELECT activity_id, toString(refresh_version) AS refresh_version
     FROM {analyticsSchema:Identifier}.activity_step_cadence_rows FINAL
     WHERE user_id = {userId:UUID} AND activity_id IN {activityIds:Array(UUID)}`,
    parameters(input),
  );
  return new Map(rows.map((row) => [row.activity_id, BigInt(row.refresh_version)]));
}

export async function resolveActivityIntegrityCadenceScope(
  client: ActivityIntegrityClickHouseClient,
  input: ActivityIntegrityScopeInput,
): Promise<{ activityIds: readonly string[]; cadenceActivityIds: readonly string[] }> {
  const userId = uuidSchema.parse(input.userId);
  let activityIds = boundedIds(input.activityIds);
  if (activityIds.length === 0)
    throw new Error("activity integrity refresh requires nonempty activity IDs");
  let converged = false;
  for (let iteration = 0; iteration < MAXIMUM_EXPANSION_ITERATIONS; iteration += 1) {
    // Lifecycle filters intentionally do not erase prior canonical aliases. Only
    // revision siblings follow the macro's current CDC/nonempty-sync predicate.
    const rows = await queryClickHouseRows(
      client,
      identityRow,
      `SELECT expanded_id AS activity_id FROM (
      SELECT arrayJoin([id, group_id]) AS expanded_id
      FROM {mirrorSchema:Identifier}.activity FINAL
      WHERE user_id = {userId:UUID}
        AND (id IN {activityIds:Array(UUID)} OR group_id IN {activityIds:Array(UUID)})
      UNION DISTINCT
      SELECT arrayJoin([activity_id, group_id]) AS expanded_id
      FROM {analyticsSchema:Identifier}.activity_source_records FINAL
      WHERE user_id = {userId:UUID}
        AND (activity_id IN {activityIds:Array(UUID)} OR group_id IN {activityIds:Array(UUID)})
      UNION DISTINCT
      SELECT arrayJoin([g.activity_id, g.group_id]) AS expanded_id
      FROM {analyticsSchema:Identifier}.activity_duplicate_groups AS g FINAL
      INNER JOIN {analyticsSchema:Identifier}.activity_source_records AS s FINAL
        ON s.activity_id = g.activity_id AND s.user_id = {userId:UUID}
      WHERE g.activity_id IN {activityIds:Array(UUID)} OR g.group_id IN {activityIds:Array(UUID)}
      UNION DISTINCT
      SELECT arrayJoin(arrayConcat([activity_id], member_activity_ids)) AS expanded_id
      FROM {analyticsSchema:Identifier}.deduped_activities FINAL
      WHERE user_id = {userId:UUID}
        AND (activity_id IN {activityIds:Array(UUID)} OR hasAny(member_activity_ids, {activityIds:Array(UUID)}))
      UNION DISTINCT
      SELECT arrayJoin([activity_id, member_activity_id]) AS expanded_id
      FROM {analyticsSchema:Identifier}.deduped_activity_members FINAL
      WHERE user_id = {userId:UUID}
        AND (activity_id IN {activityIds:Array(UUID)} OR member_activity_id IN {activityIds:Array(UUID)})
      UNION DISTINCT
      SELECT arrayJoin([sibling.id, sibling.group_id]) AS expanded_id
      FROM {mirrorSchema:Identifier}.activity AS sibling FINAL
      WHERE sibling.user_id = {userId:UUID} AND sibling._peerdb_is_deleted = 0
        AND sibling.provider_id = 'apple_health'
        AND trim(BOTH ' ' FROM JSON_VALUE(coalesce(sibling.raw, '{}'), '$.metadata.HKMetadataKeySyncIdentifier')) != ''
        AND trim(BOTH ' ' FROM JSON_VALUE(coalesce(sibling.raw, '{}'), '$.metadata.HKMetadataKeySyncIdentifier')) IN (
          SELECT trim(BOTH ' ' FROM JSON_VALUE(coalesce(requested.raw, '{}'), '$.metadata.HKMetadataKeySyncIdentifier'))
          FROM {mirrorSchema:Identifier}.activity AS requested FINAL
          WHERE requested.user_id = {userId:UUID} AND requested._peerdb_is_deleted = 0
            AND requested.provider_id = 'apple_health'
            AND (requested.id IN {activityIds:Array(UUID)} OR requested.group_id IN {activityIds:Array(UUID)})
        )
      )`,
      parameters({ userId, activityIds }),
    );
    const expanded = boundedIds([
      ...activityIds,
      ...rows.flatMap((row) => (row.activity_id ? [row.activity_id] : [])),
    ]);
    if (expanded.length === activityIds.length) {
      converged = true;
      break;
    }
    activityIds = expanded;
  }
  if (!converged) {
    throw new Error(
      `activity integrity expansion did not reach a fixpoint within ${MAXIMUM_EXPANSION_ITERATIONS} iterations`,
    );
  }
  const live = await queryClickHouseRows(
    client,
    z.object({ activity_id: uuidSchema }),
    `
    SELECT activity_id FROM {analyticsSchema:Identifier}.deduped_activities FINAL
    WHERE user_id = {userId:UUID} AND is_deleted = 0 AND canonical_type = 'running'
      AND (activity_id IN {activityIds:Array(UUID)} OR hasAny(member_activity_ids, {activityIds:Array(UUID)}))`,
    parameters({ userId, activityIds }),
  );
  const previous = await readActivityIntegrityCadenceVersions(client, { userId, activityIds });
  return {
    activityIds,
    cadenceActivityIds: boundedIds([...live.map((row) => row.activity_id), ...previous.keys()]),
  };
}

export async function verifyActivityIntegrityCadenceBatch(
  client: ActivityIntegrityClickHouseClient,
  input: ActivityIntegrityScopeInput,
  before: ReadonlyMap<string, bigint>,
): Promise<void> {
  if (!(await cadenceTargetExists(client))) {
    throw new Error("activity integrity cadence build did not create activity_step_cadence_rows");
  }
  const after = await readActivityIntegrityCadenceVersions(client, input);
  for (const activityId of input.activityIds) {
    const current = after.get(activityId);
    const previous = before.get(activityId);
    if (current === undefined || (previous !== undefined && current <= previous)) {
      throw new Error(`activity integrity cadence build left missing or stale key ${activityId}`);
    }
  }
}
