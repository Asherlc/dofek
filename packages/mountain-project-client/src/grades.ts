import {
  isValidClimbingGrade,
  type ParsedClimbingGrade,
  parseClimbingGrade,
} from "@dofek/training/climbing-grades";
import type { GradeComponent } from "@dofek/training/climbing-log";

const gradePrefixPattern =
  /^(?:(V(?:B|\d+))(?:[+-]|-\d+)?|(5\.\d{1,2}(?:[a-d+-])?)(?:\/[^\s]+)?)(?:\s|$)/i;

/**
 * Mountain Project appends protection and secondary-system ratings to its
 * display grades. Only a leading YDS or V-scale grade is canonical here. V-scale
 * modifiers and ranges use their leading base grade because the canonical V-scale
 * parser has no modifier representation.
 */
export function normalizeMountainProjectGrade(rating: string): ParsedClimbingGrade | null {
  const match = gradePrefixPattern.exec(rating.trim());
  const token = match?.[1] ?? match?.[2];
  return token ? parseClimbingGrade(token) : null;
}

export function parseMountainProjectGrades(rating: string): GradeComponent[] {
  const grades: GradeComponent[] = [];
  const free = normalizeMountainProjectGrade(rating);
  if (free) grades.push({ value: free.grade, system: free.gradeSystem });
  for (const token of rating.trim().split(/\s+/)) {
    const system = /^WI/i.test(token)
      ? "water_ice"
      : /^AI/i.test(token)
        ? "alpine_ice"
        : /^M\d/i.test(token)
          ? "mixed"
          : /^[AC]\d/i.test(token)
            ? "aid"
            : null;
    if (system && isValidClimbingGrade(token, system)) grades.push({ value: token, system });
  }
  if (grades.length === 0 && rating.trim()) grades.push({ value: rating.trim(), system: null });
  return grades;
}
