import { z } from "zod";
import { climbingFiltersSchema } from "./climbing-filters.ts";
import {
  type ClimbingGradePreference,
  FREE_ROCK_GRADE_SYSTEMS,
  gradeSortValue,
  isGradeSystemForClimbKind,
} from "./climbing-grades.ts";

/** The trailing three calendar months ending on the requested local date. */
export function demonstratedGradeWindow(endDate: string): { startDate: string; endDate: string } {
  const [yearText, monthText, dayText] = endDate.split("-");
  const year = Number(yearText);
  const month = Number(monthText) - 3;
  const day = Number(dayText);
  const startYear = month <= 0 ? year - 1 : year;
  const startMonth = month <= 0 ? month + 12 : month;
  const lastDay = new Date(Date.UTC(startYear, startMonth, 0)).getUTCDate();
  const start = new Date(Date.UTC(startYear, startMonth - 1, Math.min(day, lastDay) + 1));
  return { startDate: start.toISOString().slice(0, 10), endDate };
}

export const demonstratedGradeInputSchema = z.object({
  endDate: z.iso.date(),
  filters: climbingFiltersSchema.optional(),
  sources: z.array(z.string().min(1)).max(50).optional(),
  locations: z.array(z.string().min(1)).max(50).optional(),
  gradeSystems: z.array(z.enum(FREE_ROCK_GRADE_SYSTEMS)).max(20).optional(),
});
export type ClimbingDemonstratedGradeInput = z.infer<typeof demonstratedGradeInputSchema>;

export const demonstratedGradeTypeSchema = z.enum(["bouldering", "lead", "top_rope", "unroped"]);
export const demonstratedGradeSettingSchema = z.enum(["indoor", "outdoor"]);

export const gradeComponentSchema = z.object({
  value: z.string().trim().min(1),
  system: z.enum(FREE_ROCK_GRADE_SYSTEMS),
  /** Exact native identity used for qualification; distinct from display formatting. */
  identity: z.string().min(1).optional(),
  /** Full source-published label, retained before display conversion. */
  publishedLabel: z.string().min(1).optional(),
  /** Precise grade value used to rank before display-system filtering narrows the label. */
  rankingValue: z.number().optional(),
});

export const demonstratedGradeSendSchema = z.object({
  provider: z.string(),
  providerId: z.string().nullable(),
  climbedOn: z.iso.date(),
  displayName: z.string().nullable(),
  /** The attempt's own recorded method, including `follow` in the pooled result. */
  ropeMethod: z.enum(["lead", "top_rope", "follow", "unroped"]).nullable(),
  ascentStyle: z.string().nullable(),
  logEntryId: z.string().nullable(),
  activityId: z.string().nullable(),
  climbExternalId: z.string().nullable(),
  sourceUrl: z.string().nullable(),
});

export const demonstratedGradeSchema = z.object({
  grade: z.string(),
  gradeSystem: z.enum(FREE_ROCK_GRADE_SYSTEMS),
  gradeSortValue: z.number(),
  count: z.number().int().min(3),
  publishedLabel: z.string().nullable(),
  /** Present only when the winning evidence is BoardSesh and needs provenance. */
  identityNote: z.string().min(1).optional(),
  sends: z.array(demonstratedGradeSendSchema).max(3),
});

export const demonstratedGradeCellSchema = z.object({
  type: demonstratedGradeTypeSchema,
  setting: demonstratedGradeSettingSchema,
  grades: z.array(demonstratedGradeSchema),
});

export const demonstratedGradeCoverageSchema = z.object({
  fullWindow: z.boolean(),
  /** Null only when the access window does not overlap the requested window. */
  startDate: z.iso.date().nullable(),
  endDate: z.iso.date().nullable(),
});

export const climbingDemonstratedGradeSchema = z.object({
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  coverage: demonstratedGradeCoverageSchema,
  method: z.string(),
  minimumDistinctClimbs: z.literal(3),
  cells: z.array(demonstratedGradeCellSchema),
});

