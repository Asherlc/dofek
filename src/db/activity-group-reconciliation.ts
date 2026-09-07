import { sql } from "drizzle-orm";
import { z } from "zod";
import { reconcileActivityGroups as decideActivityGroups } from "../domain/activity-grouping.ts";
import { executeWithSchema, type SchemaExecutionDatabase } from "./typed-sql.ts";

const memberSchema = z.object({
  id: z.guid(),
  group_id: z.guid(),
  created_at: z.coerce.date(),
  group_created_at: z.coerce.date(),
  anchor_activity_id: z.guid(),
  overlapping_activity_ids: z.array(z.guid()),
});
const aliasSchema = z.object({ alias_id: z.guid(), group_id: z.guid() });

/** Must run inside the canonical commit transaction; the lock lasts until commit/rollback. */
export async function reconcileActivityGroups(
  transaction: SchemaExecutionDatabase,
  userId: string,
): Promise<void> {
  z.guid().parse(userId);
  await transaction.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`activity-groups:${userId}`}, 0))`,
  );
  // Members, ownership anchors, and edges must share a statement snapshot. Provider
  // writers do not acquire this advisory lock, so separate reads can invent a split.
  // The oldest active member owns a split. Fully inactive groups remain untouched.
  const members = await executeWithSchema(
    transaction,
    memberSchema,
    sql`
    WITH active AS MATERIALIZED (
      SELECT a.id, a.group_id, a.created_at, g.created_at AS group_created_at,
        first_value(a.id) OVER (PARTITION BY g.id ORDER BY a.created_at, a.id) AS anchor_activity_id,
        a.provider_id, a.canonical_type, a.started_at,
        COALESCE(a.ended_at, a.started_at + interval '1 hour') AS ended_at
      FROM fitness.activity_group g
      JOIN fitness.activity a ON a.group_id = g.id AND a.user_id = g.user_id
      WHERE g.user_id = ${userId}::uuid AND a.deleted_at IS NULL AND a.provider_absent_at IS NULL
    ), pair_metrics AS (
      SELECT a.id AS activity_id, b.id AS overlapping_activity_id,
        a.provider_id AS provider_a, b.provider_id AS provider_b,
        a.canonical_type AS type_a, b.canonical_type AS type_b,
        EXTRACT(EPOCH FROM (LEAST(a.ended_at, b.ended_at) - GREATEST(a.started_at, b.started_at))) AS overlap_seconds,
        EXTRACT(EPOCH FROM (GREATEST(a.ended_at, b.ended_at) - LEAST(a.started_at, b.started_at))) AS union_seconds,
        LEAST(EXTRACT(EPOCH FROM (a.ended_at - a.started_at)),
          EXTRACT(EPOCH FROM (b.ended_at - b.started_at))) AS shorter_duration_seconds
      FROM active a JOIN active b ON a.id < b.id
        AND a.started_at < b.ended_at AND a.ended_at > b.started_at
    ), overlap_edges AS (
      SELECT activity_id, array_agg(overlapping_activity_id) AS overlapping_activity_ids
      FROM pair_metrics
      WHERE overlap_seconds / NULLIF(union_seconds, 0) > 0.8
        OR (provider_a <> provider_b AND type_a = type_b
          AND overlap_seconds / NULLIF(shorter_duration_seconds, 0) > 0.8)
      GROUP BY activity_id
    )
    SELECT active.id, active.group_id, active.created_at, active.group_created_at,
      active.anchor_activity_id,
      COALESCE(overlap_edges.overlapping_activity_ids, ARRAY[]::uuid[]) AS overlapping_activity_ids
    FROM active LEFT JOIN overlap_edges ON overlap_edges.activity_id = active.id`,
  );
  const groups = new Map(
    members.map((member) => [
      member.group_id,
      {
        id: member.group_id,
        anchorActivityId: member.anchor_activity_id,
        createdAt: member.group_created_at,
      },
    ]),
  );
  const originalGroups = new Map(members.map((member) => [member.id, member.group_id]));
  const storedAliases = await executeWithSchema(
    transaction,
    aliasSchema,
    sql`
    SELECT alias_id, group_id FROM fitness.activity_group_alias WHERE user_id = ${userId}::uuid`,
  );
  const targets = new Map(storedAliases.map((alias) => [alias.alias_id, alias.group_id]));
  function resolveTarget(groupId: string): string {
    const visited = new Set<string>();
    let target = groupId;
    let next = targets.get(target);
    while (next !== undefined) {
      if (visited.has(target)) throw new Error(`Activity group alias cycle at ${target}`);
      visited.add(target);
      target = next;
      next = targets.get(target);
    }
    return target;
  }
  const decision = decideActivityGroups({
    members: members.map((member) => ({
      id: member.id,
      groupId: member.group_id,
      createdAt: member.created_at,
    })),
    groups: [...groups.values()],
    overlaps: members.flatMap((member) =>
      member.overlapping_activity_ids.map((overlappingActivityId) => ({
        activityId: member.id,
        overlappingActivityId,
      })),
    ),
  });
  for (const component of decision.components) {
    let groupId: string;
    if (component.target.kind === "new") {
      const inserted = await executeWithSchema(
        transaction,
        z.object({ id: z.guid() }),
        sql`
        INSERT INTO fitness.activity_group (user_id, anchor_activity_id)
        VALUES (${userId}::uuid, ${component.target.anchorActivityId}::uuid) RETURNING id`,
      );
      const createdGroup = inserted[0];
      if (!createdGroup) throw new Error("Activity group insert did not return an ID");
      groupId = createdGroup.id;
    } else {
      groupId = resolveTarget(component.target.groupId);
    }
    if (component.memberIds.every((id) => originalGroups.get(id) === groupId)) continue;
    const memberIds = sql.join(
      component.memberIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    await transaction.execute(sql`UPDATE fitness.activity SET group_id = ${groupId}::uuid
      WHERE user_id = ${userId}::uuid AND id IN (${memberIds}) AND group_id IS DISTINCT FROM ${groupId}::uuid`);
  }
  for (const alias of decision.aliases) {
    const groupId = resolveTarget(alias.groupId);
    if (groupId === alias.aliasGroupId)
      throw new Error(`Activity group merge would create an alias cycle for ${groupId}`);
    // Active split components have already moved; carry remaining inactive members with the merge.
    await transaction.execute(sql`UPDATE fitness.activity SET group_id = ${groupId}::uuid
      WHERE user_id = ${userId}::uuid AND group_id = ${alias.aliasGroupId}::uuid`);
    await transaction.execute(sql`UPDATE fitness.activity_group_alias SET group_id = ${groupId}::uuid
      WHERE user_id = ${userId}::uuid AND group_id = ${alias.aliasGroupId}::uuid`);
    await transaction.execute(sql`INSERT INTO fitness.activity_group_alias (alias_id, group_id, user_id, reason)
      VALUES (${alias.aliasGroupId}::uuid, ${groupId}::uuid, ${userId}::uuid, 'merge')
      ON CONFLICT (alias_id) DO UPDATE SET group_id = excluded.group_id`);
    for (const [aliasId, target] of targets) {
      if (target === alias.aliasGroupId) targets.set(aliasId, groupId);
    }
    targets.set(alias.aliasGroupId, groupId);
  }
}
