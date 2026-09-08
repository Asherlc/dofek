import type { Database } from "dofek/db";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import {
  type EffectiveFoodRecord,
  type FoodRecordHistoryItem,
  type FoodRecordHistoryPage,
  FoodRecordPreconditionError,
  type FoodRecordProvenance,
  type FoodRecordSearchInput,
  type FoodRecordSearchResult,
  type FoodRecordVisibility,
  foodRecordFieldDecisionSchema,
  foodRecordNutrientDecisionSchema,
  foodRecordSearchInputSchema,
} from "./food-record-types.ts";

const provenanceRowSchema = z.object({
  origin: z.enum(["source", "human"]),
  changeId: z.uuid().nullable(),
});

const effectiveFoodRecordRowSchema = z.object({
  record_id: z.uuid(),
  source_entry_id: z.uuid(),
  version: z.uuid().nullable(),
  deleted: z.boolean(),
  modifiable: z.boolean(),
  modification_unavailable_reason: z.string().nullable(),
  date: dateStringSchema,
  source_date: dateStringSchema,
  meal: z.string().nullable(),
  food_name: z.string().nullable(),
  food_description: z.string().nullable(),
  category: z.string().nullable(),
  number_of_units: z.coerce.number().nullable(),
  serving_unit: z.string().nullable(),
  serving_weight_grams: z.coerce.number().nullable(),
  nutrients: z.record(z.string(), z.coerce.number().nullable()),
  nutrient_provenance: z.record(z.string(), provenanceRowSchema),
  source_provider: z.string(),
  date_operation: z.enum(["set", "clear"]).nullable(),
  date_change_id: z.uuid().nullable(),
  meal_operation: z.enum(["set", "clear"]).nullable(),
  meal_change_id: z.uuid().nullable(),
  food_name_operation: z.enum(["set", "clear"]).nullable(),
  food_name_change_id: z.uuid().nullable(),
  food_description_operation: z.enum(["set", "clear"]).nullable(),
  food_description_change_id: z.uuid().nullable(),
  category_operation: z.enum(["set", "clear"]).nullable(),
  category_change_id: z.uuid().nullable(),
  number_of_units_operation: z.enum(["set", "clear"]).nullable(),
  number_of_units_change_id: z.uuid().nullable(),
  serving_unit_operation: z.enum(["set", "clear"]).nullable(),
  serving_unit_change_id: z.uuid().nullable(),
  serving_weight_grams_operation: z.enum(["set", "clear"]).nullable(),
  serving_weight_grams_change_id: z.uuid().nullable(),
  visibility_change_id: z.uuid().nullable(),
});

const sourceIdentityRowSchema = z.object({
  source_entry_id: z.uuid(),
  provider_id: z.string(),
  external_id: z.string().nullable(),
});

const resolvedIdentityRowSchema = z.object({
  identity_id: z.uuid(),
  source_entry_id: z.uuid(),
});

const historyRowSchema = z.object({
  change_id: z.uuid(),
  request_id: z.uuid(),
  version: z.uuid(),
  predecessor_version: z.uuid().nullable(),
  kind: z.enum(["create", "update", "clear", "delete", "restore", "undo", "legacy_delete"]),
  channel: z.enum(["web", "mobile", "mcp", "migration"]),
  client_id: z.string().nullable(),
  recorded_at: timestampStringSchema,
  effective_at: timestampStringSchema.nullable(),
  schema_version: z.coerce.number().int().positive(),
  undo_change_id: z.uuid().nullable(),
  deleted: z.boolean().nullable(),
  fields: z.record(z.string(), foodRecordFieldDecisionSchema),
  nutrients: z.record(z.string(), foodRecordNutrientDecisionSchema),
});

const historyCursorSchema = z.object({
  recordedAt: timestampStringSchema,
  changeId: z.uuid(),
});