export type ClimbingDemonstratedGrade = z.infer<typeof climbingDemonstratedGradeSchema>;
export type DemonstratedGradeCell = ClimbingDemonstratedGrade["cells"][number];
export type DemonstratedGrade = DemonstratedGradeCell["grades"][number];
export type DemonstratedGradeSend = DemonstratedGrade["sends"][number];
export type DemonstratedGradeCoverage = ClimbingDemonstratedGrade["coverage"];

/**
 * One recorded attempt. Clean execution, rope method and the ascent label all
 * belong to this attempt; the repository must not combine facts across attempts.
 */
export const demonstratedGradeObservationSchema = z.object({
  attemptId: z.string(),
  targetId: z.string().min(1),
  provider: z.string().min(1),
  providerId: z.string().nullable(),
  climbKind: z.enum(["boulder", "route"]),
  climbSetting: z.enum(["indoor", "outdoor"]).nullable(),
  ropeMethod: z.enum(["lead", "top_rope", "follow", "unroped"]).nullable(),
  attemptScope: z.enum(["climb", "pitch"]),
  cleanFreeSend: z.boolean().nullable(),
  compatibilityBlank: z.boolean(),
  ascentStyle: z.string().nullable(),
  climbedOn: z.iso.date().nullable(),
  gradeComponents: z.array(gradeComponentSchema),
  displayName: z.string().nullable(),
  logEntryId: z.string().nullable(),
  activityId: z.string().nullable(),
  climbExternalId: z.string().nullable(),
  sourceUrl: z.string().nullable(),
});
export type DemonstratedGradeObservation = z.infer<typeof demonstratedGradeObservationSchema>;

const TYPES = ["bouldering", "lead", "top_rope", "unroped"] as const;
const SETTINGS = ["indoor", "outdoor"] as const;

const BOARDSESH_IDENTITY_NOTE =
  "BoardSesh sends are counted by imported problem ID. A merged problem can appear under more than one ID and count more than once.";

type DatedObservation = DemonstratedGradeObservation & {
  climbedOn: string;
  climbSetting: (typeof SETTINGS)[number];
};

function ropeMethodType(method: DemonstratedGradeObservation["ropeMethod"]) {
  if (method === "lead" || method === "top_rope" || method === "follow" || method === "unroped")
    return method === "follow" ? ("top_rope" as const) : method;
  return null;
}

function cellType(observation: DemonstratedGradeObservation) {
  return observation.climbKind === "boulder"
    ? ("bouldering" as const)
    : ropeMethodType(observation.ropeMethod);
}

function cohortKey(component: z.infer<typeof gradeComponentSchema>) {
  return component.identity ?? `${component.system}:${component.value.trim().toLowerCase()}`;
}

export interface BuildDemonstratedGradeInput {
  endDate: string;
  preference: ClimbingGradePreference;
  coverage: DemonstratedGradeCoverage;
  observations: readonly DemonstratedGradeObservation[];
}

/**
 * Aggregate qualified attempts into the server-owned result. Distinct targets
 * are counted within one verified provider namespace: a two-plus-one split
 * across sources never qualifies. Only the highest qualifying grade per cell is
 * selected, keyed by exact native grade identity before display formatting.
 */
