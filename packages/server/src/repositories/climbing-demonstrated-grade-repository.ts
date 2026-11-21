import {
  buildDemonstratedGrade,
  type ClimbingDemonstratedGrade,
  type ClimbingDemonstratedGradeInput,
  climbingDemonstratedGradeSchema,
  type DemonstratedGradeCoverage,
  type DemonstratedGradeObservation,
  demonstratedGradeInputSchema,
  demonstratedGradeWindow,
} from "@dofek/training/climbing-demonstrated-grade";
import type { ClimbingFilters } from "@dofek/training/climbing-filters";
import {
  type ClimbingGradePreference,
  DEFAULT_CLIMBING_GRADE_PREFERENCE,
  FREE_ROCK_GRADE_SYSTEMS,
  gradeSortValue,
  isValidClimbingGrade,
} from "@dofek/training/climbing-grades";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { postgresActivityCalendarDate } from "./activity-local-date.ts";
import { rockClimbingLogProjection } from "./climbing-rock-observations.ts";
import { climbingSourceLinks } from "./climbing-source-links.ts";

const gradeComponentRowSchema = z.object({ value: z.string(), system: z.string().nullable() });

const evidenceRowSchema = z.object({
  attempt_id: z.string(),
  target_id: z.string(),
  provider: z.string(),
  provider_id: z.string().nullable(),
  climb_kind: z.enum(["boulder", "route"]),
  climb_setting: z.enum(["indoor", "outdoor"]).nullable(),
  rope_method: z.enum(["lead", "top_rope", "follow", "unroped"]).nullable(),
  climbed_on: z.iso.date().nullable(),
  published_grades: z.array(gradeComponentRowSchema),
  wall_angle: z.record(z.string(), z.unknown()).nullable(),
  log_raw: z.record(z.string(), z.unknown()).nullable(),
  display_name: z.string().nullable(),
  log_entry_id: z.string(),
  activity_id: z.string().nullable(),
  climb_external_id: z.string().nullable(),
  source_completed: z.boolean().nullable(),
  source_result: z.string().nullable(),
  fell_or_hung: z.boolean().nullable(),
  used_aid: z.boolean().nullable(),
  dabbed: z.boolean().nullable(),
});

const boardSeshAscentSchema = z.object({
  boardType: z.string(),
  climbUuid: z.string(),
  canonicalClimbUuid: z.string().min(1).optional(),
  isMirror: z.boolean(),
  angle: z.number(),
  consensusDifficulty: z.number().nullable().optional(),
  consensusDifficultyName: z.string().nullable().optional(),
});
const boardSeshGradesSchema = z.array(
  z.object({ difficultyId: z.number().int(), name: z.string().min(1) }),
);

const previousDay = (date: string) => {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
};

/** Normalize a scalar pooled method first, then array-based pooled types. */
function metricFilters(filters: ClimbingFilters | undefined): ClimbingFilters {
  const source = filters ?? {};
  const types = source.types;
  const next: ClimbingFilters = { ...source, attemptScope: ["climb"] };
  if (source.ropeMethod === "top_rope" || source.ropeMethod === "follow") {
    // The pooled cohort is the only outcome of a scalar selection; the requested
    // type array can narrow it to nothing but cannot widen it with other types.
    const intersectsPool =
      types === undefined || types.some((type) => type === "top_rope" || type === "follow");
    next.ropeMethod = undefined;
    next.types = intersectsPool ? ["top_rope", "follow"] : [];
    return next;
  }
  if (types?.some((type) => type === "top_rope" || type === "follow")) {
    next.types = [
      ...new Set(
        types.flatMap(
          (type): NonNullable<ClimbingFilters["types"]> =>
            type === "top_rope" || type === "follow" ? ["top_rope", "follow"] : [type],
        ),
      ),
    ];
  }
  return next;
}

/**
 * BoardSesh imports leave published grades empty. Only the exact ascent
 * consensus metadata matching this tick's native problem, board type, mirror
 * state and angle supplies evidence; personal, reported and model grades do not.
 */