type EffectiveFoodRecordRow = z.infer<typeof effectiveFoodRecordRowSchema>;
type HistoryRow = z.infer<typeof historyRowSchema>;

function visibilityPredicate(visibility: FoodRecordVisibility): SQL {
  if (visibility === "visible") return sql`effective.deleted = FALSE`;
  if (visibility === "deleted") return sql`effective.deleted = TRUE`;
  return sql`TRUE`;
}

function textPredicate(query: string | null): SQL {
  if (query === null) return sql`TRUE`;
  return sql`CONCAT_WS(
    ' ', effective.food_name, effective.food_description, effective.category, effective.meal
  ) ILIKE ${`%${query}%`}`;
}

function fieldProvenance(
  operation: "set" | "clear" | null,
  changeId: string | null,
): FoodRecordProvenance {
  return operation === null ? { origin: "source", changeId: null } : { origin: "human", changeId };
}

function mapRecord(row: EffectiveFoodRecordRow): EffectiveFoodRecord {
  const provenance: Record<string, FoodRecordProvenance> = {
    date: fieldProvenance(row.date_operation, row.date_change_id),
    meal: fieldProvenance(row.meal_operation, row.meal_change_id),
    foodName: fieldProvenance(row.food_name_operation, row.food_name_change_id),
    foodDescription: fieldProvenance(
      row.food_description_operation,
      row.food_description_change_id,
    ),
    category: fieldProvenance(row.category_operation, row.category_change_id),
    numberOfUnits: fieldProvenance(row.number_of_units_operation, row.number_of_units_change_id),
    servingUnit: fieldProvenance(row.serving_unit_operation, row.serving_unit_change_id),
    servingWeightGrams: fieldProvenance(
      row.serving_weight_grams_operation,
      row.serving_weight_grams_change_id,
    ),
    deleted:
      row.visibility_change_id === null
        ? { origin: "source", changeId: null }
        : { origin: "human", changeId: row.visibility_change_id },
  };
  for (const [nutrientId, nutrientProvenance] of Object.entries(row.nutrient_provenance)) {
    provenance[`nutrients.${nutrientId}`] = nutrientProvenance;
  }

  return {
    recordId: row.record_id,
    sourceEntryId: row.source_entry_id,
    version: row.version,
    deleted: row.deleted,
    modifiable: row.modifiable,
    modificationUnavailableReason: row.modification_unavailable_reason,
    date: row.date,
    meal: row.meal,
    foodName: row.food_name,
    foodDescription: row.food_description,
    category: row.category,
    numberOfUnits: row.number_of_units,
    servingUnit: row.serving_unit,
    servingWeightGrams: row.serving_weight_grams,
    nutrients: row.nutrients,
    sourceProvider: row.source_provider,
    provenance,
  };
}

