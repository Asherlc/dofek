export const NUTRIENT_SAFETY_RULESET_REVIEWED_ON = "2026-07-27";
export const DAILY_VALUE_TARGET_LABEL = "U.S. Food and Drug Administration (FDA) Daily Value";

export interface NutrientSafetySource {
  readonly agency: "FDA" | "NIH ODS";
  readonly title: string;
  readonly url: string;
  readonly reviewedOn: typeof NUTRIENT_SAFETY_RULESET_REVIEWED_ON;
}

export interface DailyValueReference {
  readonly type: "daily_value";
  readonly amount: number;
  readonly unit: string;
  readonly population: "Adults and children age 4+";
  readonly source: NutrientSafetySource;
}

export type UpperLimitIntakeScope = "total" | "supplemental_only";

export function upperLimitIntakeScopeLabel(scope: UpperLimitIntakeScope): string {
  return scope === "total" ? "total daily intake" : "supplemental intake only";
}

interface ComparableUpperLimitRule {
  readonly amount: number;
  readonly unit: string;
  readonly intakeScope: UpperLimitIntakeScope;
  readonly population: "U.S. adults age 19+";
  readonly nutrientForm: "all tracked forms";
  readonly source: NutrientSafetySource;
}

interface FormLimitedUpperLimitRule {
  readonly amount: number;
  readonly unit: string;
  readonly intakeScope: "total";
  readonly population: "U.S. adults age 19+";
  readonly nutrientForm: "preformed vitamin A";
  readonly source: NutrientSafetySource;
  readonly limitation: string;
}

interface UpperLimitEvaluationBase {
  readonly amount: number;
  readonly unit: string;
  readonly intakeScope: UpperLimitIntakeScope;
  readonly population: "U.S. adults age 19+";
  readonly nutrientForm: "all tracked forms" | "preformed vitamin A";
  readonly source: NutrientSafetySource;
}

export type UpperLimitEvaluation =
  | (UpperLimitEvaluationBase & {
      readonly status: "within_limit" | "at_or_above_limit";
      readonly intakeAmount: number;
    })
  | (UpperLimitEvaluationBase & {
      readonly status: "not_evaluable";
      readonly limitation: string;
    })
  | {
      readonly status: "not_in_ruleset";
      readonly limitation: "No upper-limit rule is included in this bounded ruleset.";
    };

export interface NutrientUpperLimitInput {
  readonly nutrientId: string;
  readonly unit: string;
  readonly totalDailyAmount: number;
  readonly supplementalDailyAmount: number;
}

const FDA_DAILY_VALUE_SOURCE: NutrientSafetySource = {
  agency: "FDA",
  title: "Daily Value on the Nutrition and Supplement Facts Labels",
  url: "https://www.fda.gov/food/nutrition-facts-label/daily-value-nutrition-and-supplement-facts-labels",
  reviewedOn: NUTRIENT_SAFETY_RULESET_REVIEWED_ON,
};

const dailyValue = (amount: number, unit: string): DailyValueReference => ({
  type: "daily_value",
  amount,
  unit,
  population: "Adults and children age 4+",
  source: FDA_DAILY_VALUE_SOURCE,
});

/**
 * Current FDA Daily Values for nutrients represented by the canonical nutrient
 * catalog. These are labeling references for the stated population, not
 * individualized clinical recommendations.
 */
const FDA_DAILY_VALUES: Readonly<Record<string, DailyValueReference>> = {
  fiber: dailyValue(28, "g"),
  sodium: dailyValue(2_300, "mg"),
  potassium: dailyValue(4_700, "mg"),
  vitamin_c: dailyValue(90, "mg"),
  vitamin_d: dailyValue(20, "mcg"),
  vitamin_k: dailyValue(120, "mcg"),
  vitamin_b1: dailyValue(1.2, "mg"),
  vitamin_b2: dailyValue(1.3, "mg"),
  vitamin_b6: dailyValue(1.7, "mg"),
  vitamin_b12: dailyValue(2.4, "mcg"),
  vitamin_b5: dailyValue(5, "mg"),
  choline: dailyValue(550, "mg"),
  calcium: dailyValue(1_300, "mg"),
  chloride: dailyValue(2_300, "mg"),
  chromium: dailyValue(35, "mcg"),
  copper: dailyValue(0.9, "mg"),
  iodine: dailyValue(150, "mcg"),
  iron: dailyValue(18, "mg"),
  magnesium: dailyValue(420, "mg"),
  manganese: dailyValue(2.3, "mg"),
  molybdenum: dailyValue(45, "mcg"),
  phosphorus: dailyValue(1_250, "mg"),
  selenium: dailyValue(55, "mcg"),
  zinc: dailyValue(11, "mg"),
};

