/// <reference path="./openbeta-sandbag.d.ts" />

import { convertGrade, GradeScales, getScale } from "@openbeta/sandbag";

export const CLIMBING_GRADE_SYSTEMS = [
  "v_scale",
  "font",
  "yds",
  "french",
  "uiaa",
  "ewbank",
  "saxon",
  "norwegian",
  "brazilian_crux",
] as const;

export type ClimbingGradeSystem = (typeof CLIMBING_GRADE_SYSTEMS)[number];
export type BoulderGradeSystem = "v_scale" | "font";
export type RouteGradeSystem = Exclude<ClimbingGradeSystem, BoulderGradeSystem>;
export type ClimbingClimbType = "boulder" | "route";

export interface ClimbingGradePreference {
  boulder: BoulderGradeSystem;
  route: RouteGradeSystem;
}

export interface ParsedClimbingGrade {
  gradeSystem: "v_scale" | "yds";
  grade: string;
  sortValue: number;
}

export interface ConvertedClimbingGrade {
  displayGrade: string;
  displaySystem: ClimbingGradeSystem;
  sortValue: number;
}

export const DEFAULT_CLIMBING_GRADE_PREFERENCE: ClimbingGradePreference = {
  boulder: "v_scale",
  route: "yds",
};

const systemToSandbagScale = {
  v_scale: GradeScales.VSCALE,
  font: GradeScales.FONT,
  yds: GradeScales.YDS,
  french: GradeScales.FRENCH,
  uiaa: GradeScales.UIAA,
  ewbank: GradeScales.EWBANK,
  saxon: GradeScales.SAXON,
  norwegian: GradeScales.NORWEGIAN,
  brazilian_crux: GradeScales.BRAZILIAN_CRUX,
} as const satisfies Record<ClimbingGradeSystem, (typeof GradeScales)[keyof typeof GradeScales]>;

const SYSTEM_LABELS: Record<ClimbingGradeSystem, string> = {
  v_scale: "V Scale",
  font: "Fontainebleau",
  yds: "Yosemite Decimal System",
  french: "French",
  uiaa: "International Climbing and Mountaineering Federation (UIAA)",
  ewbank: "Ewbank",
  saxon: "Saxon",
  norwegian: "Norwegian",
  brazilian_crux: "Brazilian Crux",
};

export const BOULDER_GRADE_SYSTEMS = [
  "v_scale",
  "font",
] as const satisfies readonly BoulderGradeSystem[];
export const ROUTE_GRADE_SYSTEMS = [
  "yds",
  "french",
  "uiaa",
  "ewbank",
  "saxon",
  "norwegian",
  "brazilian_crux",
] as const satisfies readonly RouteGradeSystem[];

function isBoulderGradeSystem(value: string): value is BoulderGradeSystem {
  return value === "v_scale" || value === "font";
}

function isRouteGradeSystem(value: string): value is RouteGradeSystem {
  return (
    value === "yds" ||
    value === "french" ||
    value === "uiaa" ||
    value === "ewbank" ||
    value === "saxon" ||
    value === "norwegian" ||
    value === "brazilian_crux"
  );
}

function sandbagScale(system: ClimbingGradeSystem) {
  const scale = getScale(systemToSandbagScale[system]);
  if (!scale) throw new Error(`Sandbag does not support climbing grade system: ${system}`);
  return scale;
}

function canonicalGrade(grade: string, system: ClimbingGradeSystem): string | null {
  const trimmed = grade.trim();
  const scale = sandbagScale(system);
  if (!scale.isType(trimmed)) return null;
  const normalized = trimmed.toLocaleLowerCase();
  const listedGrade = scale.grades.find(
    (candidate) => candidate.toLocaleLowerCase() === normalized,
  );
  if (listedGrade) return listedGrade;
  if (system !== "yds") return null;
  const yosemiteBase = /^5\.(\d+)([+-])?$/i.exec(trimmed);
  if (!yosemiteBase) return null;
  const major = yosemiteBase[1];
  const hasKnownSubdivision = scale.grades.some((candidate) => {
    const subdivision = /^5\.(\d+)[abcd]$/i.exec(candidate);
    return subdivision?.[1] === major;
  });
  return hasKnownSubdivision ? `5.${major}${yosemiteBase[2] ?? ""}` : null;
}