export function buildDemonstratedGrade(
  input: BuildDemonstratedGradeInput,
): ClimbingDemonstratedGrade {
  const window = demonstratedGradeWindow(input.endDate);
  const cohorts = new Map<
    string,
    {
      type: (typeof TYPES)[number];
      setting: (typeof SETTINGS)[number];
      component: z.infer<typeof gradeComponentSchema>;
      sortValue: number;
      rankingValue: number;
      namespaces: Map<string, Map<string, DatedObservation[]>>;
    }
  >();

  for (const observation of input.observations) {
    if (
      observation.attemptScope !== "climb" ||
      observation.cleanFreeSend !== true ||
      observation.compatibilityBlank ||
      observation.climbSetting === null ||
      observation.climbedOn === null ||
      observation.climbedOn < window.startDate ||
      observation.climbedOn > window.endDate
    )
      continue;
    const type = cellType(observation);
    if (type === null) continue;
    const dated: DatedObservation = {
      ...observation,
      climbedOn: observation.climbedOn,
      climbSetting: observation.climbSetting,
    };
    const namespace = observation.providerId ?? observation.provider;
    for (const component of observation.gradeComponents) {
      if (!isGradeSystemForClimbKind(component.system, observation.climbKind)) continue;
      const sortValue = gradeSortValue(component.value, component.system);
      if (sortValue === null) continue;
      const rankingValue = component.rankingValue ?? sortValue;
      const key = `${dated.climbKind}:${dated.climbSetting}:${type}:${cohortKey(component)}`;
      let cohort = cohorts.get(key);
      if (!cohort) {
        cohort = {
          type,
          setting: dated.climbSetting,
          component,
          sortValue,
          rankingValue,
          namespaces: new Map(),
        };
        cohorts.set(key, cohort);
      }
      let targets = cohort.namespaces.get(namespace);
      if (!targets) {
        targets = new Map();
        cohort.namespaces.set(namespace, targets);
      }
      const sends = targets.get(dated.targetId) ?? [];
      sends.push(dated);
      targets.set(dated.targetId, sends);
    }
  }

  // Qualify only from a single independently verified namespace; never pool an
  // unresolved cross-source two-plus-one into a third distinct climb.
  const qualified = [...cohorts.values()].flatMap((cohort) => {
    const best = [...cohort.namespaces.entries()].reduce(
      (winner, [namespace, targets]) =>
        targets.size > winner.targets.size ? { namespace, targets } : winner,
      { namespace: "", targets: new Map<string, DatedObservation[]>() },
    );
    return best.targets.size >= 3
      ? [{ cohort, targets: best.targets, namespace: best.namespace }]
      : [];
  });
  const highest = new Map<string, (typeof qualified)[number]>();
  for (const candidate of qualified) {
    const key = `${candidate.cohort.type}:${candidate.cohort.setting}`;
    const current = highest.get(key);
    if (
      !current ||
      candidate.cohort.rankingValue > current.cohort.rankingValue ||
      (candidate.cohort.rankingValue === current.cohort.rankingValue &&
        candidate.cohort.component.system ===
          input.preference[candidate.cohort.type === "bouldering" ? "boulder" : "route"])
    )
      highest.set(key, candidate);
  }

  const cells = TYPES.flatMap((type) =>
    SETTINGS.map((setting) => {
      const selected = highest.get(`${type}:${setting}`);
      if (!selected) return { type, setting, grades: [] satisfies DemonstratedGrade[] };
      const representatives = [...selected.targets.entries()]
        .map(([targetId, sends]) => ({
          targetId,
          send: sends.reduce((latest, send) =>
            send.climbedOn > latest.climbedOn ||
            (send.climbedOn === latest.climbedOn && send.attemptId < latest.attemptId)
              ? send
              : latest,
          ),
        }))
        .sort((left, right) =>
          left.send.climbedOn === right.send.climbedOn
            ? left.send.attemptId.localeCompare(right.send.attemptId)
            : right.send.climbedOn.localeCompare(left.send.climbedOn),
        )
        .slice(0, 3)
        .map(({ send }) => ({
          provider: send.provider,
          providerId: send.providerId,
          climbedOn: send.climbedOn,
          displayName: send.displayName,
          ropeMethod: send.ropeMethod,
          ascentStyle: send.ascentStyle,
          logEntryId: send.logEntryId,
          activityId: send.activityId,
          climbExternalId: send.climbExternalId,
          sourceUrl: send.sourceUrl,
        }));
      return {
        type,
        setting,
        grades: [
          {
            grade: selected.cohort.component.value,
            gradeSystem: selected.cohort.component.system,
            gradeSortValue: selected.cohort.sortValue,
            count: selected.targets.size,
            publishedLabel: selected.cohort.component.publishedLabel ?? null,
            ...(selected.namespace === "boardsesh"
              ? { identityNote: BOARDSESH_IDENTITY_NOTE }
              : {}),
            sends: representatives,
          },
        ],
      };
    }),
  );

  return {
    ...window,
    coverage: input.coverage,
    method: "Dofek adaptation of IRCRA 3:3:3",
    minimumDistinctClimbs: 3,
    cells,
  };
}
