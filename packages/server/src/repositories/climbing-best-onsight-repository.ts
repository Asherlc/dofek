import { formatDateYmdInTimeZone } from "@dofek/format/format";
import {
  type ClimbingBestOnsight,
  type ClimbingBestOnsightCell,
  type ClimbingBestOnsightType,
  climbingBestOnsightSchema,
} from "@dofek/training/climbing-best-onsight";
import { climbingTypeOptions } from "@dofek/training/climbing-filters";
import {
  DEFAULT_CLIMBING_GRADE_PREFERENCE,
  type FreeRockGradeSystem,
  gradeSortValue,
  isGradeSystemForClimbKind,
} from "@dofek/training/climbing-grades";
import {
  climbSettingSchema,
  gradeComponentSchema,
  ropeMethodSchema,
} from "@dofek/training/climbing-log";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import { rockClimbingLogProjection } from "./climbing-rock-observations.ts";

const boundsSchema = z.object({ start_date: dateStringSchema, end_date: dateStringSchema });
const attemptObservationSchema = z.object({
  ropeMethod: ropeMethodSchema.nullable(),
  onsight: z.boolean().nullable(),
});
const candidateSchema = z.object({
  entry_id: z.uuid(),
  provider_id: z.string(),
  climbed_on: dateStringSchema,
  climb_kind: z.enum(["boulder", "route"]),
  setting: climbSettingSchema,
  published_grades: z.array(gradeComponentSchema),
  reported_grades: z.array(gradeComponentSchema),
  attempt_observations: z.array(attemptObservationSchema),
});

type Candidate = z.infer<typeof candidateSchema>;
type SettingCell = "gym" | "outdoor";
interface RankedCell extends ClimbingBestOnsightCell {
  sort: number;
  climbedOn: string;
}

function selectedGrade(
  candidate: Candidate,
): { value: string; system: FreeRockGradeSystem; sort: number } | null {
  for (const components of [candidate.published_grades, candidate.reported_grades]) {
    for (const component of components) {
      // An unknown grade system is valid but cannot be placed on a ranking scale.
      if (component.system === null) continue;
      if (!isGradeSystemForClimbKind(component.system, candidate.climb_kind)) continue;
      const sort = gradeSortValue(component.value, component.system);
      if (sort === null) continue;
      return { value: component.value, system: component.system, sort };
    }
  }
  return null;
}

function outranks(left: RankedCell, right: RankedCell): boolean {
  return (
    left.sort > right.sort ||
    (left.sort === right.sort &&
      (left.climbedOn > right.climbedOn ||
        (left.climbedOn === right.climbedOn && left.recordId < right.recordId)))
  );
}

/** Best recorded onsight per type and setting over the trailing 12 calendar months. */
export class ClimbingBestOnsightRepository extends BaseRepository {
  async getBestOnsight(now: Date = new Date()): Promise<ClimbingBestOnsight> {
    const localDate = formatDateYmdInTimeZone(now, this.timezone);
    const [bounds] = await this.query(
      boundsSchema,
      sql`
      SELECT
        ((${localDate}::date - interval '1 year') + interval '1 day')::date::text AS start_date,
        ${localDate}::date::text AS end_date
    `,
    );
    if (!bounds) throw new Error("Could not compute the local 12-month onsight window");

    const datedInput = sql`(
      SELECT entry.*
      FROM fitness.v_climbing_log_entry AS entry
      JOIN fitness.climb AS stored_climb
        ON stored_climb.id = entry.climb_id AND stored_climb.user_id = ${this.userId}::uuid
      WHERE entry.user_id = ${this.userId}::uuid
        AND entry.climbed_on BETWEEN ${bounds.start_date}::date AND ${bounds.end_date}::date
        ${this.dateAccessPredicate(sql`entry.climbed_on`)}
        AND stored_climb.setting IS NOT NULL
    )`;
    const projection = rockClimbingLogProjection(DEFAULT_CLIMBING_GRADE_PREFERENCE, {}, datedInput);
    const candidates = await this.query(
      candidateSchema,
      sql`
      SELECT
        ce.id::text AS entry_id,
        ce.provider_id,
        ce.climbed_on::text AS climbed_on,
        ce.climb_kind,
        ce.setting,
        ce.published_grades,
        ce.reported_grades,
        COALESCE(ce.attempt_observations, '[]'::jsonb) AS attempt_observations
      FROM (${projection}) AS ce
      WHERE ce.attempt_scope = 'climb'
        AND ce.rock_result_labels ->> 'onsight' = 'true'
    `,
    );

    const ranked = new Map<ClimbingBestOnsightType, Map<SettingCell, RankedCell>>();
    for (const candidate of candidates) {
      const grade = selectedGrade(candidate);
      if (!grade) continue;
      const cellKey: SettingCell = candidate.setting === "indoor" ? "gym" : "outdoor";
      const types = new Set<ClimbingBestOnsightType>();
      for (const observation of candidate.attempt_observations) {
        if (observation.onsight !== true) continue;
        const type = candidate.climb_kind === "boulder" ? "bouldering" : observation.ropeMethod;
        if (type) types.add(type);
      }
      for (const type of types) {
        let bySetting = ranked.get(type);
        if (!bySetting) {
          bySetting = new Map<SettingCell, RankedCell>();
          ranked.set(type, bySetting);
        }
        const next: RankedCell = {
          grade: grade.value,
          gradeSystem: grade.system,
          providerId: candidate.provider_id,
          recordId: candidate.entry_id,
          sort: grade.sort,
          climbedOn: candidate.climbed_on,
        };
        const current = bySetting.get(cellKey);
        if (!current || outranks(next, current)) bySetting.set(cellKey, next);
      }
    }

    const rows = climbingTypeOptions.map(([type]) => {
      const bySetting = ranked.get(type);
      const cell = (key: SettingCell): ClimbingBestOnsightCell | null => {
        const best = bySetting?.get(key);
        if (!best) return null;
        const { grade, gradeSystem, providerId, recordId } = best;
        return { grade, gradeSystem, providerId, recordId };
      };
      return { type, gym: cell("gym"), outdoor: cell("outdoor") };
    });

    return climbingBestOnsightSchema.parse({
      startDate: bounds.start_date,
      endDate: bounds.end_date,
      rows,
    });
  }
}
