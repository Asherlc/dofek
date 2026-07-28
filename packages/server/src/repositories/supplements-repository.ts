import { formatDateYmdInTimeZone } from "@dofek/format/format";
import {
  type SupplementDoseOccurrences,
  supplementDoseStatusSchema,
} from "@dofek/format/supplement-dose-events";
import type { Database } from "dofek/db";
import {
  nutrientAmountEntriesFromLegacyFields,
  nutrientColumnsToValues,
  nutrientFieldsSchema,
  nutrientRowSchema,
} from "dofek/db/nutrient-columns";
import {
  supplement,
  supplementDefinition,
  supplementDefinitionNutrient,
} from "dofek/db/schema/nutrition";
import { ensureProvider } from "dofek/db/tokens";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";

const DOFEK_PROVIDER_ID = "dofek";
const DOFEK_PROVIDER_NAME = "Dofek App";

export const supplementSchema = z
  .object({
    name: z.string().min(1).max(200),
    amount: z.number().positive().optional(),
    unit: z.string().max(10).optional(),
    form: z.string().optional(),
    description: z.string().optional(),
    meal: z.enum(["breakfast", "lunch", "dinner", "snack", "other"]).optional(),
  })
  .merge(nutrientFieldsSchema.partial());

export const supplementListSchema = z.array(supplementSchema);

export type Supplement = z.infer<typeof supplementSchema>;
const SUPPLEMENT_DEFINITION_FIELDS = Object.keys(supplementSchema.shape);

interface SupplementVersion {
  id: string;
  scheduleId: string;
  definition: Supplement;
}

const NON_NUTRIENT_OPTIONAL_FIELDS = ["amount", "unit", "form", "description", "meal"] as const;

const supplementViewRowSchema = z
  .object({
    definition_id: z.string(),
    supplement_id: z.string(),
    user_id: z.string(),
    schedule_id: z.string(),
    supersedes_definition_id: z.string().nullable(),
    name: z.string(),
    amount: z.coerce.number().nullable(),
    unit: z.string().nullable(),
    form: z.string().nullable(),
    description: z.string().nullable(),
    meal: z.string().nullable(),
    sort_order: z.coerce.number(),
    effective_from: z.string(),
    effective_to: z.string().nullable(),
    nutrition_data_id: z.string().nullable(),
    created_at: timestampStringSchema,
    updated_at: timestampStringSchema,
  })
  .merge(nutrientRowSchema);

const doseEventRowSchema = z.object({
  id: z.string(),
  schedule_id: z.string(),
  supplement_id: z.string(),
  supplement_name: z.string(),
  scheduled_date: z.string(),
  status: supplementDoseStatusSchema,
  supersedes_event_id: z.string().nullable(),
  provider_id: z.string(),
  source_name: z.string().nullable(),
  recorded_at: timestampStringSchema,
  created_at: timestampStringSchema,
  is_current: z.boolean(),
});

const currentDoseEventRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  schedule_id: z.string(),
  supplement_id: z.string(),
  scheduled_date: z.string(),
});

const insertedIdRowSchema = z.object({ id: z.string() });

export class SupplementDoseConflictError extends Error {
  constructor() {
    super("Supplement status changed. Reload and try again.");
    this.name = "SupplementDoseConflictError";
  }
}

export function toApiSupplement(row: Record<string, unknown>): Supplement {
  const result: Record<string, unknown> = { name: row.name };

  for (const key of NON_NUTRIENT_OPTIONAL_FIELDS) {
    if (row[key] != null) result[key] = row[key];
  }

  const nutrients = nutrientColumnsToValues(row);
  for (const [key, value] of Object.entries(nutrients)) {
    if (value != null) result[key] = value;
  }

  return supplementSchema.parse(result);
}

function definitionsEqual(left: Supplement, right: Supplement): boolean {
  const parsedLeft = supplementSchema.parse(left);
  const parsedRight = supplementSchema.parse(right);
  const leftFields: Readonly<Record<string, unknown>> = parsedLeft;
  const rightFields: Readonly<Record<string, unknown>> = parsedRight;
  return SUPPLEMENT_DEFINITION_FIELDS.every((field) => leftFields[field] === rightFields[field]);
}

function toSupplementVersion(row: z.infer<typeof supplementViewRowSchema>): SupplementVersion {
  return {
    id: row.definition_id,
    scheduleId: row.schedule_id,
    definition: toApiSupplement(row),
  };
}