export function gradeSystemsForClimbType(climbType: "boulder"): readonly BoulderGradeSystem[];
export function gradeSystemsForClimbType(climbType: "route"): readonly RouteGradeSystem[];
export function gradeSystemsForClimbType(
  climbType: ClimbingClimbType,
): readonly ClimbingGradeSystem[];
export function gradeSystemsForClimbType(
  climbType: ClimbingClimbType,
): readonly ClimbingGradeSystem[] {
  return climbType === "boulder" ? BOULDER_GRADE_SYSTEMS : ROUTE_GRADE_SYSTEMS;
}

export function resolveClimbingGradePreference(value: unknown): ClimbingGradePreference {
  if (
    typeof value === "object" &&
    value !== null &&
    "boulder" in value &&
    "route" in value &&
    typeof value.boulder === "string" &&
    typeof value.route === "string" &&
    isBoulderGradeSystem(value.boulder) &&
    isRouteGradeSystem(value.route)
  ) {
    return { boulder: value.boulder, route: value.route };
  }
  return DEFAULT_CLIMBING_GRADE_PREFERENCE;
}

export function gradeOptionsForSystem(system: ClimbingGradeSystem): readonly string[] {
  return sandbagScale(system).grades;
}

export function gradeSystemLabel(system: ClimbingGradeSystem): string {
  return SYSTEM_LABELS[system];
}

export function isGradeSystemForClimbType(
  system: ClimbingGradeSystem,
  climbType: ClimbingClimbType,
): boolean {
  return climbType === "boulder"
    ? system === "v_scale" || system === "font"
    : system !== "v_scale" && system !== "font";
}

export function isValidClimbingGrade(grade: string, system: ClimbingGradeSystem): boolean {
  return canonicalGrade(grade, system) !== null;
}

export function gradeSortValue(grade: string, system: ClimbingGradeSystem): number | null {
  const canonical = canonicalGrade(grade, system);
  if (!canonical) return null;
  const score = sandbagScale(system).getScore(canonical);
  if (typeof score === "number") return score;
  if (Array.isArray(score) && score.length >= 2) return (score[0] + score[1]) / 2;
  return null;
}

export function convertClimbingGrade(input: {
  grade: string;
  sourceSystem: ClimbingGradeSystem;
  displaySystem: ClimbingGradeSystem;
}): ConvertedClimbingGrade | null {
  const sourceGrade = canonicalGrade(input.grade, input.sourceSystem);
  if (!sourceGrade) return null;
  const sourceScale = sandbagScale(input.sourceSystem);
  const displayScale = sandbagScale(input.displaySystem);
  if (sourceScale.conversionGroup !== displayScale.conversionGroup) return null;
  const sortValue = gradeSortValue(sourceGrade, input.sourceSystem);
  if (sortValue === null) return null;
  return {
    displayGrade:
      input.sourceSystem === input.displaySystem
        ? sourceGrade
        : convertGrade(
            sourceGrade,
            systemToSandbagScale[input.sourceSystem],
            systemToSandbagScale[input.displaySystem],
          ),
    displaySystem: input.displaySystem,
    sortValue,
  };
}

export function parseClimbingGrade(input: string): ParsedClimbingGrade | null {
  for (const gradeSystem of ["v_scale", "yds"] as const) {
    const grade = canonicalGrade(input, gradeSystem);
    const sortValue = grade ? gradeSortValue(grade, gradeSystem) : null;
    if (grade && sortValue !== null) return { gradeSystem, grade, sortValue };
  }
  return null;
}