function effectiveRecordQuery(where: SQL, limit: number | null = null): SQL {
  return sql`
    SELECT
      effective.record_id,
      effective.source_entry_id,
      effective.version,
      effective.deleted,
      effective.modifiable,
      effective.modification_unavailable_reason,
      effective.date,
      effective.source_date,
      effective.meal,
      effective.food_name,
      effective.food_description,
      effective.category,
      effective.number_of_units,
      effective.serving_unit,
      effective.serving_weight_grams,
      COALESCE(nutrients.amounts, '{}'::jsonb) AS nutrients,
      COALESCE(nutrients.provenance, '{}'::jsonb) AS nutrient_provenance,
      effective.provider_id AS source_provider,
      date_decision.operation AS date_operation,
      date_decision.change_id AS date_change_id,
      meal_decision.operation AS meal_operation,
      meal_decision.change_id AS meal_change_id,
      food_name_decision.operation AS food_name_operation,
      food_name_decision.change_id AS food_name_change_id,
      food_description_decision.operation AS food_description_operation,
      food_description_decision.change_id AS food_description_change_id,
      category_decision.operation AS category_operation,
      category_decision.change_id AS category_change_id,
      number_of_units_decision.operation AS number_of_units_operation,
      number_of_units_decision.change_id AS number_of_units_change_id,
      serving_unit_decision.operation AS serving_unit_operation,
      serving_unit_decision.change_id AS serving_unit_change_id,
      serving_weight_decision.operation AS serving_weight_grams_operation,
      serving_weight_decision.change_id AS serving_weight_grams_change_id,
      visibility.change_id AS visibility_change_id
    FROM fitness.v_food_entry_effective AS effective
    LEFT JOIN fitness.v_human_record_visibility AS visibility
      ON visibility.user_id = effective.user_id
      AND visibility.identity_id = effective.record_id
    LEFT JOIN fitness.v_human_record_field AS date_decision
      ON date_decision.user_id = effective.user_id
      AND date_decision.identity_id = effective.record_id
      AND date_decision.field = 'date'
    LEFT JOIN fitness.v_human_record_field AS meal_decision
      ON meal_decision.user_id = effective.user_id
      AND meal_decision.identity_id = effective.record_id
      AND meal_decision.field = 'meal'
    LEFT JOIN fitness.v_human_record_field AS food_name_decision
      ON food_name_decision.user_id = effective.user_id
      AND food_name_decision.identity_id = effective.record_id
      AND food_name_decision.field = 'food_name'
    LEFT JOIN fitness.v_human_record_field AS food_description_decision
      ON food_description_decision.user_id = effective.user_id
      AND food_description_decision.identity_id = effective.record_id
      AND food_description_decision.field = 'food_description'
    LEFT JOIN fitness.v_human_record_field AS category_decision
      ON category_decision.user_id = effective.user_id
      AND category_decision.identity_id = effective.record_id
      AND category_decision.field = 'category'
    LEFT JOIN fitness.v_human_record_field AS number_of_units_decision
      ON number_of_units_decision.user_id = effective.user_id
      AND number_of_units_decision.identity_id = effective.record_id
      AND number_of_units_decision.field = 'number_of_units'
    LEFT JOIN fitness.v_human_record_field AS serving_unit_decision
      ON serving_unit_decision.user_id = effective.user_id
      AND serving_unit_decision.identity_id = effective.record_id
      AND serving_unit_decision.field = 'serving_unit'
    LEFT JOIN fitness.v_human_record_field AS serving_weight_decision
      ON serving_weight_decision.user_id = effective.user_id
      AND serving_weight_decision.identity_id = effective.record_id
      AND serving_weight_decision.field = 'serving_weight_grams'
    LEFT JOIN LATERAL (
      SELECT
        jsonb_object_agg(nutrient.nutrient_id, nutrient.amount) AS amounts,
        jsonb_object_agg(
          nutrient.nutrient_id,
          jsonb_build_object(
            'origin', CASE WHEN nutrient.operation IS NULL THEN 'source' ELSE 'human' END,
            'changeId', CASE WHEN nutrient.operation IS NULL THEN NULL ELSE nutrient.change_id END
          )
        ) AS provenance
      FROM fitness.v_food_entry_effective_nutrient AS nutrient
      WHERE nutrient.source_entry_id = effective.source_entry_id
    ) AS nutrients ON TRUE
    WHERE ${where}
    ORDER BY effective.source_date DESC, effective.record_id DESC
    ${limit === null ? sql`` : sql`LIMIT ${limit}`}
  `;
}

function encodeHistoryCursor(row: HistoryRow): string {
  return Buffer.from(
    JSON.stringify({ recordedAt: row.recorded_at, changeId: row.change_id }),
  ).toString("base64url");
}

function decodeHistoryCursor(cursor: string) {
  return historyCursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
}

