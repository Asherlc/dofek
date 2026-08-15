import { formatDateYmdInTimeZone } from "@dofek/format/format";
import {
  type SupplementDoseOccurrences,
  supplementDoseStatusSchema,
} from "@dofek/format/supplement-dose-events";
import type { Database } from "dofek/db";
import {
  nutrientColumnsToValues,
  nutrientFieldsSchema,
  nutrientRowSchema,
} from "dofek/db/nutrient-columns";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";

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

function startDateForDays(endDate: string, days: number): string {
  const date = new Date(`${endDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - (days - 1));
  return date.toISOString().slice(0, 10);
}

export class SupplementsRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(db: Pick<Database, "execute">, userId: string, timezone = "UTC") {
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
}
