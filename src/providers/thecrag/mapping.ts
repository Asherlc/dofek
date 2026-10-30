import {
  FREE_ROCK_GRADE_SYSTEMS,
  type GradeSystem,
  isGradeSystemForClimbKind,
  isValidClimbingGrade,
} from "@dofek/training/climbing-grades";
import type { ClimbKind, GradeComponent } from "@dofek/training/climbing-log";
import { z } from "zod";
import type { SourceClimbingAttempt, SourceClimbingLogEntry } from "../../db/climbing-log-sync.ts";

const identifier = z
  .union([z.string().regex(/^[1-9]\d*$/), z.number().int().positive().safe()])
  .transform(String);
const locationSchema = z.object({
  id: identifier,
  name: z.string().trim().min(1),
  depth: z.number().int().nonnegative(),
});
const ascentSchema = z.object({
  id: identifier,
  epoch: z.number().int().nonnegative().safe(),
  date: z.string().nullish(),
  climbedGearStyle: z.string().nullish(),
  markdown: z.string().nullish(),
  tick: z.object({ label: z.string().nullish(), name: z.string().nullish() }).nullish(),
  route: z.object({
    id: identifier,
    name: z.string().nullish(),
    grade: z.string().nullish(),
    style: z.string().nullish(),
    ancestors: z.record(z.string(), locationSchema.nullable()).nullish(),
  }),
});
function method(value: string): NonNullable<SourceClimbingAttempt["ropeMethod"]> | null {
  if (/^(top rope|top-rope)( solo)?$/.test(value)) return "top_rope";
  if (/^lead( solo)?$/.test(value)) return "lead";
  if (/^(free solo|solo|unroped)$/.test(value)) return "unroped";
  if (/^(follow|second)$/.test(value)) return "follow";
  return null;
}

