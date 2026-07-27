import { formatDateYmdInTimeZone } from "@dofek/format/format";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import {
  type ExperimentSchedule,
  type PersonalExperimentPhase,
  type PersonalExperimentStatus,
  resolveExperimentSchedule,
  resolveOutcomeMetricLabel,
} from "../personal-experiments/experiment-schedule.ts";

const personalExperimentRowSchema = z.object({
  id: z.string(),
  hypothesis: z.string(),
  intervention: z.string(),
  outcome_metric_id: z.string(),
  lag_days: z.coerce.number().int(),
  baseline_days: z.coerce.number().int(),
  intervention_days: z.coerce.number().int(),
  start_date: dateStringSchema,
  status: z.enum(["active", "stopped"]),
  stopped_at: dateStringSchema.nullable(),
  created_at: timestampStringSchema,
});

const personalExperimentFullRowSchema = personalExperimentRowSchema.extend({
  user_id: z.string(),
});

export type PersonalExperimentRow = z.infer<typeof personalExperimentRowSchema>;
export type PersonalExperimentFullRow = z.infer<typeof personalExperimentFullRowSchema>;

export interface CreatePersonalExperimentInput {
  hypothesis: string;
  intervention: string;
  outcomeMetricId: string;
  lagDays: number;
  baselineDays: number;
  interventionDays: number;
  startDate: string;
}

export interface PersonalExperimentView {
  id: string;
  hypothesis: string;
  intervention: string;
  outcomeMetricId: string;
  outcomeMetricLabel: string;
  lagDays: number;
  baselineDays: number;
  interventionDays: number;
  startDate: string;
  status: PersonalExperimentStatus;
  stoppedAt: string | null;
  createdAt: string;
  phase: PersonalExperimentPhase;
  phaseLabel: string;
  schedule: ExperimentSchedule;
}

/** Data access for personal experiment setup and schedule enrichment. */
export class PersonalExperimentsRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(db: Pick<Database, "execute">, userId: string, timezone: string) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  async list(): Promise<PersonalExperimentView[]> {
    const rows = await executeWithSchema(
      this.#db,
      personalExperimentRowSchema,
      sql`SELECT id, hypothesis, intervention, outcome_metric_id, lag_days, baseline_days,
            intervention_days, start_date, status, stopped_at, created_at
          FROM fitness.personal_experiment
          WHERE user_id = ${this.#userId}
          ORDER BY created_at DESC`,
    );
    return rows.map((row) => this.#toView(row));
  }

  async get(id: string): Promise<PersonalExperimentView | null> {
    const rows = await executeWithSchema(
      this.#db,
      personalExperimentRowSchema,
      sql`SELECT id, hypothesis, intervention, outcome_metric_id, lag_days, baseline_days,
            intervention_days, start_date, status, stopped_at, created_at
          FROM fitness.personal_experiment
          WHERE user_id = ${this.#userId} AND id = ${id}`,
    );
    const row = rows[0];
    return row ? this.#toView(row) : null;
  }

  async create(input: CreatePersonalExperimentInput): Promise<PersonalExperimentView> {
    const rows = await executeWithSchema(
      this.#db,
      personalExperimentFullRowSchema,
      sql`INSERT INTO fitness.personal_experiment (
            user_id, hypothesis, intervention, outcome_metric_id, lag_days,
            baseline_days, intervention_days, start_date, status
          ) VALUES (
            ${this.#userId}, ${input.hypothesis}, ${input.intervention}, ${input.outcomeMetricId},
            ${input.lagDays}, ${input.baselineDays}, ${input.interventionDays},
            ${input.startDate}::date, 'active'
          )
          RETURNING *`,
    );
    const row = rows[0];
    if (!row) throw new Error("INSERT RETURNING returned no rows");
    return this.#toView(row);
  }

  async stop(id: string): Promise<PersonalExperimentView | null> {
    const today = formatDateYmdInTimeZone(new Date(), this.#timezone);
    const rows = await executeWithSchema(
      this.#db,
      personalExperimentFullRowSchema,
      sql`UPDATE fitness.personal_experiment
          SET status = 'stopped', stopped_at = ${today}::date
          WHERE user_id = ${this.#userId}
            AND id = ${id}
            AND status = 'active'
          RETURNING *`,
    );
    const row = rows[0];
    return row ? this.#toView(row) : null;
  }

  #toView(row: PersonalExperimentRow | PersonalExperimentFullRow): PersonalExperimentView {
    const schedule = resolveExperimentSchedule({
      startDate: row.start_date,
      baselineDays: row.baseline_days,
      interventionDays: row.intervention_days,
      status: row.status,
      stoppedAt: row.stopped_at,
      today: formatDateYmdInTimeZone(new Date(), this.#timezone),
    });

    return {
      id: row.id,
      hypothesis: row.hypothesis,
      intervention: row.intervention,
      outcomeMetricId: row.outcome_metric_id,
      outcomeMetricLabel: resolveOutcomeMetricLabel(row.outcome_metric_id),
      lagDays: row.lag_days,
      baselineDays: row.baseline_days,
      interventionDays: row.intervention_days,
      startDate: row.start_date,
      status: row.status,
      stoppedAt: row.stopped_at,
      createdAt: row.created_at,
      phase: schedule.phase,
      phaseLabel: schedule.phaseLabel,
      schedule,
    };
  }
}
