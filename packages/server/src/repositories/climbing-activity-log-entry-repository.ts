import {
  type ClimbingGradePreference,
  DEFAULT_CLIMBING_GRADE_PREFERENCE,
} from "@dofek/training/climbing-grades";
import {
  type ClimbingAttempt,
  climbingAttemptSchema,
  climbingLogEntrySchema,
} from "@dofek/training/climbing-log";
import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import { recordedClimbingTags } from "dofek/climbing-tags";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import {
  type ClimbingLogEntryDetail,
  type ClimbingPitchResult,
  climbingLogClimbDetailSchema,
  climbingLogEntryDetailSchema,
} from "../contracts/climbing-log-contracts.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import { timestampStringSchema } from "../lib/typed-sql.ts";
import { postgresActivityCalendarDate } from "./activity-local-date.ts";
import { displayGradeComponents, selectRockClimbingGrade } from "./climbing-grade-display.ts";
import { climbingSourceLinks } from "./climbing-source-links.ts";

const databaseRowSchema = z.object({
  log: climbingLogEntrySchema.extend({
    createdAt: timestampStringSchema,
    providerAbsentAt: timestampStringSchema.nullable(),
  }),
  climb: climbingLogClimbDetailSchema.nullable(),
  freeSend: z.boolean().nullable(),
  attempts: z.array(
    z
      .object({ ...climbingAttemptSchema.shape, createdAt: timestampStringSchema })
      .pipe(climbingAttemptSchema),
  ),
});
function climbingDetailRaw(
  log: Pick<ClimbingLogEntryDetail, "providerId" | "externalId" | "raw">,
): ClimbingLogEntryDetail["raw"] {
  const raw = log.raw;
  if (
    log.providerId !== "kaya" ||
    !log.externalId?.startsWith("kaya:ascent:") ||
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw)
  )
    return raw;
  return Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "photo"));
}

