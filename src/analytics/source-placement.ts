import { z } from "zod";
import type { ClickHouseClient } from "../db/clickhouse.ts";

const uint64 = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .refine((value) => BigInt(value) <= 18446744073709551615n);
export const sourcePlacementSchema = z
  .object({
    sourceId: z.uuid(),
    userId: z.uuid(),
    providerId: z.string().min(1),
    sourceVersion: uint64,
    generation: uint64,
    key: z.object({
      userId: z.uuid(),
      channel: z.string().min(1),
      recordedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/),
    }),
    activityId: z.uuid().nullable(),
    deleted: z.boolean(),
  })
  .refine(
    (placement) => placement.userId === placement.key.userId,
    "Placement key must belong to its source owner",
  );

export type SourcePlacement = z.infer<typeof sourcePlacementSchema>;

const placementTupleSchema = z.tuple([
  z.uuid(),
  z.string(),
  uint64,
  uint64,
  z.string(),
  z.string(),
  z.uuid().nullable(),
  z.number().int().min(0).max(1),
]);
const resolvedPlacementSchema = z.object({
  source_id: z.uuid(),
  owners: z.array(z.uuid()).min(1).max(2),
  placements: z.array(placementTupleSchema).min(1).max(2),
});

/** Resolve global UUID identity before applying any former key/provider filter. */
export async function resolveSourcePlacements(
  client: ClickHouseClient,
  sourceIds: readonly string[],
): Promise<readonly SourcePlacement[]> {
  if (sourceIds.length > 20) throw new Error("Placement lookup accepts at most 20 source IDs");
  const ids = z.array(z.uuid()).parse(sourceIds);
  if (ids.length === 0) return [];
  const result = await client.query({
    query: `SELECT source_id,
        groupUniqArrayArray(2)(owners) AS owners,
        argMax(placements,tuple(source_version,ingested_at)) AS placements
      FROM (
        SELECT source_id,source_version,ingested_at,
          groupUniqArray(2)(user_id) AS owners,
          groupUniqArray(2)(tuple(user_id,provider_id,toString(source_version),
            toString(generation),channel,
            concat(replaceOne(toString(recorded_at),' ','T'),'Z'),activity_id,deleted)) AS placements
        FROM analytics.source_placement
        WHERE source_id IN {ids:Array(UUID)}
        GROUP BY source_id,source_version,ingested_at
      ) GROUP BY source_id ORDER BY source_id`,
    query_params: { ids },
    format: "JSONEachRow",
  });
  return z
    .array(resolvedPlacementSchema)
    .parse(await result.json())
    .map((row) => {
      if (row.owners.length !== 1)
        throw new Error(`Source ${row.source_id} has conflicting account owners`);
      if (row.placements.length !== 1)
        throw new Error(`Source ${row.source_id} has ambiguous structural placement`);
      const placement = row.placements[0];
      if (!placement) throw new Error(`Source ${row.source_id} has no structural placement`);
      const [
        userId,
        providerId,
        sourceVersion,
        generation,
        channel,
        recordedAt,
        activityId,
        deleted,
      ] = placement;
      return sourcePlacementSchema.parse({
        sourceId: row.source_id,
        userId,
        providerId,
        sourceVersion,
        generation,
        key: { userId, channel, recordedAt },
        activityId,
        deleted: deleted === 1,
      });
    });
}
