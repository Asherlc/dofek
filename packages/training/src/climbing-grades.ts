/// <reference path="./openbeta-sandbag.d.ts" />

import { convertGrade, GradeScales, getScale } from "@openbeta/sandbag";
import { z } from "zod";

export const FREE_ROCK_GRADE_SYSTEMS = [
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

export const GRADE_SYSTEMS = [
  ...FREE_ROCK_GRADE_SYSTEMS,
  "british_adjectival",
  "british_technical",
  "aid",
  "water_ice",
  "alpine_ice",
  "mixed",
  "ifas",
  "nccs",
] as const;
export const gradeSystemSchema = z.enum(GRADE_SYSTEMS);
export type GradeSystem = z.infer<typeof gradeSystemSchema>;
export type FreeRockGradeSystem = (typeof FREE_ROCK_GRADE_SYSTEMS)[number];
export type BoulderGradeSystem = "v_scale" | "font";
export type RouteGradeSystem = Exclude<FreeRockGradeSystem, BoulderGradeSystem>;
export type RockClimbKind = "boulder" | "route";

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
  displaySystem: FreeRockGradeSystem;
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
} as const satisfies Record<FreeRockGradeSystem, (typeof GradeScales)[keyof typeof GradeScales]>;

const SYSTEM_LABELS: Record<GradeSystem, string> = {
  v_scale: "V Scale",
  font: "Fontainebleau",
  yds: "Yosemite Decimal System",
  french: "French",
  uiaa: "International Climbing and Mountaineering Federation (UIAA)",
  ewbank: "Ewbank",
  saxon: "Saxon",
  norwegian: "Norwegian",
  brazilian_crux: "Brazilian Crux",
  british_adjectival: "British adjectival",
  british_technical: "British technical",
  aid: "Aid",
  water_ice: "Water ice",
  alpine_ice: "Alpine ice",
  mixed: "Mixed",
  ifas: "International French Adjectival System",
  nccs: "National Climbing Classification System",
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

export const climbingGradePreferenceSchema = z.object({
  boulder: z.enum(BOULDER_GRADE_SYSTEMS),
  route: z.enum(ROUTE_GRADE_SYSTEMS),
});

function sandbagScale(system: FreeRockGradeSystem) {
  const scale = getScale(systemToSandbagScale[system]);
  if (!scale) throw new Error(`Sandbag does not support climbing grade system: ${system}`);
  return scale;
}

function canonicalGrade(grade: string, system: FreeRockGradeSystem): string | null {
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

export function gradeSystemsForClimbKind(climbKind: "boulder"): readonly BoulderGradeSystem[];
export function gradeSystemsForClimbKind(climbKind: "route"): readonly RouteGradeSystem[];
export function gradeSystemsForClimbKind(climbKind: RockClimbKind): readonly FreeRockGradeSystem[];
export function gradeSystemsForClimbKind(climbKind: RockClimbKind): readonly FreeRockGradeSystem[] {
  return climbKind === "boulder" ? BOULDER_GRADE_SYSTEMS : ROUTE_GRADE_SYSTEMS;
}

export function resolveClimbingGradePreference(value: unknown): ClimbingGradePreference {
  const parsed = climbingGradePreferenceSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_CLIMBING_GRADE_PREFERENCE;
}

export function gradeOptionsForSystem(system: FreeRockGradeSystem): readonly string[] {
  return sandbagScale(system).grades;
}

export function gradeSystemLabel(system: GradeSystem): string {
  return SYSTEM_LABELS[system];
}

export function isGradeSystemForClimbKind(
  system: GradeSystem,
  climbKind: RockClimbKind,
): system is FreeRockGradeSystem {
  return climbKind === "boulder"
    ? system === "v_scale" || system === "font"
    : ROUTE_GRADE_SYSTEMS.some((candidate) => candidate === system);
}

// Source syntax includes modifiers and ranges absent from Sandbag's finite tables.
// https://www.thecrag.com/en/article/gradesonthecrag
const recordedGradePatterns = {
  british_adjectival: /^(?:E|M|D|VD|HVD|MS|S|HS|VS|HVS|E[1-9]\d*)$/i,
  british_technical: /^[1-9]\d*[abc]\+?$/i,
  aid: /^[AC](?:0|[1-9]\d*)[+-]?(?:[/-][AC]?(?:0|[1-9]\d*)[+-]?)?$/i,
  water_ice: /^WI[1-9]\d*[+-]?(?:[/-](?:WI)?[1-9]\d*[+-]?)?$/i,
  alpine_ice: /^AI[1-9]\d*[+-]?(?:[/-](?:AI)?[1-9]\d*[+-]?)?$/i,
  mixed: /^M[1-9]\d*[+-]?(?:[/-]M?[1-9]\d*[+-]?)?$/i,
  ifas: /^(?:F|PD|AD|D|TD|ED[1-3]?|EX)[+-]?$/i,
  nccs: /^(?=.+$)M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/i,
};

export function isValidClimbingGrade(grade: string, system: GradeSystem): boolean {
  if (system in recordedGradePatterns) {
    for (const [candidate, pattern] of Object.entries(recordedGradePatterns)) {
      if (system === candidate) return pattern.test(grade.trim());
    }
  }
  if (isGradeSystemForClimbKind(system, "boulder") || isGradeSystemForClimbKind(system, "route")) {
    return canonicalGrade(grade, system) !== null;
  }
  return false;
}

export function gradeSortValue(grade: string, system: FreeRockGradeSystem): number | null {
  const canonical = canonicalGrade(grade, system);
  if (!canonical) return null;
  const score = sandbagScale(system).getScore(canonical);
  if (typeof score === "number") return score;
  if (Array.isArray(score) && score.length >= 2) return (score[0] + score[1]) / 2;
  return null;
}

export function convertClimbingGrade(input: {
  grade: string;
  sourceSystem: FreeRockGradeSystem;
  displaySystem: FreeRockGradeSystem;
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
