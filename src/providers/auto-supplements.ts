import { formatDateYmdInTimeZone } from "@dofek/format/format";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../db/execute-with-schema.ts";
import { ensureProvider } from "../db/tokens.ts";
import type { SyncRun } from "./sync-run.ts";
import type { SyncProvider, SyncResult } from "./types.ts";

const PROVIDER_ID = "auto-supplements";
const PROVIDER_NAME = "Auto-Supplements";

const timezoneRowSchema = z.object({ value: z.unknown() });
const supplementDefinitionRowSchema = z.object({
  id: z.string(),
  schedule_id: z.string(),
  effective_from: z.string(),
  effective_to: z.string().nullable(),
});
const insertedIdRowSchema = z.object({ id: z.string() });

function parseStoredTimezone(rows: unknown): string {
  const parsedRows = z.array(timezoneRowSchema).parse(rows);
  const value = parsedRows[0]?.value;
  if (value === undefined) return "UTC";
  const timezone = z.string().min(1, "Stored timezone must be a non-empty string").parse(value);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error(`Invalid stored timezone: ${timezone}`);
  }
  return timezone;
}

function datesInRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const current = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function definitionApplies(
  definition: z.infer<typeof supplementDefinitionRowSchema>,
  date: string,
): boolean {
  return definition.effective_from <= date && (definition.effective_to ?? "9999-12-31") > date;
}

export class AutoSupplementsProvider implements SyncProvider {
  readonly id = PROVIDER_ID;
  readonly name = PROVIDER_NAME;

  validate(): string | null {
    return null;
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const start = Date.now();
    const userId = run.options.userId;
    if (!userId) {
      throw new Error("auto-supplements sync requires userId");
    }

    const timezone = parseStoredTimezone(
      await executeWithSchema(
        run.db,
        timezoneRowSchema,
        sql`SELECT value
            FROM fitness.user_settings
            WHERE user_id = ${userId}
              AND key = 'timezone'
            LIMIT 1`,
      ),
    );
    const startDate = formatDateYmdInTimeZone(run.window.since, timezone);
    const endDate = formatDateYmdInTimeZone(run.window.until, timezone);
    const today = formatDateYmdInTimeZone(new Date(), timezone);

    const definitions = await executeWithSchema(
      run.db,
      supplementDefinitionRowSchema,
      sql`SELECT
              definition.id,
              definition.supplement_id AS schedule_id,
              definition.effective_from,
              definition.effective_to
            FROM fitness.supplement_definition AS definition
            INNER JOIN fitness.supplement AS supplement
              ON supplement.id = definition.supplement_id
            WHERE supplement.user_id = ${userId}
              AND definition.effective_from <= ${endDate}::date
              AND (definition.effective_to IS NULL OR definition.effective_to > ${startDate}::date)
            ORDER BY definition.supplement_id, definition.effective_from, definition.created_at`,
    );
    if (definitions.length === 0) {
      return {
        provider: PROVIDER_ID,
        recordsSynced: 0,
        errors: [],
        duration: Date.now() - start,
      };
    }

    await ensureProvider(run.db, PROVIDER_ID, PROVIDER_NAME, undefined, userId);

    let recordsSynced = 0;
    const recordedAt = new Date();
    for (const definition of definitions) {
      for (const date of datesInRange(startDate, endDate)) {
        if (!definitionApplies(definition, date)) continue;
        const status = date < today ? "unknown" : "planned";
        const inserted = await executeWithSchema(
          run.db,
          insertedIdRowSchema,
          sql`INSERT INTO fitness.supplement_dose_event (
                user_id,
                supplement_id,
                definition_id,
                provider_id,
                external_id,
                scheduled_date,
                status,
                recorded_at,
                source_name
              )
              VALUES (
                ${userId},
                ${definition.schedule_id}::uuid,
                ${definition.id}::uuid,
                ${PROVIDER_ID},
                ${`schedule:${definition.schedule_id}:${date}:${status}`},
                ${date}::date,
                ${status}::fitness.supplement_dose_status,
                ${recordedAt},
                ${PROVIDER_NAME}
              )
              ON CONFLICT DO NOTHING
              RETURNING id`,
        );
        recordsSynced += inserted.length;
      }
    }

    const advanced = await executeWithSchema(
      run.db,
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
            SELECT
              current.user_id,
              current.supplement_id,
              current.definition_id,
              ${PROVIDER_ID},
              'schedule:' || current.supplement_id::text || ':' || current.scheduled_date::text
                || ':unknown:' || current.id::text,
              current.scheduled_date,
              'unknown'::fitness.supplement_dose_status,
              current.id,
              ${recordedAt},
              ${PROVIDER_NAME}
            FROM fitness.v_supplement_dose_current AS current
            WHERE current.user_id = ${userId}
              AND current.status = 'planned'
              AND current.scheduled_date >= ${startDate}::date
              AND current.scheduled_date <= ${endDate}::date
              AND current.scheduled_date < ${today}::date
            ON CONFLICT DO NOTHING
            RETURNING id`,
    );
    recordsSynced += advanced.length;

    return {
      provider: PROVIDER_ID,
      recordsSynced,
      errors: [],
      duration: Date.now() - start,
    };
  }
}
