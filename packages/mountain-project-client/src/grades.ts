import { type ParsedClimbingGrade, parseClimbingGrade } from "@dofek/training/climbing-grades";

const gradePrefixPattern = /^(V(?:B|\d+)|5\.\d{1,2}(?:[a-d+-])?)(?:\/[^\s]+)?(?:\s|$)/i;

/**
 * Mountain Project appends protection and secondary-system ratings to its
 * display grades. Only a leading YDS or V-scale grade is canonical here.
 */
export function normalizeMountainProjectGrade(rating: string): ParsedClimbingGrade | null {
  const match = gradePrefixPattern.exec(rating.trim());
  const token = match?.[1];
  return token ? parseClimbingGrade(token) : null;
}