export function mapTheCragAscent(raw: unknown, accountId: string): SourceClimbingLogEntry {
  const parsed = ascentSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      "theCrag returned an unsupported ascent response. Contact support before syncing this logbook.",
    );
  const ascent = parsed.data;
  const gear = ascent.climbedGearStyle?.trim().toLowerCase() ?? "";
  const routeStyle = ascent.route.style?.trim().toLowerCase() ?? "";
  const styles = [gear, routeStyle];
  const isBoulder = styles.includes("boulder");
  const isRoute = styles.some((style) =>
    [
      "sport",
      "trad",
      "aid",
      "top rope",
      "top-rope",
      "lead",
      "second",
      "follow",
      "solo",
      "free solo",
      "unroped",
      "lead solo",
      "top rope solo",
    ].includes(style),
  );
  if (isBoulder && isRoute)
    throw new Error(
      "theCrag returned conflicting climbing disciplines. Review the ascent in theCrag.",
    );
  const kind: ClimbKind | null = isBoulder ? "boulder" : isRoute ? "route" : null;
  const label = ascent.tick?.label?.trim() || ascent.tick?.name?.split(":")[0]?.trim();
  const suffix = ascent.tick?.name?.split(":").slice(1).join(":").trim().toLowerCase() ?? "";
  const result = label?.toLowerCase() ?? "";
  const methods = new Set([gear, result, suffix].map(method).filter((value) => value !== null));
  if (methods.size > 1 || (isBoulder && methods.size))
    throw new Error("theCrag returned conflicting climbing methods. Review the ascent in theCrag.");
  const ropeMethod = methods.values().next().value;
  const aid =
    gear === "aid" || result.startsWith("aid ") || ["french free", "frenchfree"].includes(result);
  const qualifier = sourceQualifier(result, aid);
  let day: string | null = null;
  if (ascent.date?.trim()) {
    const value = ascent.date;
    day = value.slice(0, 10);
    if (
      day.startsWith("0000-") ||
      !z.iso.date().safeParse(day).success ||
      !(
        z.iso.date().safeParse(value).success ||
        z.iso.datetime({ offset: true, local: true }).safeParse(value).success
      )
    )
      throw new Error(
        "theCrag returned an incomplete or invalid climb date. Record the exact climb day in theCrag and sync again.",
      );
  }
  const locationIds = new Set<string>();
  const areas = Object.values(ascent.route.ancestors ?? {})
    .filter((location) => location !== null)
    .sort((first, second) => first.depth - second.depth)
    .filter((location) => {
      if (locationIds.has(location.id)) return false;
      locationIds.add(location.id);
      return true;
    })
    .map((location) => ({ externalId: location.id, name: location.name }));
  const attempt: SourceClimbingAttempt = {
    scope: "climb",
    ...(label ? { sourceResult: label } : {}),
    ...(ropeMethod ? { ropeMethod } : {}),
    ...([gear, result, suffix].some((value) => value.includes("solo")) ? { solo: true } : {}),
    ...(gear === "sport" || gear === "trad" ? { protectionUsed: [gear] } : {}),
    ...(qualifier ? { qualifier } : {}),
    ...(aid ? { usedAid: true } : {}),
    ...(["dog", "hang dog"].includes(result) ? { fellOrHung: true } : {}),
    ...(result === "repeat" ? { hadCompletedBefore: true } : {}),
    ...(result === "pinkpoint" ? { usedPreplacedProtection: true } : {}),
    ...(result === "ground-up redpoint" ? { priorFailedAttemptsGroundUp: true } : {}),
  };
  const json = z.json().safeParse(raw);
  if (!json.success)
    throw new Error("theCrag returned invalid ascent provenance. Contact support before syncing.");
  return {
    externalId: `thecrag:${ascent.id}`,
    ...(day ? { climbedOn: day } : {}),
    sourceName: "theCrag",
    ...(kind ? { discipline: "rock_climbing" } : {}),
    attempts: [attempt],
    ...(ascent.markdown === undefined ? {} : { notes: ascent.markdown?.trim() || null }),
    raw: { accountId, ascent: json.data },
    climb: {
      externalId: ascent.route.id,
      ...(areas.length ? { areas } : {}),
      ...(ascent.route.name == null ? {} : { name: ascent.route.name.trim() || null }),
      ...(kind ? { kind } : {}),
      ...(routeStyle === "sport" || routeStyle === "trad" ? { routeProtection: [routeStyle] } : {}),
      ...(ascent.route.grade?.trim()
        ? { publishedGrades: sourceGrade(ascent.route.grade, kind, ascent.id) }
        : {}),
    },
  };
}
function sourceGrade(
  rawGrade: string | null | undefined,
  kind: ClimbKind | null,
  ascentId: string,
): GradeComponent[] {
  let grade = rawGrade?.trim() ?? "";
  if (grade === "") return [];
  const components =
    /^(?:V(?:B|\d)|5\.|(?:FR|FB|AU|UIAA|YDS|BLDV|AID|AIDC|WICE|AICE|MIXED|IFAS|NCCS|UK|UKT)(?:\s*:\s*|\s+))/i.test(
      grade,
    )
      ? grade.split(
          /\s+(?=(?:FR|FB|AU|UIAA|YDS|BLDV|AID|AIDC|WICE|AICE|MIXED|IFAS|NCCS|UK|UKT)(?:\s*:\s*|\s+))/i,
        )
      : [grade];
  if (components.length > 1)
    return components.flatMap((component) => sourceGrade(component, kind, ascentId));
  let gradeSystem: GradeSystem | null = null;
  if (/^V(?:B|\d+)(?:[+-])?$/i.test(grade)) gradeSystem = "v_scale";
  else if (/^5\./.test(grade)) gradeSystem = "yds";
  else {
    // theCrag documents these scale labels. gradeAtom.type is undocumented.
    const explicitScale =
      /^(FR|FB|AU|UIAA|YDS|BLDV|AID|AIDC|WICE|AICE|MIXED|IFAS|NCCS|UK|UKT)(?:\s*:\s*|\s+)(.+)$/i.exec(
        grade,
      );
    if (explicitScale) {
      switch (explicitScale[1]?.toUpperCase()) {
        case "FR":
          gradeSystem = "french";
          break;
        case "FB":
          gradeSystem = "font";
          break;
        case "AU":
          gradeSystem = "ewbank";
          break;
        case "UIAA":
          gradeSystem = "uiaa";
          break;
        case "YDS":
          gradeSystem = "yds";
          break;
        case "BLDV":
          gradeSystem = "v_scale";
          break;
        case "AID":
        case "AIDC":
          gradeSystem = "aid";
          break;
        case "WICE":
          gradeSystem = "water_ice";
          break;
        case "AICE":
          gradeSystem = "alpine_ice";
          break;
        case "MIXED":
          gradeSystem = "mixed";
          break;
        case "IFAS":
          gradeSystem = "ifas";
          break;
        case "NCCS":
          gradeSystem = "nccs";
          break;
        case "UK":
          gradeSystem = "british_adjectival";
          break;
        case "UKT":
          gradeSystem = "british_technical";
          break;
      }
      grade = explicitScale[2]?.trim() ?? grade;
    }
  }
  if (
    gradeSystem !== null &&
    (kind === "boulder" || kind === "route") &&
    FREE_ROCK_GRADE_SYSTEMS.some((system) => system === gradeSystem) &&
    !isGradeSystemForClimbKind(gradeSystem, kind)
  ) {
    throw new Error(
      `theCrag ascent ${ascentId} has an unsupported or ambiguous grade. Use a grade with an explicit supported scale in theCrag, or contact support before syncing this logbook.`,
    );
  }
  if (gradeSystem !== null && !isValidClimbingGrade(grade, gradeSystem)) {
    gradeSystem = null;
    grade = rawGrade?.trim() ?? "";
  }
  return [{ system: gradeSystem, value: grade }];
}

function sourceQualifier(value: string | null, aid: boolean): SourceClimbingAttempt["qualifier"] {
  switch (value?.trim().toLowerCase()) {
    case "aid onsight":
    case "onsight":
    case "on sight":
      return aid ? "aid-onsight" : "free-onsight";
    case "aid flash":
    case "flash":
      return aid ? "aid-flash" : "free-flash";
    case "clean":
    case "send":
    case "redpoint":
    case "pinkpoint":
    case "greenpoint":
    case "repeat":
    case "ground-up redpoint":
      return aid ? undefined : "free-send";
    case "fell/hung":
      return "fell-hung";
    case "dab":
      return "dab";
    default:
      return undefined;
  }
}