function mapLocation(
  climb: ClimbingLogEntryDetail["climb"],
): ClimbingLogEntryDetail["mapLocation"] {
  if (!climb) return null;
  if (climb.coordinates)
    return {
      coordinates: climb.coordinates,
      scope: "climb",
      objectId: climb.id,
      providerId: climb.providerId,
      name: climb.name,
    };
  const area = climb.areaPath
    .slice()
    .reverse()
    .find((area) => area.coordinates !== null);
  return area?.coordinates
    ? {
        coordinates: area.coordinates,
        scope: "area",
        objectId: area.id,
        providerId: area.providerId,
        name: area.name,
      }
    : null;
}
function recordedOutcome(
  attempts: readonly ClimbingAttempt[],
): ClimbingLogEntryDetail["recordedClimbOutcome"] {
  if (attempts.some((attempt) => attempt.outcome === "completed")) return "completed";
  return attempts.length && attempts.every((attempt) => attempt.outcome === "failed")
    ? "failed"
    : null;
}
function resultLabels(
  log: z.infer<typeof databaseRowSchema>,
  attempt: ClimbingAttempt,
): ClimbingLogEntryDetail["attempts"][number]["rockResultLabels"] {
  const kind = log.climb?.kind;
  if (
    log.log.discipline !== "rock_climbing" ||
    (kind !== "route" && kind !== "boulder") ||
    attempt.outcome !== "completed" ||
    attempt.fellOrHung !== false ||
    attempt.usedAid !== false ||
    (kind === "boulder" && attempt.dabbed !== false)
  )
    return [];
  const labels: ClimbingLogEntryDetail["attempts"][number]["rockResultLabels"] = ["sent"];
  if (
    attempt.attemptIndex === 1 &&
    attempt.hadCompletedBefore !== true &&
    attempt.priorFailedAttemptsGroundUp !== true
  ) {
    if (attempt.receivedBeta === false) labels.push("Onsight");
    if (attempt.receivedBeta === true) labels.push("Flash");
  }
  if (kind === "route" && attempt.ropeMethod === "lead" && attempt.usedPreplacedProtection === true)
    labels.push("Pinkpoint");
  return labels;
}
function identity(log: ClimbingLogEntryDetail): string | null {
  if (!log.climb?.name || !log.climb.areaPath.length || !log.displayGrade) return null;
  const normalized = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  const targets = [
    ...new Set(
      log.attempts.map((attempt) =>
        JSON.stringify([
          attempt.scope,
          attempt.pitchId === null
            ? null
            : (log.climb?.pitches.find((pitch) => pitch.id === attempt.pitchId)?.number ?? null),
          attempt.ropeMethod,
          attempt.solo,
          attempt.protectionUsed?.slice().sort() ?? null,
        ]),
      ),
    ),
  ].sort();
  return JSON.stringify([
    log.climb.kind,
    normalized(log.displayGrade),
    normalized(log.climb.name),
    log.climb.areaPath.map((area) => normalized(area.name)),
    targets,
  ]);
}
function consolidate(logs: ClimbingLogEntryDetail[]): ClimbingLogEntryDetail[] {
  const output: ClimbingLogEntryDetail[] = [];
  const groups = new Map<
    string,
    { log: ClimbingLogEntryDetail; providers: Set<string>; sources: Set<string> }[]
  >();
  const completeness = (log: ClimbingLogEntryDetail) => [
    Number(log.recordedClimbOutcome !== null),
    log.attempts.reduce(
      (total, attempt) => total + Object.values(attempt).filter((value) => value !== null).length,
      0,
    ),
    log.attempts.length,
  ];
  for (const log of logs) {
    const key = identity(log);
    if (key === null) {
      output.push(log);
      continue;
    }
    const candidates = groups.get(key) ?? [];
    const match = candidates.find((candidate) => !candidate.providers.has(log.providerId));
    if (!match) {
      candidates.push({
        log,
        providers: new Set([log.providerId]),
        sources: new Set(log.sourceName ? [log.sourceName] : []),
      });
      groups.set(key, candidates);
      output.push(log);
      continue;
    }
    match.providers.add(log.providerId);
    if (log.sourceName) match.sources.add(log.sourceName);
    const left = completeness(log);
    const right = completeness(match.log);
    const index = left.findIndex((value, position) => value !== right[position]);
    const preferred = index >= 0 && (left[index] ?? 0) > (right[index] ?? 0) ? log : match.log;
    const sourceLinks = [
      ...new Map(
        [...match.log.sourceLinks, ...log.sourceLinks].map((link) => [JSON.stringify(link), link]),
      ).values(),
    ];
    const photoLogEntryId = match.log.photoLogEntryId ?? log.photoLogEntryId;
    const tags = [
      ...new Map(
        [...(match.log.tags ?? []), ...(log.tags ?? [])].map((tag) => [
          JSON.stringify([tag.providerId, tag.categoryKey, tag.sourceKey]),
          tag,
        ]),
      ).values(),
    ];
    Object.assign(match.log, preferred, {
      photoLogEntryId,
      sourceName: [...match.sources].join(", ") || null,
      sourceLinks,
      tags,
    });
  }
  return output;
}
export class ClimbingActivityLogEntry {
  readonly #detail: ClimbingLogEntryDetail;
  constructor(detail: ClimbingLogEntryDetail) {
    this.#detail = detail;
  }
  toDetail(): ClimbingLogEntryDetail {
    return this.#detail;
  }
}
export class ClimbingActivityLogEntryRepository extends BaseRepository {
  readonly #gradePreference: ClimbingGradePreference;
  constructor(
    db: ConstructorParameters<typeof BaseRepository>[0],
    userId: string,
    timezone: string,
    accessWindow?: ConstructorParameters<typeof BaseRepository>[3],
    gradePreference: ClimbingGradePreference = DEFAULT_CLIMBING_GRADE_PREFERENCE,
  ) {
    super(db, userId, timezone, accessWindow);
    this.#gradePreference = gradePreference;
  }
  async getLogEntries(ids: readonly string[]): Promise<ClimbingActivityLogEntry[]> {
    if (!ids.length) return [];
    return (
      await this.#load(
        sql`entry.id IN (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`,
      )
    ).map((log) => new ClimbingActivityLogEntry(log));
  }
  async getActivityMapLocations(
    activityIds: readonly string[],
  ): Promise<Map<string, ClimbingMapLocation[]>> {
    if (!activityIds.length) return new Map();
    const rows = await this.query(
      z.object({ activityId: z.string(), memberActivityIds: z.array(z.string()) }),
      sql`SELECT grouped.id AS "activityId", grouped.member_activity_ids AS "memberActivityIds"
      FROM fitness.v_activity AS grouped
      WHERE grouped.user_id=${this.userId}::uuid
        AND grouped.id IN (${sql.join(
          activityIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
        ${this.dateAccessPredicate(postgresActivityCalendarDate(sql`grouped`, this.timezone))}
      ORDER BY grouped.id`,
    );
    const members = [...new Set(rows.flatMap((row) => row.memberActivityIds))];
    if (!members.length) return new Map();
    const logs = await this.#load(
      sql`entry.activity_id IN (${sql.join(
        members.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
    );
    const grouped = new Map<string, ClimbingMapLocation[]>();
    for (const row of rows) {
      const memberIds = new Set(row.memberActivityIds);
      const selected = consolidate(
        logs.filter((log) => log.activityId !== null && memberIds.has(log.activityId)),
      );
      const points = new Map<string, ClimbingMapLocation>();
      for (const log of selected) {
        const location = log.mapLocation;
        if (location)
          points.set(
            JSON.stringify([location.providerId, location.scope, location.objectId]),
            location,
          );
      }
      if (points.size) grouped.set(row.activityId, [...points.values()]);
    }
    return grouped;
  }
  async getProviderLogEntry(
    providerId: string,
    id: string,
  ): Promise<ClimbingLogEntryDetail | null> {
    const [log] = await this.#load(
      sql`entry.provider_id=${providerId} AND entry.id=${id}::uuid`,
      "retained",
    );
    return log ?? null;
  }
  async getActivityLogEntries(activityId: string): Promise<ClimbingActivityLogEntry[]> {
    const logs = await this.#load(
      sql`entry.activity_id IN (SELECT UNNEST(grouped.member_activity_ids) FROM fitness.v_activity AS grouped WHERE grouped.user_id=${this.userId}::uuid AND grouped.id=${activityId}::uuid)`,
    );
    const sortValue = (log: ClimbingLogEntryDetail) =>
      log.discipline === "rock_climbing"
        ? (selectRockClimbingGrade(
            this.#gradePreference,
            log.climb?.kind ?? null,
            log.climb?.publishedGrades.length ? log.climb.publishedGrades : log.reportedGrades,
          )?.gradeSortValue ?? -Infinity)
        : -Infinity;
    return consolidate(logs)
      .sort((left, right) => sortValue(right) - sortValue(left) || left.id.localeCompare(right.id))
      .map((log) => new ClimbingActivityLogEntry(log));
  }
  async getUnattachedLogEntriesForDate(date: string): Promise<ClimbingLogEntryDetail[]> {
    return this.#load(sql`entry.activity_id IS NULL AND entry.climbed_on=${date}::date`);
  }
  async #load(
    predicate: SQL,
    visibility: "active" | "retained" = "active",
  ): Promise<ClimbingLogEntryDetail[]> {
    const eligibility =
      visibility === "retained"
        ? sql``
        : sql`AND entry.provider_absent_at IS NULL
      AND (entry.activity_id IS NULL OR (attached.deleted_at IS NULL AND attached.provider_absent_at IS NULL AND attached.id IS NOT NULL))`;
    const rows = await this.query(
      databaseRowSchema,
      sql`
      SELECT jsonb_build_object(
        'id',entry.id,'userId',entry.user_id,'providerId',entry.provider_id,'externalId',entry.external_id,
        'climbId',entry.climb_id,'activityId',entry.activity_id,'climbedOn',entry.climbed_on,
        'discipline',entry.discipline,'title',entry.title,'notes',entry.notes,'reportedGrades',entry.reported_grades,
        'board',entry.board,'wallAngle',entry.wall_angle,'holdTypes',entry.hold_types,'sourceName',entry.source_name,
        'raw',entry.raw,'providerAbsentAt',entry.provider_absent_at,'createdAt',entry.created_at
      ) AS log,
      CASE WHEN catalogue.id IS NOT NULL THEN jsonb_build_object(
        'id',catalogue.id,'userId',catalogue.user_id,'providerId',catalogue.provider_id,
        'externalId',catalogue.external_id,'name',catalogue.name,'kind',catalogue.kind,'areaId',catalogue.area_id,
        'publishedGrades',entry.published_grades,'setting',entry.setting,'routeProtection',catalogue.route_protection,
        'coordinates',CASE WHEN catalogue.coordinates IS NOT NULL THEN jsonb_build_object('latitude',catalogue.coordinates[1],'longitude',catalogue.coordinates[0]) END,
        'areaPath',entry.area_path,'pitches',COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id',pitch.id,'climbId',pitch.climb_id,'externalId',pitch.external_id,'number',pitch.number,'name',pitch.name,
          'publishedGrades',COALESCE((SELECT jsonb_agg(jsonb_build_object('value',component.value,'system',component.system) ORDER BY component.position) FROM fitness.pitch_grade AS component WHERE component.pitch_id=pitch.id),'[]'::jsonb)
        ) ORDER BY pitch.number NULLS LAST,pitch.id) FROM fitness.pitch AS pitch WHERE pitch.climb_id=catalogue.id),'[]'::jsonb)
      ) END AS climb,
      entry.free_send AS "freeSend",
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',attempt.id,'climbingLogEntryId',attempt.climbing_log_entry_id,'scope',attempt.scope,'pitchId',attempt.pitch_id,
        'parentAttemptId',attempt.parent_attempt_id,'attemptIndex',attempt.attempt_index,'outcome',attempt.outcome,
        'ropeMethod',attempt.rope_method,'solo',attempt.solo,'protectionUsed',attempt.protection_used,
        'usedPreplacedProtection',attempt.used_preplaced_protection,'usedAid',attempt.used_aid,
        'fellOrHung',attempt.fell_or_hung,'dabbed',attempt.dabbed,'receivedBeta',attempt.received_beta,
        'hadCompletedBefore',attempt.had_completed_before,'priorFailedAttemptsGroundUp',attempt.prior_failed_attempts_ground_up,
        'notes',attempt.notes,'createdAt',attempt.created_at
      ) ORDER BY attempt.attempt_index NULLS LAST,attempt.created_at,attempt.id) FROM fitness.v_climbing_attempt AS attempt WHERE attempt.climbing_log_entry_id=entry.id),'[]'::jsonb) AS attempts
      FROM fitness.v_climbing_log_entry AS entry
      LEFT JOIN fitness.climb AS catalogue ON catalogue.id=entry.climb_id
      LEFT JOIN fitness.activity AS attached ON attached.id=entry.activity_id AND attached.user_id=entry.user_id
      LEFT JOIN fitness.v_activity AS grouped ON grouped.user_id=entry.user_id AND attached.id=ANY(grouped.member_activity_ids)
      WHERE entry.user_id=${this.userId}::uuid AND ${predicate} ${eligibility}
        ${this.dateAccessPredicate(sql`CASE WHEN entry.activity_id IS NULL THEN entry.climbed_on ELSE ${postgresActivityCalendarDate(sql`grouped`, this.timezone)} END`)}
      ORDER BY entry.climbed_on DESC NULLS LAST,entry.id
    `,
    );
    return rows.map((row) => {
      const whole = row.attempts.filter((attempt) => attempt.scope === "climb");
      const pitchGroups = new Map<string, ClimbingAttempt[]>();
      for (const attempt of row.attempts.filter((attempt) => attempt.scope === "pitch")) {
        const key = attempt.pitchId ?? attempt.id;
        const group = pitchGroups.get(key) ?? [];
        group.push(attempt);
        pitchGroups.set(key, group);
      }
      const pitchResults: ClimbingPitchResult[] = [...pitchGroups.values()].map((attempts) => {
        const pitch = row.climb?.pitches.find((pitch) => pitch.id === attempts[0]?.pitchId) ?? null;
        return {
          pitch,
          attemptIds: attempts.map((attempt) => attempt.id),
          recordedAttemptCount: attempts.length,
          recordedOutcome: recordedOutcome(attempts),
          displayGrade: displayGradeComponents(
            this.#gradePreference,
            row.climb?.kind ?? null,
            pitch?.publishedGrades ?? [],
          ),
        };
      });
      return climbingLogEntryDetailSchema.parse({
        ...row.log,
        raw: climbingDetailRaw(row.log),
        tags: recordedClimbingTags(row.log.providerId, row.log.raw),
        climb: row.climb,
        mapLocation: mapLocation(row.climb),
        photoLogEntryId:
          row.log.providerId === "kaya" && row.log.externalId?.startsWith("kaya:ascent:")
            ? row.log.id
            : null,
        attempts: row.attempts.map((attempt) => ({
          ...attempt,
          rockResultLabels: resultLabels(row, attempt),
        })),
        // Mountain Project ticks retain result facts, but do not record attempt counts.
        recordedClimbAttemptCount: row.log.providerId === "mountain-project" ? null : whole.length,
        recordedPitchAttemptCount: row.attempts.length - whole.length,
        recordedClimbOutcome: recordedOutcome(whole),
        freeSend: row.freeSend,
        pitchResults,
        displayGrade: displayGradeComponents(
          this.#gradePreference,
          row.climb?.kind ?? null,
          row.climb?.publishedGrades.length ? row.climb.publishedGrades : row.log.reportedGrades,
        ),
        sourceLinks: climbingSourceLinks(row.log.providerId, row.log.raw),
      });
    });
  }
}
