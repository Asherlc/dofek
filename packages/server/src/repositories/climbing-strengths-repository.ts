import { formatDateYmdInTimeZone } from "@dofek/format/format";
import { climbingWallAngleSchema } from "@dofek/training/climbing-experience";
import type { ClimbingFilters } from "@dofek/training/climbing-filters";
import {
  type ClimbingGradePreference,
  DEFAULT_CLIMBING_GRADE_PREFERENCE,
  FREE_ROCK_GRADE_SYSTEMS,
  gradeSystemLabel,
} from "@dofek/training/climbing-grades";
import { attemptScopeSchema, ropeMethodSchema } from "@dofek/training/climbing-log";
import { climbingProgressionLaneKey } from "@dofek/training/climbing-progression";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateWindowStartString } from "../lib/date-window.ts";
import type { ClimbingStrengthsObservation } from "../services/climbing-strengths.ts";
import { canonicalClimbingLogCtes } from "./climbing-canonical-observations.ts";
import { displayClimbingGrade } from "./climbing-grade-display.ts";
import { climbingSourceLinks } from "./climbing-source-links.ts";

const rowSchema = z.object({
  id: z.string(),
  canonical_activity_id: z.string().nullable(),
  session_date: z.string(),
  provider_id: z.string(),
  source_name: z.string().nullable(),
  raw: z.unknown(),
  climb_id: z.string().nullable(),
  climb_name: z.string().nullable(),
  title: z.string().nullable(),
  area_path: z.array(z.object({ name: z.string().nullable() })),
  climb_kind: z.enum(["boulder", "route"]),
  attempt_scope: attemptScopeSchema,
  pitch_id: z.string().nullable(),
  pitch_number: z.number().nullable(),
  grade: z.string().nullable(),
  grade_system: z.enum(FREE_ROCK_GRADE_SYSTEMS).nullable(),
  setting: z.enum(["indoor", "outdoor"]).nullable(),
  wall_angle: climbingWallAngleSchema.nullable(),
  hold_type: z.string().nullable(),
  attempt_observations: z.array(
    z.object({
      ropeMethod: ropeMethodSchema.nullable(),
      solo: z.boolean().nullable(),
      usedAid: z.boolean().nullable(),
      sends: z.number(),
      unknownOutcomes: z.number(),
    }),
  ),
});
/** Canonical ownership, calendar dates, visibility and outcome projection shared with existing charts. */
export class ClimbingStrengthsRepository extends BaseRepository {
  readonly #preference: ClimbingGradePreference;
  constructor(
    db: ConstructorParameters<typeof BaseRepository>[0],
    userId: string,
    timezone: string,
    accessWindow?: ConstructorParameters<typeof BaseRepository>[3],
    preference: ClimbingGradePreference = DEFAULT_CLIMBING_GRADE_PREFERENCE,
  ) {
    super(db, userId, timezone, accessWindow);
    this.#preference = preference;
  }
  async getObservations(
    days: number | null,
    filters: ClimbingFilters = {},
    endDate?: string,
  ): Promise<ClimbingStrengthsObservation[]> {
    const rows = await this.query(
      rowSchema,
      sql`WITH ${canonicalClimbingLogCtes(days === null ? { endDate: endDate ?? formatDateYmdInTimeZone(new Date(), this.timezone) } : endDate === undefined ? days : { startDate: dateWindowStartString(endDate, days - 1), endDate }, filters, this.#preference, this.userId, this.timezone, (date) => this.dateAccessPredicate(date))} SELECT * FROM dated_logs ORDER BY session_date DESC,id`,
    );
    // A full recorded location/name match is the existing cross-source identity rule.
    // Ambiguous names within one provider retain their native catalogue identities.
    const normalize = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");
    const namedKey = (row: z.infer<typeof rowSchema>) =>
      row.climb_name?.trim() &&
      row.area_path.length &&
      row.area_path.every((area) => area.name?.trim())
        ? JSON.stringify([
            normalize(row.climb_name),
            row.area_path.map((area) => normalize(area.name ?? "")),
          ])
        : null;
    const namedIds = new Map<string, Map<string, Set<string>>>();
    for (const row of rows) {
      const name = namedKey(row);
      if (!name || !row.climb_id) continue;
      const providers = namedIds.get(name) ?? new Map<string, Set<string>>();
      const ids = providers.get(row.provider_id) ?? new Set<string>();
      ids.add(row.climb_id);
      providers.set(row.provider_id, ids);
      namedIds.set(name, providers);
    }
    return rows.flatMap((row) => {
      const grade =
        row.grade && row.grade_system
          ? displayClimbingGrade(this.#preference, row.climb_kind, row.grade_system, row.grade)
          : null;
      const named = namedKey(row);
      const unambiguous =
        named && [...(namedIds.get(named)?.values() ?? [])].every((ids) => ids.size === 1);
      const climbIdentity = row.climb_id ? (unambiguous ? named : row.climb_id) : null;
      const identity =
        climbIdentity &&
        (row.attempt_scope === "climb" || row.pitch_number !== null || row.pitch_id !== null)
          ? JSON.stringify([climbIdentity, row.attempt_scope, row.pitch_number ?? row.pitch_id])
          : null;
      return row.attempt_observations.map((attempt) => {
        const outcome =
          attempt.sends > 0
            ? ("sent" as const)
            : attempt.unknownOutcomes > 0
              ? null
              : ("not_sent" as const);
        const laneKey = climbingProgressionLaneKey({
          climbKind: row.climb_kind,
          attemptScope: row.attempt_scope,
          ...attempt,
          usedAid: attempt.usedAid === true,
        });
        const gradeSystem = grade?.gradeSystem ?? row.grade_system;
        const contextKey = JSON.stringify([laneKey, gradeSystem]);
        const method = attempt.ropeMethod?.replaceAll("_", " ");
        const labels = [
          row.climb_kind === "boulder"
            ? "Bouldering"
            : method
              ? method.charAt(0).toUpperCase() + method.slice(1)
              : "Routes",
          row.attempt_scope === "pitch" ? "Pitch" : null,
          attempt.solo === true ? "Solo" : attempt.solo === false ? "With belayer" : null,
          attempt.usedAid === true ? "Aid" : null,
          grade ? gradeSystemLabel(grade.gradeSystem) : null,
        ].filter((label) => label !== null);
        return {
          identity,
          contextKey,
          laneKey,
          gradeSystem,
          contextLabel: labels.join(" · "),
          setting: row.setting,
          grade: grade?.grade ?? null,
          gradeSortValue: grade?.gradeSortValue ?? 0,
          wallAngle: row.wall_angle,
          holdType: row.hold_type,
          outcome,
          example: {
            logEntryId: row.id,
            activityId: row.canonical_activity_id,
            name: row.climb_name ?? row.title ?? "Unnamed climb",
            grade: grade?.grade ?? "Unknown grade",
            date: row.session_date,
            providerId: row.provider_id,
            sourceName: row.source_name ?? row.provider_id,
            sourceUrl: climbingSourceLinks(row.provider_id, row.raw)[0]?.url ?? null,
            outcome: outcome ?? "not_sent",
          },
        };
      });
    });
  }
}
