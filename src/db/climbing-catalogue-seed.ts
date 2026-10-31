import { type CatalogueSeed, catalogueSeedSchema } from "@dofek/training/climbing-catalogue";
import { sql } from "drizzle-orm";
import { executeWithSchema, type SqlExecutor } from "./execute-with-schema.ts";

/** Read current owned source facts; catalogue lookups never modify the source graph. */
export async function loadCatalogueSeed(
  db: SqlExecutor,
  userId: string,
  logEntryId: string,
): Promise<CatalogueSeed | null> {
  const rows = await executeWithSchema(
    db,
    catalogueSeedSchema,
    sql`
    SELECT
      entry.user_id AS "userId",
      entry.id AS "logEntryId",
      entry.provider_id AS "providerId",
      source_climb.external_id AS "externalId",
      NULL::text AS "sourceUrl",
      COALESCE(NULLIF(BTRIM(source_climb.name), ''), NULLIF(BTRIM(entry.title), '')) AS name,
      CASE WHEN entry.climb_kind IN ('route', 'boulder') THEN entry.climb_kind::text END AS kind,
      entry.setting,
      (CASE WHEN source_climb.coordinates IS NOT NULL THEN JSONB_BUILD_ARRAY(JSONB_BUILD_OBJECT(
        'externalId', source_climb.external_id,
        'name', COALESCE(NULLIF(BTRIM(source_climb.name), ''), NULLIF(BTRIM(entry.title), '')),
        'scope', 'climb',
        'coordinates', JSONB_BUILD_OBJECT('latitude', source_climb.coordinates[1], 'longitude', source_climb.coordinates[0])
      )) ELSE '[]'::jsonb END) || COALESCE((
        SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
          'externalId', source_area.value->'externalId',
          'name', source_area.value->'name',
          'scope', 'area',
          'coordinates', source_area.value->'coordinates'
        ) ORDER BY source_area.position)
        FROM JSONB_ARRAY_ELEMENTS(entry.area_path) WITH ORDINALITY AS source_area(value, position)
      ), '[]'::jsonb) AS locations
    FROM fitness.v_climbing_log_entry AS entry
    LEFT JOIN fitness.climb AS source_climb ON source_climb.id = entry.climb_id
      AND source_climb.user_id = entry.user_id AND source_climb.provider_id = entry.provider_id
    WHERE entry.user_id = ${userId}::uuid AND entry.id = ${logEntryId}::uuid
      AND entry.provider_absent_at IS NULL
      AND (entry.activity_id IS NULL OR EXISTS (
        SELECT 1 FROM fitness.activity AS parent
        WHERE parent.id = entry.activity_id AND parent.user_id = ${userId}::uuid
          AND parent.deleted_at IS NULL AND parent.provider_absent_at IS NULL
      ))
  `,
  );
  return rows[0] ?? null;
}
