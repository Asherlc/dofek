import type { Database } from "dofek/db";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import {
  type EffectiveFoodRecord,
  type FoodRecordFieldDecision,
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
import { FoodRepository } from "./food-repository.ts";

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
  changeId: z.uuid(),
});

type EffectiveFoodRecordRow = z.infer<typeof effectiveFoodRecordRowSchema>;
type HistoryRow = z.infer<typeof historyRowSchema>;

const storedRequestRowSchema = z.object({
  change_id: z.uuid(),
  request_id: z.uuid(),
  request_hash: z.string().regex(/^[0-9a-f]{64}$/),
  kind: z.enum(["create", "update", "delete", "restore"]),
  client_id: z.string(),
  identity_id: z.uuid(),
  target_version: z.uuid(),
  predecessor_version: z.uuid().nullable(),
});

const lockedHeadRowSchema = z.object({
  identity_id: z.uuid(),
  source_entry_id: z.uuid(),
  current_version: z.uuid().nullable(),
  modifiable: z.boolean(),
});

const changeIdRowSchema = z.object({ change_id: z.uuid() });
const versionRowSchema = z.object({ version: z.uuid() });
const currentVersionRowSchema = z.object({ current_version: z.uuid().nullable() });

export type FoodRecordCommandKind = "create" | "update" | "delete" | "restore";
export interface FoodRecordActor {
  channel: "mcp";
  clientId: string;
}

export interface StoredFoodRecordRequest {
  changeId: string;
  requestId: string;
  requestHash: string;
  kind: FoodRecordCommandKind;
  actor: FoodRecordActor;
  identityId: string;
  version: string;
  predecessorVersion: string | null;
}

export interface FoodRecordHead {
  changeId: string;
  identityId: string;
  sourceEntryId: string;
  version: string;
  predecessorVersion: string | null;
  requestHash: string;
  kind: FoodRecordCommandKind;
  actor: FoodRecordActor;
  replayed: boolean;
}

export interface CreateFoodRecordSourceInput {
  requestId: string;
  requestHash: string;
  actor: FoodRecordActor;
  externalId: string;
  date: string;
  meal?: string | null;
  foodName: string;
  foodDescription?: string | null;
  category?: string | null;
  numberOfUnits?: number | null;
  servingUnit?: string | null;
  servingWeightGrams?: number | null;
  nutrients: Record<string, number>;
}

export interface AppendFoodRecordChangeInput {
  identityId: string;
  expectedVersion: string | null;
  requestId: string;
  requestHash: string;
  kind: FoodRecordCommandKind;
  actor: FoodRecordActor;
  fields: Record<string, FoodRecordFieldDecision>;
  nutrients: Record<string, { operation: "set" | "clear"; amount: number | null }>;
  deleted: boolean | null;
}

export interface FoodRecordRepositoryCommands {
  findRequest(requestId: string): Promise<StoredFoodRecordRequest | null>;
  createSourceAndIdentity(input: CreateFoodRecordSourceInput): Promise<FoodRecordHead>;
  appendChange(input: AppendFoodRecordChangeInput): Promise<FoodRecordHead>;
  get(identityId: string): Promise<EffectiveFoodRecord | null>;
  getAtVersion(identityId: string, version: string | null): Promise<EffectiveFoodRecord | null>;
}

export class FoodRecordNotFoundError extends Error {
  readonly code = "NOT_FOUND";
  readonly recordId: string;

  constructor(recordId: string) {
    super("The food record was not found.");
    this.name = "FoodRecordNotFoundError";
    this.recordId = recordId;
  }
}

export class FoodRecordConflictError extends Error {
  readonly code = "CONFLICT";
  readonly recordId: string;
  readonly currentVersion: string | null;

