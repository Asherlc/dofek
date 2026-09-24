import { describe, expect, it } from "vitest";
import { parseDayNutritionResult } from "./day-nutrition-result.ts";

const preview = {
  date: "2026-09-07",
  total_calories: 1450,
  protein_g: 98,
  carbs_g: 120,
  fat_g: 55,
  calorie_goal: {
    target: 2200,
    remaining: 750,
    over: 0,
    progress_percentage: 65.9,
    type: "configured" as const,
  },
  macros: {
    protein: { grams: 98, energy_share_percentage: 28 },
    carbs: { grams: 120, energy_share_percentage: 34 },
    fat: { grams: 55, energy_share_percentage: 38 },
  },
};

describe("parseDayNutritionResult", () => {
  it("reads day_summary from a food mutation structured content payload", () => {
    expect(parseDayNutritionResult({ result: { day_summary: preview } })).toEqual({
      status: "ok",
      preview,
    });
  });

  it("preserves an explicit null day summary", () => {
    expect(parseDayNutritionResult({ result: { day_summary: null } })).toEqual({
      status: "unavailable",
    });
  });

  it("rejects non-object structured content", () => {
    expect(parseDayNutritionResult(null)).toEqual({ status: "invalid" });
    expect(parseDayNutritionResult("x")).toEqual({ status: "invalid" });
    expect(parseDayNutritionResult(1)).toEqual({ status: "invalid" });
  });

  it("rejects payloads without a result object", () => {
    expect(parseDayNutritionResult({})).toEqual({ status: "invalid" });
    expect(parseDayNutritionResult({ result: null })).toEqual({ status: "invalid" });
    expect(parseDayNutritionResult({ result: "x" })).toEqual({ status: "invalid" });
  });

  it("rejects result objects without day_summary", () => {
    expect(parseDayNutritionResult({ result: {} })).toEqual({ status: "invalid" });
  });

  it("rejects day_summary values that fail schema validation", () => {
    expect(parseDayNutritionResult({ result: { day_summary: { date: "bad" } } })).toEqual({
      status: "invalid",
    });
  });
});