type BoardSeshGradeComponent = {
  value: string;
  system: "font" | "v_scale";
  identity: string;
  publishedLabel: string;
  rankingValue?: number;
};

function boardSeshConsensusGrade(
  providerId: string | null,
  logRaw: Record<string, unknown> | null,
  climbExternalId: string | null,
  wallAngle: Record<string, unknown> | null,
  gradeSystems: ClimbingDemonstratedGradeInput["gradeSystems"],
): { targetId: string; grades: BoardSeshGradeComponent[] } | null {
  if (providerId !== "boardsesh" || !climbExternalId) return null;
  const metadata = z
    .object({
      ascent: boardSeshAscentSchema.optional(),
      grades: boardSeshGradesSchema.optional(),
    })
    .safeParse(logRaw?.metadata);
  if (!metadata.success) return null;
  const ascent = metadata.data.ascent;
  if (!ascent || ascent.consensusDifficulty == null) return null;
  if (
    climbExternalId !==
      `${ascent.boardType}:${ascent.climbUuid}:${ascent.isMirror ? "mirror" : "normal"}` ||
    wallAngle?.value !== ascent.angle ||
    wallAngle?.unit !== "degrees"
  )
    return null;
  // Only the exact ascent used for consensus carries usable identity. Ticks
  // synced before the canonical ID was published stay visible but cannot
  // establish a demonstrated grade.
  const canonicalClimbUuid = ascent.canonicalClimbUuid?.trim();
  if (!canonicalClimbUuid) return null;
  const catalogueLabel =
    (metadata.data.grades ?? []).find((grade) => grade.difficultyId === ascent.consensusDifficulty)
      ?.name ?? null;
  const ascentLabel = ascent.consensusDifficultyName;
  const normalized = (value: string) => value.replace(/\s+/g, "").toLowerCase();
  if (
    catalogueLabel?.trim() &&
    ascentLabel?.trim() &&
    normalized(catalogueLabel) !== normalized(ascentLabel)
  )
    return null;
  const label = catalogueLabel?.trim() || ascentLabel?.trim();
  if (!label) return null;
  const components: { value: string; system: "font" | "v_scale" }[] = [];
  let rankingValue: number | undefined;
  for (const part of label.split("/").map((value) => value.trim())) {
    // Rank on the exact Font component even when the display filter would hide it.
    if (rankingValue === undefined) {
      const precise = gradeSortValue(part, "font");
      if (precise !== null) rankingValue = precise;
    }
    for (const system of ["font", "v_scale"] as const) {
      if (
        (!gradeSystems?.length || gradeSystems.includes(system)) &&
        isValidClimbingGrade(part, system)
      ) {
        components.push({ value: part, system });
        break;
      }
    }
  }
  const selected = components.find((component) => component.system === "font") ?? components[0];
  if (!selected) return null;
  return {
    targetId: `boardsesh:${ascent.boardType}:${canonicalClimbUuid}`,
    grades: [
      {
        ...selected,
        ...(rankingValue === undefined ? {} : { rankingValue }),
        identity: `boardsesh:${ascent.boardType}:${ascent.consensusDifficulty}:${label.trim()}`,
        publishedLabel: label.trim(),
      },
    ],
  };
}

export class ClimbingDemonstratedGradeRepository extends BaseRepository {
  readonly #preference: ClimbingGradePreference;

  constructor(
    db: ConstructorParameters<typeof BaseRepository>[0],
    userId: string,
    timezone = "UTC",
    accessWindow: ConstructorParameters<typeof BaseRepository>[3] = {
      kind: "full",
      paid: true,
      reason: "paid_grant",
    },
    preference: ClimbingGradePreference = DEFAULT_CLIMBING_GRADE_PREFERENCE,
  ) {
    super(db, userId, timezone, accessWindow);
    this.#preference = preference;
  }

