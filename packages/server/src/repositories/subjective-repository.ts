import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateStringSchema, executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";

export const subjectiveKindSchema = z.enum(["soreness", "stiffness", "tenderness"]);
export const injuryKindSchema = z.enum(["injury", "niggle"]);

const regionRowSchema = z.object({
  id: z.string(),
  parent_id: z.string().nullable(),
  label: z.string(),
  kind: z.string(),
  sort_order: z.coerce.number(),
});

const checkInRowSchema = z.object({
  id: z.string(),
  date: dateStringSchema,
  created_at: timestampStringSchema,
  updated_at: timestampStringSchema,
});

const symptomRowSchema = z.object({
  id: z.string(),
  body_region_id: z.string(),
  kind: subjectiveKindSchema,
  score: z.coerce.number().int().min(1).max(10),
});

const timelineSymptomRowSchema = symptomRowSchema.extend({
  check_in_id: z.string(),
});

const injuryRowSchema = z.object({
  id: z.string(),
  kind: injuryKindSchema,
  body_region_id: z.string(),
  onset_date: dateStringSchema,
  resolved_date: dateStringSchema.nullable(),
  severity: z.coerce.number().int().min(0).max(10).nullable(),
  description: z.string(),
  created_at: timestampStringSchema,
  updated_at: timestampStringSchema,
});

export type SubjectiveRegion = z.infer<typeof regionRowSchema>;
export type SubjectiveSymptom = z.infer<typeof symptomRowSchema>;
export type InjuryEvent = z.infer<typeof injuryRowSchema>;

export interface SaveCheckInSymptom {
  bodyRegionId: string;
  kind: z.infer<typeof subjectiveKindSchema>;
  score: number;
}

export interface SubjectiveCheckIn {
  date: string;
  logged: boolean;
  symptoms: SubjectiveSymptom[];
}

export interface SubjectiveTimeline {
  checkIns: SubjectiveCheckIn[];
  injuries: InjuryEvent[];
}

type TransactionalDatabase = Pick<Database, "execute" | "transaction">;

export class SubjectiveRepository extends BaseRepository<TransactionalDatabase> {
  async regions(): Promise<SubjectiveRegion[]> {
    return this.query(
      regionRowSchema,
      sql`SELECT id, parent_id, label, kind, sort_order
          FROM fitness.body_region
          ORDER BY sort_order, id`,
    );
  }

  async checkIn(date: string): Promise<SubjectiveCheckIn> {
    return readCheckIn(this.db, this.userId, date);
  }

  async saveCheckIn(date: string, symptoms: SaveCheckInSymptom[]): Promise<SubjectiveCheckIn> {
    await this.db.transaction(async (transaction) => {
      const rows = await executeWithSchema(
        transaction,
        checkInRowSchema,
        sql`INSERT INTO fitness.subjective_check_in (user_id, date)
            VALUES (${this.userId}::uuid, ${date}::date)
            ON CONFLICT (user_id, date)
            DO UPDATE SET updated_at = now()
            RETURNING id::text AS id, date::text AS date, created_at::text AS created_at, updated_at::text AS updated_at`,
      );
      const checkIn = rows[0];
      if (!checkIn) throw new Error("Subjective check-in upsert returned no row");

      await transaction.execute(
        sql`DELETE FROM fitness.subjective_symptom WHERE check_in_id = ${checkIn.id}::uuid`,
      );
      if (symptoms.length > 0) {
        await transaction.execute(
          sql`INSERT INTO fitness.subjective_symptom (check_in_id, body_region_id, kind, score)
              VALUES ${sql.join(
                symptoms.map(
                  (symptom) =>
                    sql`(${checkIn.id}::uuid, ${symptom.bodyRegionId}, ${symptom.kind}, ${symptom.score})`,
                ),
                sql`, `,
              )}`,
        );
      }
    });
    return this.checkIn(date);
  }

  async injuries(): Promise<InjuryEvent[]> {
    return this.query(
      injuryRowSchema,
      sql`SELECT id::text AS id, kind, body_region_id, onset_date::text AS onset_date,
                 resolved_date::text AS resolved_date, severity, description,
                 created_at::text AS created_at, updated_at::text AS updated_at
          FROM fitness.injury_event
          WHERE user_id = ${this.userId}::uuid
          ORDER BY onset_date DESC, created_at DESC`,
    );
  }

  async createInjury(input: {
    kind: z.infer<typeof injuryKindSchema>;
    bodyRegionId: string;
    onsetDate: string;
    resolvedDate: string | null;
    severity: number | null;
    description: string;
  }): Promise<InjuryEvent> {
    const rows = await this.query(
      injuryRowSchema,
      sql`INSERT INTO fitness.injury_event
            (user_id, kind, body_region_id, onset_date, resolved_date, severity, description)
          VALUES
            (${this.userId}::uuid, ${input.kind}, ${input.bodyRegionId}, ${input.onsetDate}::date,
             ${input.resolvedDate}::date, ${input.severity}, ${input.description})
          RETURNING id::text AS id, kind, body_region_id, onset_date::text AS onset_date,
                    resolved_date::text AS resolved_date, severity, description,
                    created_at::text AS created_at, updated_at::text AS updated_at`,
    );
    const row = rows[0];
    if (!row) throw new Error("Injury insert returned no row");
    return row;
  }