function mapHistory(row: HistoryRow): FoodRecordHistoryItem {
  return {
    changeId: row.change_id,
    requestId: row.request_id,
    version: row.version,
    predecessorVersion: row.predecessor_version,
    kind: row.kind,
    channel: row.channel,
    clientId: row.client_id,
    recordedAt: row.recorded_at,
    effectiveAt: row.effective_at,
    schemaVersion: row.schema_version,
    undoChangeId: row.undo_change_id,
    deleted: row.deleted,
    fields: row.fields,
    nutrients: row.nutrients,
  };
}

export class FoodRecordRepository {
  readonly #database: Pick<Database, "execute" | "transaction">;
  readonly #userId: string;

  constructor(database: Pick<Database, "execute" | "transaction">, userId: string) {
    this.#database = database;
    this.#userId = userId;
  }

  async search(input: FoodRecordSearchInput): Promise<FoodRecordSearchResult> {
    const parsed = foodRecordSearchInputSchema.parse(input);
    const visibility = visibilityPredicate(parsed.visibility);
    const text = textPredicate(parsed.query);

    return this.#database.transaction(async (transaction) => {
      await transaction.execute(sql`
        INSERT INTO fitness.human_record_identity (user_id, domain, namespace, source_key)
        SELECT DISTINCT
          effective.user_id,
          'nutrition.food',
          effective.provider_id,
          CASE
            WHEN NULLIF(BTRIM(effective.external_id), '') IS NOT NULL
              THEN 'external:' || effective.external_id
            ELSE 'row:' || effective.source_entry_id::text
          END
        FROM fitness.v_food_entry_effective AS effective
        WHERE effective.user_id = ${this.#userId}
          AND effective.confirmed = TRUE
          AND effective.date BETWEEN ${parsed.startDate}::date AND ${parsed.endDate}::date
          AND ${text}
          AND ${visibility}
        ON CONFLICT (user_id, domain, namespace, source_key) DO NOTHING
      `);

      const cursor = parsed.cursor;
      const rows = await executeWithSchema(
        transaction,
        effectiveFoodRecordRowSchema,
        effectiveRecordQuery(
          sql`
            effective.user_id = ${this.#userId}
            AND effective.confirmed = TRUE
            AND effective.date BETWEEN ${parsed.startDate}::date AND ${parsed.endDate}::date
            AND ${textPredicate(parsed.query)}
            AND ${visibilityPredicate(parsed.visibility)}
            AND ${
              cursor === null
                ? sql`TRUE`
                : sql`(effective.source_date, effective.record_id) <
                    (${cursor.date}::date, ${cursor.recordId}::uuid)`
            }
          `,
          parsed.limit + 1,
        ),
      );

      const hasNextPage = rows.length > parsed.limit;
      const pageRows = hasNextPage ? rows.slice(0, parsed.limit) : rows;
      const last = pageRows.at(-1);
      return {
        items: pageRows.map(mapRecord),
        nextCursor:
          hasNextPage && last ? { date: last.source_date, recordId: last.record_id } : null,
      };
    });
  }

  async get(recordId: string): Promise<EffectiveFoodRecord | null> {
    const parsedRecordId = z.uuid().parse(recordId);
    const rows = await executeWithSchema(
      this.#database,
      effectiveFoodRecordRowSchema,
      effectiveRecordQuery(sql`
        effective.user_id = ${this.#userId}
        AND effective.record_id = ${parsedRecordId}
        AND effective.confirmed = TRUE
      `),
    );
    return rows[0] ? mapRecord(rows[0]) : null;
  }

  async history(
    recordId: string,
    cursor: string | null,
    limit: number,
  ): Promise<FoodRecordHistoryPage> {
    const parsedRecordId = z.uuid().parse(recordId);
    const parsedLimit = z.number().int().min(1).max(100).parse(limit);
    const parsedCursor = cursor === null ? null : decodeHistoryCursor(cursor);
    const rows = await executeWithSchema(
      this.#database,
      historyRowSchema,
      sql`
        SELECT
          change.id AS change_id,
          change.request_id,
          target.id AS version,
          target.predecessor_id AS predecessor_version,
          change.kind,
          change.channel,
          change.client_id,
          change.recorded_at,
          change.effective_at,
          change.schema_version,
          change.undo_change_id,
          target.deleted,
          target.fields,
          COALESCE(nutrients.decisions, '{}'::jsonb) AS nutrients
        FROM fitness.human_record_identity AS identity
        INNER JOIN fitness.human_record_target AS target
          ON target.user_id = identity.user_id AND target.identity_id = identity.id
        INNER JOIN fitness.human_record_change AS change
          ON change.user_id = target.user_id AND change.id = target.change_id
        LEFT JOIN LATERAL (
          SELECT jsonb_object_agg(
            nutrient.nutrient_id,
            jsonb_build_object('operation', nutrient.operation, 'amount', nutrient.amount)
          ) AS decisions
          FROM fitness.human_food_nutrient_decision AS nutrient
          WHERE nutrient.user_id = target.user_id
            AND nutrient.identity_id = target.identity_id
            AND nutrient.target_id = target.id
        ) AS nutrients ON TRUE
        WHERE identity.user_id = ${this.#userId}
          AND identity.id = ${parsedRecordId}
          AND identity.domain = 'nutrition.food'
          AND ${
            parsedCursor === null
              ? sql`TRUE`
              : sql`(change.recorded_at, change.id) <
                  (${parsedCursor.recordedAt}::timestamptz, ${parsedCursor.changeId}::uuid)`
          }
        ORDER BY change.recorded_at DESC, change.id DESC
        LIMIT ${parsedLimit + 1}
      `,
    );
    const hasNextPage = rows.length > parsedLimit;
    const pageRows = hasNextPage ? rows.slice(0, parsedLimit) : rows;
    const last = pageRows.at(-1);
    return {
      recordId: parsedRecordId,
      items: pageRows.map(mapHistory),
      nextCursor: hasNextPage && last ? encodeHistoryCursor(last) : null,
    };
  }

  async resolveStableIdentity(
    sourceEntryId: string,
  ): Promise<{ identityId: string; sourceEntryId: string }> {
    const parsedSourceEntryId = z.uuid().parse(sourceEntryId);
    return this.#database.transaction(async (transaction) => {
      const sourceRows = await executeWithSchema(
        transaction,
        sourceIdentityRowSchema,
        sql`
          SELECT id AS source_entry_id, provider_id, external_id
          FROM fitness.food_entry
          WHERE user_id = ${this.#userId}
            AND id = ${parsedSourceEntryId}
            AND confirmed = TRUE
        `,
      );
      const source = sourceRows[0];
      if (!source) throw new Error("User-owned confirmed food source entry was not found");
      if (!source.external_id?.trim()) {
        throw new FoodRecordPreconditionError(source.source_entry_id);
      }

      const sourceKey = `external:${source.external_id}`;
      await transaction.execute(sql`
        INSERT INTO fitness.human_record_identity (user_id, domain, namespace, source_key)
        VALUES (${this.#userId}, 'nutrition.food', ${source.provider_id}, ${sourceKey})
        ON CONFLICT (user_id, domain, namespace, source_key) DO NOTHING
      `);
      const identityRows = await executeWithSchema(
        transaction,
        resolvedIdentityRowSchema,
        sql`
          SELECT identity.id AS identity_id, ${source.source_entry_id}::uuid AS source_entry_id
          FROM fitness.human_record_identity AS identity
          WHERE identity.user_id = ${this.#userId}
            AND identity.domain = 'nutrition.food'
            AND identity.namespace = ${source.provider_id}
            AND identity.source_key = ${sourceKey}
        `,
      );
      const identity = identityRows[0];
      if (!identity) throw new Error("Stable food record identity could not be resolved");
      return { identityId: identity.identity_id, sourceEntryId: identity.source_entry_id };
    });
  }
}
