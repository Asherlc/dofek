import { parseMountainProjectGrades } from "@dofek/mountain-project/grades";
import {
  type GradeSystem,
  gradeSystemSchema,
  isValidClimbingGrade,
  parseClimbingGrade,
} from "@dofek/training/climbing-grades";
import type { AttemptOutcome, GradeComponent, RopeMethod } from "@dofek/training/climbing-log";
import { gpsCoordinatesSchema } from "@dofek/training/gps-coordinates";
import { z } from "zod";
import type { SourceClimbDefinition } from "./climbing-log-sync.ts";
import {
  normalizeSourceAttemptFacts,
  type SourceAttemptFacts,
  type SourceAttemptQualifier,
} from "./source-attempt-facts.ts";

export type LegacyAttemptFacts = Omit<SourceAttemptFacts, "sourceResult"> & {
  outcome?: AttemptOutcome | null;
};

export const legacyClimbingRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  provider_id: z.string(),
  external_id: z.string().nullable(),
  activity_id: z.string().nullable(),
  activity_external_id: z.string().nullable(),
  unattached_date: z.string().nullable(),
  climb_type: z.enum(["boulder", "route"]),
  grade: z.string(),
  grade_system: z.string(),
  result_style: z.string().nullable(),
  legacy_climb_style: z.string().nullable(),
  route_name: z.string().nullable(),
  route_protection: z.array(z.enum(["sport", "trad"])).nullable(),
  location_path: z.array(
    z.object({
      name: z.string(),
      externalId: z.string().nullable(),
      kind: z.string().nullable().optional(),
    }),
  ),
  raw: z.unknown(),
  model_converted: z.boolean(),
  attempt_count: z.number().int().positive().nullable(),
});
export type LegacyClimbingRow = z.infer<typeof legacyClimbingRowSchema>;
export class LegacyClimbingFactConflict extends Error {
  readonly field: string;
  readonly externalId: string | null;