  async updateInjury(
    id: string,
    changes: Partial<{
      kind: z.infer<typeof injuryKindSchema>;
      bodyRegionId: string;
      onsetDate: string;
      resolvedDate: string | null;
      severity: number | null;
      description: string;
    }>,
  ): Promise<InjuryEvent | null> {
    const setClauses = [sql`updated_at = now()`];
    if (changes.kind !== undefined) setClauses.push(sql`kind = ${changes.kind}`);
    if (changes.bodyRegionId !== undefined)
      setClauses.push(sql`body_region_id = ${changes.bodyRegionId}`);
    if (changes.onsetDate !== undefined)
      setClauses.push(sql`onset_date = ${changes.onsetDate}::date`);
    if (changes.resolvedDate !== undefined)
      setClauses.push(
        changes.resolvedDate === null
          ? sql`resolved_date = NULL`
          : sql`resolved_date = ${changes.resolvedDate}::date`,
      );
    if (changes.severity !== undefined) setClauses.push(sql`severity = ${changes.severity}`);
    if (changes.description !== undefined)
      setClauses.push(sql`description = ${changes.description}`);
    const rows = await this.query(
      injuryRowSchema,
      sql`UPDATE fitness.injury_event
          SET ${sql.join(setClauses, sql`, `)}
          WHERE id = ${id}::uuid AND user_id = ${this.userId}::uuid
          RETURNING id::text AS id, kind, body_region_id, onset_date::text AS onset_date,
                    resolved_date::text AS resolved_date, severity, description,
                    created_at::text AS created_at, updated_at::text AS updated_at`,
    );
    return rows[0] ?? null;
  }

  async deleteInjury(id: string): Promise<boolean> {
    const rows = await this.query(
      z.object({ id: z.string() }),
      sql`DELETE FROM fitness.injury_event
          WHERE id = ${id}::uuid AND user_id = ${this.userId}::uuid
          RETURNING id::text AS id`,
    );
    return rows.length > 0;
  }

  async timeline(startDate: string, endDate: string): Promise<SubjectiveTimeline> {
    const [checkInRows, injuryRows] = await Promise.all([
      this.query(
        checkInRowSchema,
        sql`SELECT id::text AS id, date::text AS date, created_at::text AS created_at,
                   updated_at::text AS updated_at
            FROM fitness.subjective_check_in
            WHERE user_id = ${this.userId}::uuid
              AND date BETWEEN ${startDate}::date AND ${endDate}::date
            ORDER BY date`,
      ),
      this.query(
        injuryRowSchema,
        sql`SELECT id::text AS id, kind, body_region_id, onset_date::text AS onset_date,
                   resolved_date::text AS resolved_date, severity, description,
                   created_at::text AS created_at, updated_at::text AS updated_at
            FROM fitness.injury_event
            WHERE user_id = ${this.userId}::uuid
              AND onset_date <= ${endDate}::date
              AND (resolved_date IS NULL OR resolved_date >= ${startDate}::date)
            ORDER BY onset_date, created_at`,
      ),
    ]);
    const symptoms =
      checkInRows.length === 0
        ? []
        : await this.query(
            timelineSymptomRowSchema,
            sql`SELECT id::text AS id, check_in_id::text AS check_in_id, body_region_id, kind, score
              FROM fitness.subjective_symptom
              WHERE check_in_id IN (${sql.join(
                checkInRows.map((row) => sql`${row.id}::uuid`),
                sql`, `,
              )})
              ORDER BY id`,
          );
    const symptomsByCheckIn = new Map<string, SubjectiveSymptom[]>();
    for (const symptom of symptoms) {
      const list = symptomsByCheckIn.get(symptom.check_in_id) ?? [];
      list.push(symptom);
      symptomsByCheckIn.set(symptom.check_in_id, list);
    }
    return {
      checkIns: checkInRows.map((row) => ({
        date: row.date,
        logged: true,
        symptoms: symptomsByCheckIn.get(row.id) ?? [],
      })),
      injuries: injuryRows,
    };
  }
}

async function readCheckIn(
  db: Pick<Database, "execute">,
  userId: string,
  date: string,
): Promise<SubjectiveCheckIn> {
  const checkIns = await executeWithSchema(
    db,
    checkInRowSchema,
    sql`SELECT id::text AS id, date::text AS date, created_at::text AS created_at,
               updated_at::text AS updated_at
        FROM fitness.subjective_check_in
        WHERE user_id = ${userId}::uuid AND date = ${date}::date`,
  );
  const checkIn = checkIns[0];
  if (!checkIn) return { date, logged: false, symptoms: [] };
  const symptoms = await executeWithSchema(
    db,
    symptomRowSchema,
    sql`SELECT id::text AS id, body_region_id, kind, score
        FROM fitness.subjective_symptom
        WHERE check_in_id = ${checkIn.id}::uuid
        ORDER BY id`,
  );
  return { date: checkIn.date, logged: true, symptoms };
}