  #coverage(window: { startDate: string; endDate: string }): DemonstratedGradeCoverage {
    const access = this.accessWindow;
    if (access.kind === "full")
      return { fullWindow: true, startDate: window.startDate, endDate: window.endDate };
    const overlapStart = access.startDate > window.startDate ? access.startDate : window.startDate;
    const accessibleEnd = previousDay(access.endDateExclusive);
    const overlapEnd = accessibleEnd < window.endDate ? accessibleEnd : window.endDate;
    if (overlapStart > overlapEnd) return { fullWindow: false, startDate: null, endDate: null };
    return {
      fullWindow: overlapStart === window.startDate && overlapEnd === window.endDate,
      startDate: overlapStart,
      endDate: overlapEnd,
    };
  }

  async getDemonstratedGrade(
    input: ClimbingDemonstratedGradeInput,
  ): Promise<ClimbingDemonstratedGrade> {
    const { endDate, filters, sources, locations, gradeSystems } =
      demonstratedGradeInputSchema.parse(input);
    const window = demonstratedGradeWindow(endDate);
    const coverage = this.#coverage(window);
    const empty = () =>
      climbingDemonstratedGradeSchema.parse(
        buildDemonstratedGrade({
          endDate,
          preference: this.#preference,
          coverage,
          observations: [],
        }),
      );

    // A pitch-only filter cannot establish a whole-climb result, and disjoint
    // access has no evidence to read.
    if (filters?.attemptScope && !filters.attemptScope.includes("climb")) return empty();
    if (coverage.startDate === null) return empty();

    // Prefer the source date; otherwise require an exact, active native observation:
    // the activity owned by this user/provider with the log's own external ID.
    const ascentDate = sql`COALESCE(
      ce.climbed_on,
      ${postgresActivityCalendarDate(sql`exact_observation`, this.timezone)}
    )`;
    const predicates: SQL[] = [
      sql`ce.user_id = ${this.userId}`,
      sql`ce.provider_absent_at IS NULL`,
      sql`${ascentDate} >= ${window.startDate}::date`,
      sql`${ascentDate} <= ${window.endDate}::date`,
      sql`climb.external_id IS NOT NULL AND BTRIM(climb.external_id) <> ''`,
      // Standalone dated logs are eligible; an attached log must have an active
      // attachment owned by the same user.
      sql`(ce.activity_id IS NULL OR (
        attached.id IS NOT NULL
        AND attached.user_id = ce.user_id
        AND attached.deleted_at IS NULL
        AND attached.provider_absent_at IS NULL
      ))`,
    ];
    if (sources?.length)
      predicates.push(
        sql`ce.provider_id IN (${sql.join(
          sources.map((source) => sql`${source}`),
          sql`, `,
        )})`,
      );

    const source = sql`(SELECT ce.*, ${ascentDate} AS resolved_date
      FROM fitness.v_climbing_log_entry AS ce
      JOIN fitness.climb AS climb
        ON climb.id = ce.climb_id
        AND climb.user_id = ce.user_id
        AND climb.provider_id = ce.provider_id
      LEFT JOIN fitness.activity AS exact_observation
        ON exact_observation.id = ce.activity_id
        AND exact_observation.user_id = ce.user_id
        AND exact_observation.provider_id = ce.provider_id
        AND exact_observation.external_id = ce.external_id
        AND exact_observation.provider_type = 'climbing_log'
        AND exact_observation.provider_absent_at IS NULL
        AND exact_observation.deleted_at IS NULL
      LEFT JOIN fitness.activity AS attached
        ON attached.id = ce.activity_id
      WHERE ${sql.join(predicates, sql` AND `)}
        ${this.dateAccessPredicate(ascentDate)}
    )`;

    const rows = await this.query(
      evidenceRowSchema,
      sql`SELECT
          (attempt->>'id')::text AS attempt_id,
          ce.provider_id || ':' || climb.external_id AS target_id,
          ce.provider_id,
          COALESCE(NULLIF(BTRIM(ce.source_name), ''), ce.provider_id) AS provider,
          ce.climb_kind,
          ce.setting AS climb_setting,
          raw.rope_method,
          ce.resolved_date::text AS climbed_on,
          ce.published_grades,
          ce.wall_angle,
          ce.raw AS log_raw,
          COALESCE(NULLIF(BTRIM(ce.title), ''), climb.name) AS display_name,
          ce.id AS log_entry_id,
          ce.activity_id,
          climb.external_id AS climb_external_id,
          raw.source_completed,
          raw.source_result,
          raw.fell_or_hung,
          raw.used_aid,
          raw.dabbed
        FROM (${rockClimbingLogProjection(this.#preference, metricFilters(filters), source)}) AS ce
        JOIN fitness.climb AS climb
          ON climb.id = ce.climb_id
          AND climb.user_id = ce.user_id
          AND climb.provider_id = ce.provider_id
        CROSS JOIN LATERAL jsonb_array_elements(ce.attempts) AS attempt
        JOIN fitness.climbing_attempt AS raw ON raw.id = (attempt->>'id')::uuid
        WHERE attempt->>'outcome' = 'completed'
          AND ce.resolved_date IS NOT NULL
          ${
            locations?.length
              ? sql`AND ce.location_name IN (${sql.join(
                  locations.map((location) => sql`${location}`),
                  sql`, `,
                )})`
              : sql``
          }
          AND (
            raw.source_completed IS TRUE
            -- A log-level OpenBeta attemptType is only attributable to its own try
            -- when the canonical log recorded exactly one whole-climb attempt.
            OR fitness.climbing_attempt_outcome(
              CASE WHEN ce.provider_id = 'openbeta' AND ce.recorded_climb_attempt_count = 1
                THEN COALESCE(raw.source_result, ce.raw->>'attemptType')
                ELSE raw.source_result END
            ) = 'completed'
          )
          AND raw.fell_or_hung = false
          AND raw.used_aid = false
          AND (ce.climb_kind <> 'boulder' OR raw.dabbed = false)`,
    );

    const gradeSystem = z.enum(FREE_ROCK_GRADE_SYSTEMS);
    const observations: DemonstratedGradeObservation[] = rows.map((row) => {
      // The Mountain Project display parser can strip grade modifiers and ranges.
      // Compare the original published token before treating it as an exact grade.
      const rating = row.log_raw?.Rating;
      const recordedGrade =
        row.provider_id === "mountain-project" && typeof rating === "string"
          ? rating.trim().toLowerCase().split(/\s+/)[0]
          : undefined;
      const publishedGrades = row.published_grades.flatMap((component) => {
        const parsed = gradeSystem.safeParse(component.system);
        return parsed.success &&
          (!recordedGrade || recordedGrade === component.value.trim().toLowerCase()) &&
          (!gradeSystems?.length || gradeSystems.includes(parsed.data))
          ? [{ value: component.value, system: parsed.data }]
          : [];
      });
      const boardSesh = boardSeshConsensusGrade(
        row.provider_id,
        row.log_raw,
        row.climb_external_id,
        row.wall_angle,
        gradeSystems,
      );
      const gradeComponents =
        row.provider_id === "boardsesh" ? (boardSesh?.grades ?? []) : publishedGrades;
      return {
        attemptId: row.attempt_id,
        targetId: boardSesh?.targetId ?? row.target_id,
        provider: row.provider,
        providerId: row.provider_id,
        climbKind: row.climb_kind,
        climbSetting: row.climb_setting,
        ropeMethod: row.rope_method,
        attemptScope: "climb",
        cleanFreeSend: true,
        compatibilityBlank:
          (row.provider_id === "mountain-project" &&
            row.climb_kind === "route" &&
            row.rope_method === "top_rope" &&
            row.source_completed === null &&
            row.source_result === null) ||
          (row.provider_id === "openbeta" &&
            row.source_completed === null &&
            row.source_result === null &&
            row.log_raw?.attemptType == null),
        ascentStyle: row.source_result,
        climbedOn: row.climbed_on,
        gradeComponents,
        displayName: row.display_name,
        logEntryId: row.log_entry_id,
        activityId: row.activity_id,
        climbExternalId: row.climb_external_id,
        sourceUrl: climbingSourceLinks(row.provider_id ?? "", row.log_raw)[0]?.url ?? null,
      };
    });

    return climbingDemonstratedGradeSchema.parse(
      buildDemonstratedGrade({ endDate, preference: this.#preference, coverage, observations }),
    );
  }
}