function startDateForDays(endDate: string, days: number): string {
  const date = new Date(`${endDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - (days - 1));
  return date.toISOString().slice(0, 10);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export class SupplementsRepository {
  readonly #db: Pick<Database, "execute" | "transaction">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(db: Pick<Database, "execute" | "transaction">, userId: string, timezone = "UTC") {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  async list(): Promise<Supplement[]> {
    const rows = await executeWithSchema(
      this.#db,
      supplementViewRowSchema,
      sql`SELECT * FROM fitness.v_supplement_with_nutrition
          WHERE user_id = ${this.#userId}
          ORDER BY sort_order ASC`,
    );
    return rows.map((row) => toApiSupplement(row));
  }

  async save(entries: Supplement[]): Promise<{ success: boolean; count: number }> {
    const supplements = supplementListSchema.parse(entries);
    const effectiveDate = formatDateYmdInTimeZone(new Date(), this.#timezone);

    await this.#db.transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT id
            FROM fitness.supplement
            WHERE user_id = ${this.#userId}
            FOR UPDATE`,
      );
      const currentRows = await executeWithSchema(
        transaction,
        supplementViewRowSchema,
        sql`SELECT * FROM fitness.v_supplement_with_nutrition
            WHERE user_id = ${this.#userId}
            ORDER BY sort_order ASC`,
      );
      const current = currentRows.map((row) => toSupplementVersion(row));
      const usedIds = new Set<string>();
      const exactMatches = supplements.map((entry) => {
        const existing = current.find(
          (candidate) => !usedIds.has(candidate.id) && candidate.definition.name === entry.name,
        );
        if (existing) usedIds.add(existing.id);
        return existing;
      });
      const operations = supplements.map((entry, index) => {
        let existing = exactMatches[index];
        existing ??= current.find(
          (candidate) => !usedIds.has(candidate.id) && current.indexOf(candidate) === index,
        );
        existing ??= current.find((candidate) => !usedIds.has(candidate.id));
        if (existing) usedIds.add(existing.id);
        return {
          entry,
          existing,
          index,
          changed: existing ? !definitionsEqual(existing.definition, entry) : true,
        };
      });

      const removed = current.filter((entry) => !usedIds.has(entry.id));
      for (const entry of [
        ...operations
          .filter((operation) => operation.changed)
          .flatMap((operation) => (operation.existing ? [operation.existing] : [])),
        ...removed,
      ]) {
        await transaction.execute(
          sql`UPDATE fitness.supplement_definition
              SET effective_to = ${effectiveDate}::date
              WHERE id = ${entry.id}::uuid
                AND effective_to IS NULL`,
        );
      }

      for (const operation of operations) {
        if (operation.existing && !operation.changed) {
          await transaction.execute(
            sql`UPDATE fitness.supplement
                SET sort_order = ${operation.index},
                    updated_at = NOW()
                WHERE id = ${operation.existing.scheduleId}::uuid
                  AND user_id = ${this.#userId}`,
          );
          continue;
        }

        let scheduleId = operation.existing?.scheduleId;
        if (scheduleId) {
          await transaction.execute(
            sql`UPDATE fitness.supplement
                SET sort_order = ${operation.index},
                    updated_at = NOW()
                WHERE id = ${scheduleId}::uuid
                  AND user_id = ${this.#userId}`,
          );
        } else {
          const [insertedSchedule] = await transaction
            .insert(supplement)
            .values({
              userId: this.#userId,
              sortOrder: operation.index,
            })
            .returning({ id: supplement.id });
          scheduleId = insertedSchedule?.id;
        }
        if (!scheduleId) {
          throw new Error(
            `Supplement schedule insert did not return an id (name="${operation.entry.name}", index=${operation.index})`,
          );
        }

        const [insertedDefinition] = await transaction
          .insert(supplementDefinition)
          .values({
            supplementId: scheduleId,
            supersedesDefinitionId: operation.existing?.id,
            name: operation.entry.name,
            amount: operation.entry.amount ?? null,
            unit: operation.entry.unit ?? null,
            form: operation.entry.form ?? null,
            description: operation.entry.description ?? null,
            meal: operation.entry.meal ?? null,
            effectiveFrom: effectiveDate,
          })
          .returning({ id: supplementDefinition.id });
        if (!insertedDefinition?.id) {
          throw new Error(
            `Supplement definition insert did not return an id (name="${operation.entry.name}", index=${operation.index})`,
          );
        }

        const nutrients = nutrientAmountEntriesFromLegacyFields(operation.entry);
        if (nutrients.length > 0) {
          await transaction.insert(supplementDefinitionNutrient).values(
            nutrients.map((nutrient) => ({
              definitionId: insertedDefinition.id,
              nutrientId: nutrient.nutrientId,
              amount: nutrient.amount,
            })),
          );
        }
      }
    });

    return { success: true, count: supplements.length };
  }

  async occurrences(days: number): Promise<SupplementDoseOccurrences> {
    const endDate = formatDateYmdInTimeZone(new Date(), this.#timezone);
    const startDate = startDateForDays(endDate, days);
    const rows = await executeWithSchema(
      this.#db,
      doseEventRowSchema,
      sql`SELECT
            event.id,
            event.supplement_id AS schedule_id,
            event.definition_id AS supplement_id,
            definition.name AS supplement_name,
            event.scheduled_date,
            event.status,
            event.supersedes_event_id,
            event.provider_id,
            event.source_name,
            event.recorded_at,
            event.created_at,
            NOT EXISTS (
              SELECT 1
              FROM fitness.supplement_dose_event AS successor
              WHERE successor.supersedes_event_id = event.id
            ) AS is_current
          FROM fitness.supplement_dose_event AS event
          INNER JOIN fitness.supplement_definition AS definition
            ON definition.id = event.definition_id
          WHERE event.user_id = ${this.#userId}
            AND event.scheduled_date >= ${startDate}::date
            AND event.scheduled_date <= ${endDate}::date
          ORDER BY event.scheduled_date DESC, event.created_at ASC, event.id ASC`,
    );

    const histories = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = `${row.schedule_id}:${row.scheduled_date}`;
      const history = histories.get(key) ?? [];
      history.push(row);
      histories.set(key, history);
    }

    const counts = { planned: 0, taken: 0, skipped: 0, unknown: 0 };
    const occurrences = [];
    for (const history of histories.values()) {
      const current = history.find((event) => event.is_current);
      if (!current) continue;
      counts[current.status]++;
      occurrences.push({
        currentEventId: current.id,
        scheduleId: current.schedule_id,
        supplementId: current.supplement_id,
        supplementName: current.supplement_name,
        scheduledDate: current.scheduled_date,
        status: current.status,
        history: history.map((event) => ({
          id: event.id,
          providerId: event.provider_id,
          status: event.status,
          recordedAt: event.recorded_at,
          sourceName: event.source_name,
        })),
      });
    }

    return { occurrences, counts };
  }

  async recordDose(
    expectedCurrentEventId: string,
    status: "taken" | "skipped",
  ): Promise<{ id: string; scheduledDate: string; status: "taken" | "skipped" }> {
    try {
      const result = await this.#db.transaction(async (transaction) => {
        const rows = await executeWithSchema(
          transaction,
          currentDoseEventRowSchema,
          sql`SELECT
                event.id,
                event.user_id,
                event.supplement_id AS schedule_id,
                event.definition_id AS supplement_id,
                event.scheduled_date
              FROM fitness.supplement_dose_event AS event
              WHERE event.id = ${expectedCurrentEventId}::uuid
                AND event.user_id = ${this.#userId}
                AND NOT EXISTS (
                  SELECT 1
                  FROM fitness.supplement_dose_event AS successor
                  WHERE successor.supersedes_event_id = event.id
                )
              FOR UPDATE`,
        );
        const current = rows[0];
        if (!current) throw new SupplementDoseConflictError();
        await ensureProvider(
          transaction,
          DOFEK_PROVIDER_ID,
          DOFEK_PROVIDER_NAME,
          undefined,
          this.#userId,
        );

        const inserted = await executeWithSchema(
          transaction,
          insertedIdRowSchema,
          sql`INSERT INTO fitness.supplement_dose_event (
                user_id,
                supplement_id,
                definition_id,
                provider_id,
                external_id,
                scheduled_date,
                status,
                supersedes_event_id,
                recorded_at,
                source_name
              )
              VALUES (
                ${this.#userId},
                ${current.schedule_id}::uuid,
                ${current.supplement_id}::uuid,
                ${DOFEK_PROVIDER_ID},
                ${`manual:${crypto.randomUUID()}`},
                ${current.scheduled_date}::date,
                ${status}::fitness.supplement_dose_status,
                ${current.id}::uuid,
                NOW(),
                ${DOFEK_PROVIDER_NAME}
              )
              RETURNING id`,
        );
        const result = inserted[0];
        if (!result) throw new Error("Supplement dose event insert did not return an id");
        return { id: result.id, scheduledDate: current.scheduled_date };
      });
      return { ...result, status };
    } catch (error: unknown) {
      if (error instanceof SupplementDoseConflictError || isUniqueViolation(error)) {
        throw new SupplementDoseConflictError();
      }
      throw error;
    }
  }
}
