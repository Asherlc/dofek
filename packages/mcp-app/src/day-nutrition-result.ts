import {
  type DayNutritionPreview,
  dayNutritionPreviewSchema,
} from "@dofek/mcp-contracts/day-nutrition";

export type ParsedDayNutritionResult =
  | { status: "ok"; preview: DayNutritionPreview }
  | { status: "unavailable" }
  | { status: "invalid" };

export function parseDayNutritionResult(structuredContent: unknown): ParsedDayNutritionResult {
  if (typeof structuredContent !== "object" || structuredContent === null) {
    return { status: "invalid" };
  }
  if (!("result" in structuredContent)) return { status: "invalid" };
  const result = structuredContent.result;
  if (typeof result !== "object" || result === null) return { status: "invalid" };
  if (!("day_summary" in result)) return { status: "invalid" };
  if (result.day_summary === null) return { status: "unavailable" };
  const parsed = dayNutritionPreviewSchema.safeParse(result.day_summary);
  return parsed.success ? { status: "ok", preview: parsed.data } : { status: "invalid" };
}
