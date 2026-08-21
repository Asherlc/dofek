import { describe, expect, it } from "vitest";
import {
  evaluateNutrientUpperLimit,
  getNutrientDailyValue,
  NUTRIENT_SAFETY_RULESET_REVIEWED_ON,
  upperLimitIntakeScopeLabel,
  upperLimitStatusLabel,
} from "./nutrient-safety.ts";

describe("getNutrientDailyValue", () => {
  it("uses the current FDA Daily Value and identifies its target type and population", () => {
    expect(getNutrientDailyValue("vitamin_d")).toEqual({
      type: "daily_value",
      amount: 20,
      unit: "mcg",
      population: "Adults and children age 4+",
      source: {
        agency: "FDA",
        title: "Daily Value on the Nutrition and Supplement Facts Labels",
        url: "https://www.fda.gov/food/nutrition-facts-label/daily-value-nutrition-and-supplement-facts-labels",
        reviewedOn: NUTRIENT_SAFETY_RULESET_REVIEWED_ON,
      },
    });
  });

  it("returns null instead of applying an unrelated target", () => {
    expect(getNutrientDailyValue("omega_3")).toBeNull();
  });
});

describe("evaluateNutrientUpperLimit", () => {
  it.each([
    ["vitamin_c", "mg", 2_000],
    ["vitamin_d", "mcg", 100],
    ["vitamin_b6", "mg", 100],
    ["zinc", "mg", 40],
  ])("uses the sourced U.S. adult total-intake UL for %s", (nutrientId, unit, amount) => {
    expect(
      evaluateNutrientUpperLimit({
        nutrientId,
        unit,
        totalDailyAmount: amount,
        supplementalDailyAmount: 0,
      }),
    ).toMatchObject({
      status: "at_or_above_limit",
      amount,
      intakeAmount: amount,
      intakeScope: "total",
      population: "U.S. adults age 19+",
      source: { agency: "NIH ODS" },
    });
  });

  it("compares total vitamin C intake with the NIH adult UL", () => {
    expect(
      evaluateNutrientUpperLimit({
        nutrientId: "vitamin_c",
        unit: "mg",
        totalDailyAmount: 2_100,
        supplementalDailyAmount: 1_900,
      }),
    ).toMatchObject({
      status: "at_or_above_limit",
      amount: 2_000,
      intakeAmount: 2_100,
      intakeScope: "total",
      population: "U.S. adults age 19+",
    });
  });

  it("compares only supplemental magnesium with its supplemental-only UL", () => {
    expect(
      evaluateNutrientUpperLimit({
        nutrientId: "magnesium",
        unit: "mg",
        totalDailyAmount: 700,
        supplementalDailyAmount: 300,
      }),
    ).toMatchObject({
      status: "within_limit",
      amount: 350,
      intakeAmount: 300,
      intakeScope: "supplemental_only",
    });
  });

  it("does not evaluate an amount expressed in a different unit", () => {
    expect(
      evaluateNutrientUpperLimit({
        nutrientId: "zinc",
        unit: "mcg",
        totalDailyAmount: 50_000,
        supplementalDailyAmount: 50_000,
      }),
    ).toMatchObject({
      status: "not_evaluable",
      limitation: "Tracked unit mcg does not match the sourced upper-limit unit mg.",
    });
  });

  it("does not compare total vitamin A when the preformed form is unknown", () => {
    expect(
      evaluateNutrientUpperLimit({
        nutrientId: "vitamin_a",
        unit: "mcg",
        totalDailyAmount: 3_500,
        supplementalDailyAmount: 3_500,
      }),
    ).toMatchObject({
      status: "not_evaluable",
      amount: 3_000,
      nutrientForm: "preformed vitamin A",
      limitation:
        "The NIH upper limit applies only to preformed vitamin A; tracked intake does not identify nutrient form.",
    });
  });

  it("does not claim that an omitted nutrient has no upper limit", () => {
    expect(
      evaluateNutrientUpperLimit({
        nutrientId: "calcium",
        unit: "mg",
        totalDailyAmount: 1_000,
        supplementalDailyAmount: 0,
      }),
    ).toEqual({
      status: "not_in_ruleset",
      limitation: "No upper-limit rule is included in this bounded ruleset.",
    });
  });
});

describe("upper-limit display labels", () => {
  it("uses plain-language labels for each upper-limit status", () => {
    expect(upperLimitStatusLabel("at_or_above_limit")).toBe(
      "At or above the Tolerable Upper Intake Level (UL)",
    );
    expect(upperLimitStatusLabel("within_limit")).toBe(
      "Below the Tolerable Upper Intake Level (UL)",
    );
    expect(upperLimitStatusLabel("not_evaluable")).toBe(
      "Tolerable Upper Intake Level (UL) not evaluable",
    );
    expect(upperLimitStatusLabel("not_in_ruleset")).toBe(
      "No Tolerable Upper Intake Level (UL) in this ruleset",
    );
  });

  it("describes whether a limit covers total or supplemental intake", () => {
    expect(upperLimitIntakeScopeLabel("total")).toBe("total daily intake");
    expect(upperLimitIntakeScopeLabel("supplemental_only")).toBe("supplemental intake only");
  });
});
