import { formatDateYmdInTimeZone } from "@dofek/format/format";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import {
  buildExperimentAnalysis,
  type ExperimentAnalysis,
} from "../personal-experiments/experiment-analysis.ts";
import {
  type ExperimentSchedule,
  type PersonalExperimentPhase,
  type PersonalExperimentStatus,
  resolveExperimentSchedule,
  resolveOutcomeMetricLabel,
} from "../personal-experiments/experiment-schedule.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { CorrelationRepository } from "./correlation-repository.ts";

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

const personalExperimentCheckInRowSchema = z.object({
  id: z.string(),
  personal_experiment_id: z.string(),
  date: dateStringSchema,
  adherence: z.enum(["adherent", "partial", "not_adherent", "unknown"]),
  confounder: z.string().nullable(),
  note: z.string().nullable(),
  created_at: timestampStringSchema,
});

const personalExperimentAnnotationRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  started_at: dateStringSchema,
  ended_at: dateStringSchema.nullable(),
  category: z.string().nullable(),
  ongoing: z.coerce.boolean(),
  notes: z.string().nullable(),
  created_at: timestampStringSchema,
});

export type PersonalExperimentRow = z.infer<typeof personalExperimentRowSchema>;
export type PersonalExperimentFullRow = z.infer<typeof personalExperimentFullRowSchema>;
export type PersonalExperimentCheckInRow = z.infer<typeof personalExperimentCheckInRowSchema>;

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

export interface UpsertPersonalExperimentCheckInInput {
  date: string;
  adherence: PersonalExperimentCheckInRow["adherence"];
  confounder: string | null;
  note: string | null;
}

export interface PersonalExperimentCheckInView {
  id: string;
  date: string;
  adherence: PersonalExperimentCheckInRow["adherence"];
  confounder: string | null;
  note: string | null;
  createdAt: string;
}

export interface PersonalExperimentAnalysisView {
  outcomeMetricId: string;
  outcomeMetricLabel: string;
  checkIns: PersonalExperimentCheckInView[];
  annotations: PersonalExperimentAnnotation[];
  analysis: ExperimentAnalysis;
}

export interface PersonalExperimentAnnotation {
  id: string;
  label: string;
  startedAt: string;
  endedAt: string | null;
  category: string | null;
  ongoing: boolean;
  notes: string | null;
  createdAt: string;
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

  async upsertCheckIn(
    id: string,
    input: UpsertPersonalExperimentCheckInInput,
  ): Promise<PersonalExperimentCheckInView | null> {
    const rows = await executeWithSchema(
      this.#db,
      personalExperimentCheckInRowSchema,
      sql`INSERT INTO fitness.personal_experiment_check_in (
            personal_experiment_id, date, adherence, confounder, note
          )
          SELECT id, ${input.date}::date, ${input.adherence}, ${input.confounder}, ${input.note}
          FROM fitness.personal_experiment
          WHERE id = ${id} AND user_id = ${this.#userId}
          ON CONFLICT (personal_experiment_id, date)
          DO UPDATE SET
            adherence = EXCLUDED.adherence,
            confounder = EXCLUDED.confounder,
            note = EXCLUDED.note
          RETURNING id, personal_experiment_id, date, adherence, confounder, note, created_at`,
    );
    const row = rows[0];
    return row ? this.#toCheckInView(row) : null;
  }

  async analyze(
    id: string,
    sensorStore: Pick<ActivitySensorStore, "query">,
  ): Promise<PersonalExperimentAnalysisView | null> {
    const experiment = await this.get(id);
    if (!experiment) return null;
    const checkInRows = await executeWithSchema(
      this.#db,
      personalExperimentCheckInRowSchema,
      sql`SELECT id, personal_experiment_id, date, adherence, confounder, note, created_at
          FROM fitness.personal_experiment_check_in
          WHERE personal_experiment_id = ${id}
          ORDER BY date ASC`,
    );
    const annotationRows = await executeWithSchema(
      this.#db,
      personalExperimentAnnotationRowSchema,
      sql`SELECT id, label, started_at, ended_at, category, ongoing, notes, created_at
          FROM fitness.life_events
          WHERE user_id = ${this.#userId} AND personal_experiment_id = ${id}
          ORDER BY started_at ASC, created_at ASC`,
    );
    const outcomeStartDate = addCalendarDays(
      experiment.schedule.baselineStartDate,
      experiment.lagDays,
    );
    const outcomeEndDate = addCalendarDays(
      experiment.schedule.interventionEndDate,
      experiment.lagDays,
    );
    const outcomes = await new CorrelationRepository(
      this.#db,
      this.#userId,
      this.#timezone,
      sensorStore,
    ).listMetricOutcomes(
      experiment.outcomeMetricId,
      inclusiveDayCount(outcomeStartDate, outcomeEndDate),
      outcomeEndDate,
    );
    const checkIns = checkInRows.map((row) => this.#toCheckInView(row));

    return {
      outcomeMetricId: experiment.outcomeMetricId,
      outcomeMetricLabel: experiment.outcomeMetricLabel,
      checkIns,
      annotations: annotationRows.map((row) => ({
        id: row.id,
        label: row.label,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        category: row.category,
        ongoing: row.ongoing,
        notes: row.notes,
        createdAt: row.created_at,
      })),
      analysis: buildExperimentAnalysis({
        lagDays: experiment.lagDays,
        schedule: experiment.schedule,
        checkIns: checkIns.map((checkIn) => ({
          ...checkIn,
        })),
        outcomes,
      }),
    };
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

  #toCheckInView(row: PersonalExperimentCheckInRow): PersonalExperimentCheckInView {
    return {
      id: row.id,
      date: row.date,
      adherence: row.adherence,
      confounder: row.confounder,
      note: row.note,
      createdAt: row.created_at,
    };
  }
}

function addCalendarDays(date: string, days: number): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function inclusiveDayCount(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00.000Z`).getTime();
  const end = new Date(`${endDate}T00:00:00.000Z`).getTime();
  return Math.round((end - start) / 86_400_000) + 1;
}