  constructor(
    recordId: string,
    currentVersion: string | null,
    message = "The food record changed. Read it again and retry with the current version.",
  ) {
    super(message);
    this.name = "FoodRecordConflictError";
    this.recordId = recordId;
    this.currentVersion = currentVersion;
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const databaseError =
    error && typeof error === "object" && "cause" in error ? error.cause : error;
  return Boolean(
    databaseError &&
      typeof databaseError === "object" &&
      "code" in databaseError &&
      databaseError.code === "23505" &&
      (("constraint" in databaseError && databaseError.constraint === constraint) ||
        ("constraint_name" in databaseError && databaseError.constraint_name === constraint)),
  );
}

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
    ORDER BY effective.record_id DESC
    ${limit === null ? sql`` : sql`LIMIT ${limit}`}
  `;
}

function encodeHistoryCursor(row: HistoryRow): string {
  return Buffer.from(JSON.stringify({ changeId: row.change_id })).toString("base64url");
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

function mapStoredRequest(row: z.infer<typeof storedRequestRowSchema>): StoredFoodRecordRequest {
  return {
    changeId: row.change_id,
    requestId: row.request_id,
    requestHash: row.request_hash,
    kind: row.kind,
    actor: { channel: "mcp", clientId: row.client_id },
    identityId: row.identity_id,
    version: row.target_version,
    predecessorVersion: row.predecessor_version,
  };
}

function requestMatches(
  stored: StoredFoodRecordRequest,
  input: Pick<AppendFoodRecordChangeInput, "actor" | "identityId" | "kind" | "requestHash">,
): boolean {
  return (
    stored.requestHash === input.requestHash &&
    stored.kind === input.kind &&
    stored.identityId === input.identityId &&
    stored.actor.channel === input.actor.channel &&
    stored.actor.clientId === input.actor.clientId
  );
}

export class FoodRecordRepository {
  readonly #database: Pick<Database, "execute" | "transaction">;
  readonly #userId: string;

  constructor(database: Pick<Database, "execute" | "transaction">, userId: string) {
    this.#database = database;
    this.#userId = userId;
  }

  async findRequest(requestId: string): Promise<StoredFoodRecordRequest | null> {
    const parsedRequestId = z.uuid().parse(requestId);
    const rows = await executeWithSchema(
      this.#database,
      storedRequestRowSchema,
      sql`
        SELECT
          change.id AS change_id,
          change.request_id,
          change.request_hash,
          change.kind,
          change.client_id,
          target.identity_id,
          target.id AS target_version,
          target.predecessor_id AS predecessor_version
        FROM fitness.human_record_change AS change
        INNER JOIN fitness.human_record_target AS target
          ON target.user_id = change.user_id AND target.change_id = change.id
        WHERE change.user_id = ${this.#userId}
          AND change.request_id = ${parsedRequestId}
          AND change.channel = 'mcp'
        LIMIT 1
      `,
    );
    return rows[0] ? mapStoredRequest(rows[0]) : null;
  }

  async #lockHead(identityId: string) {
    const rows = await executeWithSchema(
      this.#database,
      lockedHeadRowSchema,
      sql`
        SELECT
          identity.id AS identity_id,
          source.id AS source_entry_id,
          head.id AS current_version,
          identity.source_key LIKE 'external:%' AS modifiable
        FROM fitness.human_record_identity AS identity
        INNER JOIN LATERAL (
          SELECT entry.id
          FROM fitness.food_entry AS entry
          WHERE entry.user_id = identity.user_id
            AND entry.provider_id = identity.namespace
            AND entry.confirmed = TRUE
            AND identity.source_key = CASE
              WHEN NULLIF(BTRIM(entry.external_id), '') IS NOT NULL
                THEN 'external:' || entry.external_id
              ELSE 'row:' || entry.id::text
            END
          ORDER BY entry.created_at DESC, entry.id DESC
          LIMIT 1
        ) AS source ON TRUE
        LEFT JOIN LATERAL (
          SELECT target.id
          FROM fitness.human_record_target AS target
          WHERE target.user_id = identity.user_id
            AND target.identity_id = identity.id
            AND NOT EXISTS (
              SELECT 1 FROM fitness.human_record_target AS successor
              WHERE successor.user_id = target.user_id
                AND successor.identity_id = target.identity_id
                AND successor.predecessor_id = target.id
            )
          LIMIT 1
        ) AS head ON TRUE
        WHERE identity.user_id = ${this.#userId}
          AND identity.id = ${identityId}::uuid
          AND identity.domain = 'nutrition.food'
        FOR UPDATE OF identity
      `,
    );
    return rows[0] ?? null;
  }

  async #currentVersion(identityId: string): Promise<string | null> {
    const rows = await executeWithSchema(
      this.#database,
      currentVersionRowSchema,
      sql`
        SELECT target.id AS current_version
        FROM fitness.human_record_target AS target
        WHERE target.user_id = ${this.#userId}
          AND target.identity_id = ${identityId}::uuid
          AND NOT EXISTS (
            SELECT 1 FROM fitness.human_record_target AS successor
            WHERE successor.user_id = target.user_id
              AND successor.identity_id = target.identity_id
              AND successor.predecessor_id = target.id
          )
        LIMIT 1
      `,
    );
    return rows[0]?.current_version ?? null;
  }

  async createSourceAndIdentity(input: CreateFoodRecordSourceInput): Promise<FoodRecordHead> {
    const requestId = z.uuid().parse(input.requestId);
    const stored = await this.findRequest(requestId);
    if (stored) {
      if (!requestMatches(stored, { ...input, identityId: stored.identityId, kind: "create" })) {
        throw new FoodRecordConflictError(
          stored.identityId,
          await this.#currentVersion(stored.identityId),
          "Request ID was reused.",
        );
      }
      const record = await this.get(stored.identityId);
      if (!record) throw new Error("Replayed food record source could not be resolved");
      return {
        changeId: stored.changeId,
        identityId: stored.identityId,
        sourceEntryId: record.sourceEntryId,
        version: stored.version,
        predecessorVersion: stored.predecessorVersion,
        requestHash: stored.requestHash,
        kind: stored.kind,
        actor: stored.actor,
        replayed: true,
      };
    }
    const sourceKey = `external:${input.externalId}`;
    const foodRepository = new FoodRepository(this.#database, this.#userId, "UTC");
    await foodRepository.ensureDofekProvider();
    await this.#database.execute(sql`
      INSERT INTO fitness.human_record_identity (user_id, domain, namespace, source_key)
      VALUES (${this.#userId}, 'nutrition.food', 'dofek', ${sourceKey})
      ON CONFLICT (user_id, domain, namespace, source_key) DO NOTHING
    `);
    const identityRows = await executeWithSchema(
      this.#database,
      z.object({ identity_id: z.uuid() }),
      sql`
        SELECT id AS identity_id
        FROM fitness.human_record_identity
        WHERE user_id = ${this.#userId}
          AND domain = 'nutrition.food'
          AND namespace = 'dofek'
          AND source_key = ${sourceKey}
        FOR UPDATE
      `,
    );
    const identityId = identityRows[0]?.identity_id;
    if (!identityId) throw new Error("Created food record identity could not be locked");

    const created = await foodRepository.create({
      externalId: input.externalId,
      date: input.date,
      meal: input.meal,
      foodName: input.foodName,
      foodDescription: input.foodDescription,
      category: input.category,
      numberOfUnits: input.numberOfUnits,
      servingUnit: input.servingUnit,
      servingWeightGrams: input.servingWeightGrams,
      nutrients: input.nutrients,
    });
    return this.appendChange({
      identityId,
      expectedVersion: null,
      requestId,
      requestHash: input.requestHash,
      kind: "create",
      actor: input.actor,
      fields: {},
      nutrients: {},
      deleted: null,
    }).then((result) => ({ ...result, sourceEntryId: created.id }));
  }

  async appendChange(input: AppendFoodRecordChangeInput): Promise<FoodRecordHead> {
    const identityId = z.uuid().parse(input.identityId);
    const requestId = z.uuid().parse(input.requestId);
    const locked = await this.#lockHead(identityId);
    if (!locked) throw new FoodRecordNotFoundError(identityId);
    if (!locked.modifiable) throw new FoodRecordPreconditionError(locked.source_entry_id);

    const stored = await this.findRequest(requestId);
    if (stored) {
      if (!requestMatches(stored, input)) {
        throw new FoodRecordConflictError(
          identityId,
          locked.current_version,
          "Request ID was reused.",
        );
      }
      return {
        changeId: stored.changeId,
        identityId,
        sourceEntryId: locked.source_entry_id,
        version: stored.version,
        predecessorVersion: stored.predecessorVersion,
        requestHash: stored.requestHash,
        kind: stored.kind,
        actor: stored.actor,
        replayed: true,
      };
    }
    if (locked.current_version !== input.expectedVersion) {
      throw new FoodRecordConflictError(identityId, locked.current_version);
    }

    try {
      const changeRows = await executeWithSchema(
        this.#database,
        changeIdRowSchema,
        sql`
          INSERT INTO fitness.human_record_change (
            user_id, request_id, request_hash, kind, channel, client_id, schema_version
          ) VALUES (
            ${this.#userId}, ${requestId}, ${input.requestHash}, ${input.kind},
            ${input.actor.channel}, ${input.actor.clientId}, 1
          )
          RETURNING id AS change_id
        `,
      );
      const changeId = changeRows[0]?.change_id;
      if (!changeId) throw new Error("Food record change insert returned no ID");
      const targetRows = await executeWithSchema(
        this.#database,
        versionRowSchema,
        sql`
          INSERT INTO fitness.human_record_target (
            user_id, identity_id, change_id, predecessor_id, fields, deleted
          ) VALUES (
            ${this.#userId}, ${identityId}, ${changeId}, ${input.expectedVersion},
            ${JSON.stringify(input.fields)}::jsonb, ${input.deleted}
          )
          RETURNING id AS version
        `,
      );
      const nextVersion = targetRows[0]?.version;
      if (!nextVersion) throw new Error("Food record target insert returned no ID");
      const nutrientEntries = Object.entries(input.nutrients);
      if (nutrientEntries.length > 0) {
        await this.#database.execute(sql`
          INSERT INTO fitness.human_food_nutrient_decision (
            target_id, identity_id, user_id, nutrient_id, operation, amount
          ) VALUES ${sql.join(
            nutrientEntries.map(
              ([nutrientId, decision]) => sql`(
                ${nextVersion}, ${identityId}, ${this.#userId}, ${nutrientId},
                ${decision.operation}, ${decision.amount}
              )`,
            ),
            sql`, `,
          )}
        `);
      }
      return {
        changeId,
        identityId,
        sourceEntryId: locked.source_entry_id,
        version: nextVersion,
        predecessorVersion: input.expectedVersion,
        requestHash: input.requestHash,
        kind: input.kind,
        actor: input.actor,
        replayed: false,
      };
    } catch (error: unknown) {
      if (
        isUniqueViolation(error, "human_record_target_successor_key") ||
        isUniqueViolation(error, "human_record_change_request_key")
      ) {
        throw new FoodRecordConflictError(identityId, locked.current_version);
      }
      throw error;
    }
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
            AND ${cursor === null ? sql`TRUE` : sql`effective.record_id < ${cursor.recordId}::uuid`}
          `,
          parsed.limit + 1,
        ),
      );

      const hasNextPage = rows.length > parsed.limit;
      const pageRows = hasNextPage ? rows.slice(0, parsed.limit) : rows;
      const last = pageRows.at(-1);
      return {
        items: pageRows.map(mapRecord),
        nextCursor: hasNextPage && last ? { recordId: last.record_id } : null,
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

  async getAtVersion(
    identityId: string,
    version: string | null,
  ): Promise<EffectiveFoodRecord | null> {
    const parsedIdentityId = z.uuid().parse(identityId);
    const parsedVersion = version === null ? null : z.uuid().parse(version);
    const rows = await executeWithSchema(
      this.#database,
      effectiveFoodRecordRowSchema,
      sql`
        WITH RECURSIVE lineage AS (
          SELECT target.*, 0 AS depth
          FROM fitness.human_record_target AS target
          WHERE target.user_id = ${this.#userId}
            AND target.identity_id = ${parsedIdentityId}
            AND target.id = ${parsedVersion}::uuid
          UNION ALL
          SELECT predecessor.*, lineage.depth + 1
          FROM fitness.human_record_target AS predecessor
          INNER JOIN lineage ON predecessor.id = lineage.predecessor_id
            AND predecessor.identity_id = lineage.identity_id
            AND predecessor.user_id = lineage.user_id
        ), source AS (
          SELECT
            identity.id AS identity_id,
            identity.namespace,
            identity.source_key,
            entry.id AS source_entry_id,
            entry.date,
            entry.meal,
            entry.food_name,
            entry.food_description,
            entry.category,
            entry.number_of_units,
            entry.serving_unit,
            entry.serving_weight_grams
          FROM fitness.human_record_identity AS identity
          INNER JOIN LATERAL (
            SELECT food.*
            FROM fitness.food_entry AS food
            WHERE food.user_id = identity.user_id
              AND food.provider_id = identity.namespace
              AND food.confirmed = TRUE
              AND identity.source_key = CASE
                WHEN NULLIF(BTRIM(food.external_id), '') IS NOT NULL
                  THEN 'external:' || food.external_id
                ELSE 'row:' || food.id::text
              END
            ORDER BY food.created_at DESC, food.id DESC
            LIMIT 1
          ) AS entry ON TRUE
          WHERE identity.user_id = ${this.#userId}
            AND identity.id = ${parsedIdentityId}
            AND identity.domain = 'nutrition.food'
            AND (${parsedVersion}::uuid IS NULL OR EXISTS (SELECT 1 FROM lineage WHERE depth = 0))
        )
        SELECT
          source.identity_id AS record_id,
          source.source_entry_id,
          ${parsedVersion}::uuid AS version,
          COALESCE(visibility.deleted, FALSE) AS deleted,
          source.source_key LIKE 'external:%' AS modifiable,
          CASE WHEN source.source_key LIKE 'external:%' THEN NULL
            ELSE 'This food entry has no stable provider external ID and cannot be modified safely.'
          END AS modification_unavailable_reason,
          CASE WHEN date_decision.operation = 'set'
            THEN (date_decision.value #>> '{}')::date ELSE source.date END AS date,
          source.date AS source_date,
          CASE WHEN meal_decision.operation = 'set'
            THEN meal_decision.value #>> '{}' ELSE source.meal::text END AS meal,
          CASE WHEN food_name_decision.operation = 'set'
            THEN food_name_decision.value #>> '{}' ELSE source.food_name END AS food_name,
          CASE WHEN food_description_decision.operation = 'set'
            THEN food_description_decision.value #>> '{}' ELSE source.food_description END
            AS food_description,
          CASE WHEN category_decision.operation = 'set'
            THEN category_decision.value #>> '{}' ELSE source.category::text END AS category,
          CASE WHEN number_of_units_decision.operation = 'set'
            THEN (number_of_units_decision.value #>> '{}')::real ELSE source.number_of_units END
            AS number_of_units,
          CASE WHEN serving_unit_decision.operation = 'set'
            THEN serving_unit_decision.value #>> '{}' ELSE source.serving_unit END AS serving_unit,
          CASE WHEN serving_weight_decision.operation = 'set'
            THEN (serving_weight_decision.value #>> '{}')::real ELSE source.serving_weight_grams END
            AS serving_weight_grams,
          COALESCE(nutrients.amounts, '{}'::jsonb) AS nutrients,
          COALESCE(nutrients.provenance, '{}'::jsonb) AS nutrient_provenance,
          source.namespace AS source_provider,
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
        FROM source
        LEFT JOIN LATERAL (
          SELECT target.deleted, target.change_id
          FROM lineage AS target WHERE target.deleted IS NOT NULL
          ORDER BY target.depth LIMIT 1
        ) AS visibility ON TRUE
        LEFT JOIN LATERAL (
          SELECT field.value->>'operation' AS operation, field.value->'value' AS value,
                 target.change_id
          FROM lineage AS target CROSS JOIN LATERAL jsonb_each(target.fields) AS field
          WHERE field.key = 'date' ORDER BY target.depth LIMIT 1
        ) AS date_decision ON TRUE
        LEFT JOIN LATERAL (
          SELECT field.value->>'operation' AS operation, field.value->'value' AS value,
                 target.change_id
          FROM lineage AS target CROSS JOIN LATERAL jsonb_each(target.fields) AS field
          WHERE field.key = 'meal' ORDER BY target.depth LIMIT 1
        ) AS meal_decision ON TRUE
        LEFT JOIN LATERAL (
          SELECT field.value->>'operation' AS operation, field.value->'value' AS value,
                 target.change_id
          FROM lineage AS target CROSS JOIN LATERAL jsonb_each(target.fields) AS field
          WHERE field.key = 'food_name' ORDER BY target.depth LIMIT 1
        ) AS food_name_decision ON TRUE
        LEFT JOIN LATERAL (
          SELECT field.value->>'operation' AS operation, field.value->'value' AS value,
                 target.change_id
          FROM lineage AS target CROSS JOIN LATERAL jsonb_each(target.fields) AS field
          WHERE field.key = 'food_description' ORDER BY target.depth LIMIT 1
        ) AS food_description_decision ON TRUE
        LEFT JOIN LATERAL (
          SELECT field.value->>'operation' AS operation, field.value->'value' AS value,
                 target.change_id
          FROM lineage AS target CROSS JOIN LATERAL jsonb_each(target.fields) AS field
          WHERE field.key = 'category' ORDER BY target.depth LIMIT 1
        ) AS category_decision ON TRUE
        LEFT JOIN LATERAL (
          SELECT field.value->>'operation' AS operation, field.value->'value' AS value,
                 target.change_id
          FROM lineage AS target CROSS JOIN LATERAL jsonb_each(target.fields) AS field
          WHERE field.key = 'number_of_units' ORDER BY target.depth LIMIT 1
        ) AS number_of_units_decision ON TRUE
        LEFT JOIN LATERAL (
          SELECT field.value->>'operation' AS operation, field.value->'value' AS value,
                 target.change_id
          FROM lineage AS target CROSS JOIN LATERAL jsonb_each(target.fields) AS field
          WHERE field.key = 'serving_unit' ORDER BY target.depth LIMIT 1
        ) AS serving_unit_decision ON TRUE
        LEFT JOIN LATERAL (
          SELECT field.value->>'operation' AS operation, field.value->'value' AS value,
                 target.change_id
          FROM lineage AS target CROSS JOIN LATERAL jsonb_each(target.fields) AS field
          WHERE field.key = 'serving_weight_grams' ORDER BY target.depth LIMIT 1
        ) AS serving_weight_decision ON TRUE
        LEFT JOIN LATERAL (
          WITH keys AS (
            SELECT nutrient_id FROM fitness.food_entry_nutrient
            WHERE food_entry_id = source.source_entry_id
            UNION
            SELECT decision.nutrient_id
            FROM lineage AS target
            INNER JOIN fitness.human_food_nutrient_decision AS decision
              ON decision.target_id = target.id
              AND decision.identity_id = target.identity_id
              AND decision.user_id = target.user_id
          ), nearest AS (
            SELECT DISTINCT ON (decision.nutrient_id)
              decision.nutrient_id, decision.operation, decision.amount, target.change_id
            FROM lineage AS target
            INNER JOIN fitness.human_food_nutrient_decision AS decision
              ON decision.target_id = target.id
              AND decision.identity_id = target.identity_id
              AND decision.user_id = target.user_id
            ORDER BY decision.nutrient_id, target.depth
          )
          SELECT
            jsonb_object_agg(keys.nutrient_id,
              CASE WHEN nearest.operation = 'set' THEN nearest.amount ELSE raw.amount END
            ) AS amounts,
            jsonb_object_agg(keys.nutrient_id,
              jsonb_build_object(
                'origin', CASE WHEN nearest.operation IS NULL THEN 'source' ELSE 'human' END,
                'changeId', nearest.change_id
              )
            ) AS provenance
          FROM keys
          LEFT JOIN fitness.food_entry_nutrient AS raw
            ON raw.food_entry_id = source.source_entry_id AND raw.nutrient_id = keys.nutrient_id
          LEFT JOIN nearest ON nearest.nutrient_id = keys.nutrient_id
        ) AS nutrients ON TRUE
      `,
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
                  (SELECT cursor_change.recorded_at, cursor_change.id
                   FROM fitness.human_record_change AS cursor_change
                   INNER JOIN fitness.human_record_target AS cursor_target
                     ON cursor_target.user_id = cursor_change.user_id
                     AND cursor_target.change_id = cursor_change.id
                   WHERE cursor_change.user_id = ${this.#userId}
                     AND cursor_change.id = ${parsedCursor.changeId}::uuid
                     AND cursor_target.identity_id = ${parsedRecordId}::uuid)`
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