  constructor(field: string, message: string, externalId: string | null = null) {
    super(message);
    this.field = field;
    this.externalId = externalId;
    this.name = "LegacyClimbingFactConflict";
  }
}
const recordSchema = z.record(z.string(), z.unknown());
function object(value: unknown): Record<string, unknown> {
  const result = recordSchema.safeParse(value);
  return result.success ? result.data : {};
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function identity(value: unknown): string | null {
  return (
    text(value) ?? (typeof value === "number" && Number.isFinite(value) ? String(value) : null)
  );
}
function grade(value: string, system: GradeSystem | null): GradeComponent {
  return { value, system: system && isValidClimbingGrade(value, system) ? system : null };
}
function openBetaGrades(value: unknown): GradeComponent[] {
  const raw = object(value);
  const systems: readonly [string, GradeSystem][] = [
    ["vscale", "v_scale"],
    ["font", "font"],
    ["yds", "yds"],
    ["french", "french"],
    ["uiaa", "uiaa"],
    ["ewbank", "ewbank"],
    ["brazilianCrux", "brazilian_crux"],
    ["wi", "water_ice"],
  ];
  return systems.flatMap(([key, system]) => {
    const value = text(raw[key]);
    return value ? [grade(value, system)] : [];
  });
}
function sourceDate(value: unknown, unit: "milliseconds" | "text"): string | null {
  if (value == null || value === "") return null;
  if (unit === "text" && typeof value === "string") {
    if (z.iso.date().safeParse(value).success) return value;
    if (z.iso.datetime({ offset: true, local: true }).safeParse(value).success)
      return value.slice(0, 10);
  }
  const date =
    unit === "text" && typeof value === "string"
      ? new Date(value)
      : typeof value === "number"
        ? new Date(value)
        : null;
  if (
    !date ||
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() < 1 ||
    date.getUTCFullYear() > 9999
  )
    throw new LegacyClimbingFactConflict(
      "climbedOn",
      "The recorded source date cannot be represented. Resolve it before conversion.",
    );
  return date.toISOString().slice(0, 10);
}

/** Historical source contracts are confined to the operator conversion, never steady-state ingestion. */
export function legacyClimbingDefinition(row: LegacyClimbingRow, hasOtherTargetHistory: boolean) {
  const raw = object(row.raw);
  let recordedCount = row.attempt_count;
  if ((row.provider_id === "kaya" || row.provider_id === "kaya-export") && raw.attempts != null) {
    if (typeof raw.attempts !== "number" || !Number.isSafeInteger(raw.attempts) || raw.attempts < 1)
      throw new LegacyClimbingFactConflict(
        "attemptCount",
        "The retained source attempt count is invalid.",
      );
    if (recordedCount !== null && recordedCount !== raw.attempts)
      throw new LegacyClimbingFactConflict(
        "attemptCount",
        "Stored and retained source attempt counts disagree; verify the recorded count before conversion.",
      );
    recordedCount = raw.attempts;
  }
  const catalogue = object(raw.climb);
  const ascent = object(raw.ascent);
  const route = object(ascent.route);
  if (raw.clean === false || ascent.clean === false)
    throw new LegacyClimbingFactConflict(
      "attemptFacts",
      "Legacy clean=false has no unambiguous execution meaning. Resolve the source facts before conversion.",
    );
  const system = gradeSystemSchema.safeParse(row.grade_system);
  if (!system.success)
    throw new LegacyClimbingFactConflict(
      "publishedGrades",
      "Legacy grade system is unsupported; inventory the source grade before conversion.",
    );
  const scalar = grade(row.grade, system.data);
  let externalId = row.external_id;
  let targetId: string | null = null;
  let publishedGrades: GradeComponent[] = [scalar];
  let reportedGrades: GradeComponent[] = [];
  let climbedOn = row.unattached_date;
  let notes: string | null = null;
  let label = row.result_style?.toLowerCase() ?? null;
  let name = row.route_name;
  let setting: SourceClimbDefinition["setting"] = null;
  let coordinates: SourceClimbDefinition["coordinates"];
  let pitches: SourceClimbDefinition["pitches"];
  const areas: NonNullable<SourceClimbDefinition["areas"]>[number][] = row.location_path.map(
    (node) => ({ name: node.name, externalId: node.externalId }),
  );
  const facts: LegacyAttemptFacts = {};
  const methods: Record<string, RopeMethod> = {
    lead: "lead",
    "top-rope": "top_rope",
    follow: "follow",
    unroped: "unroped",
  };
  if (row.legacy_climb_style && methods[row.legacy_climb_style])
    facts.ropeMethod = methods[row.legacy_climb_style];
  if (row.legacy_climb_style === "solo") facts.solo = true;
  if (row.legacy_climb_style === "aid") facts.usedAid = true;
  if (row.provider_id === "mountain-project") {
    const url = text(raw.URL);
    if (url && URL.canParse(url)) {
      const parsed = new URL(url);
      if (["www.mountainproject.com", "mountainproject.com"].includes(parsed.hostname))
        targetId = /^\/route\/(\d+)(?:\/|$)/.exec(parsed.pathname)?.[1] ?? null;
    }
    if (text(raw.Rating)) publishedGrades = parseMountainProjectGrades(text(raw.Rating) ?? "");
    if (text(raw["Your Rating"]))
      reportedGrades = parseMountainProjectGrades(text(raw["Your Rating"]) ?? "");
    notes = text(raw.Notes);
    climbedOn ??= sourceDate(raw.Date, "text");
  } else if (row.provider_id === "openbeta") {
    const sourceMethods: Record<string, RopeMethod> = {
      Lead: "lead",
      TR: "top_rope",
      Follow: "follow",
    };
    const sourceStyle = text(raw.style);
    if (sourceStyle && sourceMethods[sourceStyle]) facts.ropeMethod = sourceMethods[sourceStyle];
    if (sourceStyle === "Solo") facts.solo = true;
    if (sourceStyle === "Aid") facts.usedAid = true;
    label = text(raw.attemptType)?.toLowerCase() ?? label;
    targetId = text(catalogue.uuid);
    name = text(catalogue.name) ?? name;
    notes = text(raw.notes);
    climbedOn ??= sourceDate(raw.dateClimbed, "milliseconds");
    const supplied = openBetaGrades(catalogue.grades);
    const opinion = text(raw.grade);
    reportedGrades = opinion
      ? [grade(opinion, parseClimbingGrade(opinion)?.gradeSystem ?? system.data)]
      : [];
    publishedGrades = supplied.length ? supplied : opinion === row.grade ? [] : [scalar];
    const metadata = object(catalogue.metadata);
    if (metadata.lat != null && metadata.lng != null)
      coordinates = gpsCoordinatesSchema.parse({ latitude: metadata.lat, longitude: metadata.lng });
    const parent = object(catalogue.parent);
    const parentMetadata = object(parent.metadata);
    if (areas.length && parentMetadata.lat != null && parentMetadata.lng != null) {
      const last = areas.at(-1);
      if (last)
        last.coordinates = gpsCoordinatesSchema.parse({
          latitude: parentMetadata.lat,
          longitude: parentMetadata.lng,
        });
    }
    if (catalogue.pitches != null) {
      const definitions = z
        .array(
          z.object({
            id: z.string(),
            parentId: z.string(),
            pitchNumber: z.number().int(),
            grades: z.unknown(),
          }),
        )
        .parse(catalogue.pitches);
      pitches = definitions.map((p) => {
        if (p.parentId !== targetId)
          throw new LegacyClimbingFactConflict(
            "pitches",
            "Source pitch parent differs from the verified Climb.",
            targetId,
          );
        return {
          externalId: p.id,
          ...(p.pitchNumber > 0 ? { number: p.pitchNumber } : {}),
          publishedGrades: openBetaGrades(p.grades),
        };
      });
    }
  } else if (row.provider_id === "thecrag") {
    targetId = identity(route.id);
    name = text(route.name) ?? name;
    notes = text(ascent.markdown);
    climbedOn ??= sourceDate(ascent.date, "text");
    const gear = text(ascent.climbedGearStyle)?.toLowerCase();
    if (gear === "sport" || gear === "trad") facts.protectionUsed = [gear];
    if (gear === "aid") facts.usedAid = true;
    label =
      text(object(ascent.tick).label)?.toLowerCase() ??
      text(object(ascent.tick).name)?.toLowerCase() ??
      label;
  } else if (row.provider_id === "kaya") {
    const isAscent = Object.keys(catalogue).length > 0;
    const sourceClimb = isAscent ? catalogue : raw;
    targetId = identity(sourceClimb.id);
    const ascentId = identity(raw.id);
    if (!isAscent) {
      const prefix = `${row.activity_external_id}_`;
      const climbId =
        row.activity_external_id && ascentId?.startsWith(prefix)
          ? ascentId.slice(prefix.length)
          : "";
      if (!/^[1-9]\d*$/.test(climbId))
        throw new LegacyClimbingFactConflict(
          "externalId",
          "KAYA attempted target identity cannot be verified from its session prefix.",
        );
      targetId = climbId;
    }
    if (isAscent && ascentId) externalId = `kaya:ascent:${ascentId}`;
    else if (ascentId && row.activity_external_id)
      externalId = `kaya:session:${row.activity_external_id}:attempted:${ascentId}`;
    else
      throw new LegacyClimbingFactConflict(
        "externalId",
        "KAYA occurrence identity lacks its verified ascent or session target.",
      );
    label = text(object(raw.ascent_type).name)?.toLowerCase() ?? label;
    notes = text(raw.comment);
    climbedOn ??= sourceDate(raw.date, "text");
    if (row.climb_type !== "boulder" && typeof sourceClimb.lead === "boolean")
      facts.ropeMethod = sourceClimb.lead ? "lead" : "top_rope";
    if (areas.length) {
      const locations = [
        sourceClimb.destination,
        sourceClimb.area,
        sourceClimb.subarea,
        sourceClimb.gym,
        raw.gym,
      ].map(object);
      for (const area of areas) {
        const location = locations.find((l) => identity(l.id) === area.externalId);
        if (location?.latitude != null && location.longitude != null)
          area.coordinates = gpsCoordinatesSchema.parse({
            latitude: Number(location.latitude),
            longitude: Number(location.longitude),
          });
      }
    }
    setting = [sourceClimb.destination, sourceClimb.area, sourceClimb.subarea].some(
      (value) => value != null,
    )
      ? "outdoor"
      : sourceClimb.gym != null ||
          raw.gym != null ||
          row.location_path.some((node) => node.kind === "gym")
        ? "indoor"
        : null;
  } else if (row.provider_id === "kaya-export") {
    publishedGrades = [];
    reportedGrades = [scalar];
    setting = text(raw.gym) ? "indoor" : null;
    climbedOn ??= sourceDate(raw.date, "text");
    label = text(raw.ascentType)?.toLowerCase() ?? label;
  }
  if (
    ![...publishedGrades, ...reportedGrades].some(
      (value) => value.value.toLowerCase() === scalar.value.toLowerCase(),
    )
  )
    throw new LegacyClimbingFactConflict(
      "publishedGrades",
      "Stored grade conflicts with retained source catalogue/reported grades; verify the source role before conversion.",
      targetId,
    );
  if (label === "frenchfree" || label === "french free" || label?.startsWith("aid "))
    facts.usedAid = true;
  if (label === "lead solo" || label === "top rope solo" || label === "aid solo") {
    facts.solo = true;
    if (label === "lead solo") facts.ropeMethod = "lead";
    if (label === "top rope solo") facts.ropeMethod = "top_rope";
    if (label === "aid solo") facts.usedAid = true;
  }
  if (label === "pinkpoint") facts.usedPreplacedProtection = true;
  if (label === "repeat") facts.hadCompletedBefore = true;
  if (label === "ground-up redpoint") facts.priorFailedAttemptsGroundUp = true;
  if (label === "dog" || label === "hang dog") {
    facts.outcome = "completed";
    facts.fellOrHung = true;
  }
  if (
    label === "tick" ||
    (facts.usedAid && ["clean", "send", "redpoint", "pinkpoint"].includes(label ?? ""))
  )
    facts.outcome = "completed";
  if (row.provider_id === "thecrag" && label === "attempt") facts.outcome = "failed";
  let qualifier: SourceAttemptQualifier | undefined;
  if (label === "onsight" || label === "on sight" || label === "aid onsight")
    qualifier = facts.usedAid ? "aid-onsight" : "free-onsight";
  if (label === "flash" || label === "aid flash")
    qualifier = facts.usedAid ? "aid-flash" : "free-flash";
  if (
    [
      "clean",
      "send",
      "redpoint",
      "pinkpoint",
      "greenpoint",
      "repeat",
      "ground-up redpoint",
    ].includes(label ?? "") &&
    !facts.usedAid
  )
    qualifier = "free-send";
  if (label === "fell/hung") qualifier = "fell-hung";
  if (label === "dab") qualifier = "dab";
  const { outcome, ...executionFacts } = facts;
  const normalized: LegacyAttemptFacts = {
    ...normalizeSourceAttemptFacts(executionFacts, qualifier, {
      climbKind: row.climb_type,
      targetIdentified: targetId !== null,
      hasOtherTargetHistory,
    }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(qualifier !== undefined && qualifier !== "fell-hung" ? { outcome: "completed" } : {}),
  };
  const definition: SourceClimbDefinition = {
    externalId: targetId,
    name,
    kind: row.climb_type,
    publishedGrades,
    routeProtection: row.route_protection,
    setting,
    ...(coordinates === undefined ? {} : { coordinates }),
    areas,
    ...(pitches === undefined ? {} : { pitches }),
  };
  return {
    externalId,
    climbedOn,
    notes,
    climb: definition,
    reportedGrades,
    facts: normalized,
    recordedCount,
    qualifier,
  };
}