const upperLimitSource = (title: string, url: string): NutrientSafetySource => ({
  agency: "NIH ODS",
  title,
  url,
  reviewedOn: NUTRIENT_SAFETY_RULESET_REVIEWED_ON,
});

const UPPER_LIMIT_RULES: Readonly<
  Record<string, ComparableUpperLimitRule | FormLimitedUpperLimitRule>
> = {
  vitamin_c: {
    amount: 2_000,
    unit: "mg",
    intakeScope: "total",
    population: "U.S. adults age 19+",
    nutrientForm: "all tracked forms",
    source: upperLimitSource(
      "Vitamin C - Health Professional Fact Sheet",
      "https://ods.od.nih.gov/factsheets/VitaminC-HealthProfessional/",
    ),
  },
  vitamin_d: {
    amount: 100,
    unit: "mcg",
    intakeScope: "total",
    population: "U.S. adults age 19+",
    nutrientForm: "all tracked forms",
    source: upperLimitSource(
      "Vitamin D - Health Professional Fact Sheet",
      "https://ods.od.nih.gov/factsheets/VitaminD-HealthProfessional/",
    ),
  },
  vitamin_b6: {
    amount: 100,
    unit: "mg",
    intakeScope: "total",
    population: "U.S. adults age 19+",
    nutrientForm: "all tracked forms",
    source: upperLimitSource(
      "Vitamin B6 - Health Professional Fact Sheet",
      "https://ods.od.nih.gov/factsheets/VitaminB6-HealthProfessional/",
    ),
  },
  zinc: {
    amount: 40,
    unit: "mg",
    intakeScope: "total",
    population: "U.S. adults age 19+",
    nutrientForm: "all tracked forms",
    source: upperLimitSource(
      "Zinc - Health Professional Fact Sheet",
      "https://ods.od.nih.gov/factsheets/Zinc-HealthProfessional/",
    ),
  },
  magnesium: {
    amount: 350,
    unit: "mg",
    intakeScope: "supplemental_only",
    population: "U.S. adults age 19+",
    nutrientForm: "all tracked forms",
    source: upperLimitSource(
      "Magnesium - Health Professional Fact Sheet",
      "https://ods.od.nih.gov/factsheets/Magnesium-HealthProfessional/",
    ),
  },
  vitamin_a: {
    amount: 3_000,
    unit: "mcg",
    intakeScope: "total",
    population: "U.S. adults age 19+",
    nutrientForm: "preformed vitamin A",
    source: upperLimitSource(
      "Vitamin A and Carotenoids - Health Professional Fact Sheet",
      "https://ods.od.nih.gov/factsheets/VitaminA-HealthProfessional/",
    ),
    limitation:
      "The NIH upper limit applies only to preformed vitamin A; tracked intake does not identify nutrient form.",
  },
};

export function getNutrientDailyValue(nutrientId: string): DailyValueReference | null {
  return FDA_DAILY_VALUES[nutrientId] ?? null;
}

export function evaluateNutrientUpperLimit(input: NutrientUpperLimitInput): UpperLimitEvaluation {
  const rule = UPPER_LIMIT_RULES[input.nutrientId];
  if (!rule) {
    return {
      status: "not_in_ruleset",
      limitation: "No upper-limit rule is included in this bounded ruleset.",
    };
  }

  const base = {
    amount: rule.amount,
    unit: rule.unit,
    intakeScope: rule.intakeScope,
    population: rule.population,
    nutrientForm: rule.nutrientForm,
    source: rule.source,
  };

  if (input.unit !== rule.unit) {
    return {
      ...base,
      status: "not_evaluable",
      limitation: `Tracked unit ${input.unit} does not match the sourced upper-limit unit ${rule.unit}.`,
    };
  }

  if ("limitation" in rule) {
    return {
      ...base,
      status: "not_evaluable",
      limitation: rule.limitation,
    };
  }

  const intakeAmount =
    rule.intakeScope === "total" ? input.totalDailyAmount : input.supplementalDailyAmount;
  return {
    ...base,
    status: intakeAmount >= rule.amount ? "at_or_above_limit" : "within_limit",
    intakeAmount,
  };
}

export function upperLimitStatusLabel(status: UpperLimitEvaluation["status"]): string {
  switch (status) {
    case "at_or_above_limit":
      return "At or above the Tolerable Upper Intake Level (UL)";
    case "within_limit":
      return "Below the Tolerable Upper Intake Level (UL)";
    case "not_evaluable":
      return "Tolerable Upper Intake Level (UL) not evaluable";
    case "not_in_ruleset":
      return "No Tolerable Upper Intake Level (UL) in this ruleset";
  }
}
