import type { ConditionalTest } from "./conditional-tests.ts";
import type { JoinedDay } from "./data-join.ts";
import { cohensD, spearmanCorrelation } from "./stats.ts";

// ── Confounder detection ──────────────────────────────────────────────────

interface ContextVariable {
  label: string;
  unit: string;
  extract: (day: JoinedDay) => number | null;
}

function getContextVariables(): ContextVariable[] {
  return [
    { label: "calories", unit: "kcal", extract: (d) => d.calories },
    { label: "protein", unit: "g", extract: (d) => d.protein_g },
    { label: "carbs", unit: "g", extract: (d) => d.carbs_g },
    { label: "fat", unit: "g", extract: (d) => d.fat_g },
    {
      label: "protein % of cal",
      unit: "%",
      extract: (d) =>
        d.protein_g != null && d.calories ? ((d.protein_g * 4) / d.calories) * 100 : null,
    },
    {
      label: "carb % of cal",
      unit: "%",
      extract: (d) =>
        d.carbs_g != null && d.calories ? ((d.carbs_g * 4) / d.calories) * 100 : null,
    },
    {
      label: "fat % of cal",
      unit: "%",
      extract: (d) => (d.fat_g != null && d.calories ? ((d.fat_g * 9) / d.calories) * 100 : null),
    },
    { label: "exercise duration", unit: "min", extract: (d) => d.exercise_minutes },
    { label: "cardio duration", unit: "min", extract: (d) => d.cardio_minutes },
    { label: "strength training duration", unit: "min", extract: (d) => d.strength_minutes },
    { label: "steps", unit: "", extract: (d) => d.steps },
    { label: "sleep duration", unit: "min", extract: (d) => d.sleep_duration_min },
    { label: "deep sleep", unit: "min", extract: (d) => d.deep_min },
    { label: "sleep efficiency", unit: "%", extract: (d) => d.sleep_efficiency },
    { label: "resting HR", unit: "bpm", extract: (d) => d.resting_hr },
    { label: "HRV", unit: "ms", extract: (d) => d.hrv },
  ];
}

export function findCorrelationConfounders(
  xName: string,
  yName: string,
  xValues: number[],
  yValues: number[],
  joined: JoinedDay[],
  indices: number[],
): string[] {
  const confounders: string[] = [];
  const contextVars = getContextVariables();

  for (const cv of contextVars) {
    if (xName.toLowerCase().includes(cv.label.toLowerCase())) continue;
    if (yName.toLowerCase().includes(cv.label.toLowerCase())) continue;
    if (isRelatedToAction(xName, cv.label)) continue;
    if (isRelatedToAction(yName, cv.label)) continue;

    const zValues: number[] = [];
    const xFiltered: number[] = [];
    const yFiltered: number[] = [];
    for (let j = 0; j < indices.length; j++) {
      const idx = indices[j];
      if (idx === undefined) continue;
      const day = joined[idx];
      if (!day) continue;
      const contextValue = cv.extract(day);
      const xv = xValues[j];
      const yv = yValues[j];
      if (contextValue != null && xv !== undefined && yv !== undefined) {
        zValues.push(contextValue);
        xFiltered.push(xv);
        yFiltered.push(yv);
      }
    }
    if (zValues.length < 10) continue;

    const zx = spearmanCorrelation(zValues, xFiltered);
    const zy = spearmanCorrelation(zValues, yFiltered);

    // Confounder: correlates meaningfully with BOTH x and y
    if (Math.abs(zx.rho) >= 0.25 && Math.abs(zy.rho) >= 0.25) {
      confounders.push(
        `${cv.label} also correlates with both (ρ=${zx.rho.toFixed(2)} with ${xName}, ρ=${zy.rho.toFixed(2)} with ${yName})`,
      );
    }
  }

  return confounders.slice(0, 5);
}

// Variables that are subsets/supersets or mechanically related — not true confounders
const relatedVars: Record<string, Set<string>> = {
  exercise: new Set(["cardio", "strength", "active calories", "steps"]),
  cardio: new Set(["exercise", "active calories", "steps"]),
  strength: new Set(["exercise"]),
  steps: new Set(["exercise", "cardio", "active calories"]),
  "active calories": new Set(["exercise", "cardio", "steps"]),
  calories: new Set([
    "protein",
    "carbs",
    "fat",
    "fiber",
    "protein % of cal",
    "carb % of cal",
    "fat % of cal",
  ]),
  protein: new Set(["calories", "protein % of cal"]),
  carbs: new Set(["calories", "carb % of cal"]),
  fat: new Set(["calories", "fat % of cal"]),
  "protein % of cal": new Set(["carb % of cal", "fat % of cal"]),
  "carb % of cal": new Set(["protein % of cal", "fat % of cal"]),
  "fat % of cal": new Set(["protein % of cal", "carb % of cal"]),
  "sleep duration": new Set(["deep sleep"]),
  "deep sleep": new Set(["sleep duration"]),
  "resting HR": new Set(["HRV"]),
  HRV: new Set(["resting HR"]),
};

function isRelatedToAction(actionLabel: string, cvLabel: string): boolean {
  const actionLower = actionLabel.toLowerCase();
  const cvLower = cvLabel.toLowerCase();

  // Direct match: action mentions the variable
  for (const [key, related] of Object.entries(relatedVars)) {
    if (actionLower.includes(key.toLowerCase()) && related.has(cvLabel)) return true;
  }

  // Semantic overlap: action about "protein" shouldn't flag "protein % of cal" etc.
  const nutrients = ["protein", "carb", "fat", "calorie", "fiber"];
  for (const n of nutrients) {
    if (actionLower.includes(n) && cvLower.includes(n)) return true;
  }

  // Calorie actions → all macros are derivatives, not confounders
  if (actionLower.includes("calorie") || actionLower.includes("cal ")) {
    const macroLabels = [
      "protein",
      "carbs",
      "fat",
      "fiber",
      "protein % of cal",
      "carb % of cal",
      "fat % of cal",
      "calories",
    ];
    if (macroLabels.includes(cvLower)) return true;
  }

  // Macro % actions → absolute macros and other % are related
  if (actionLower.includes("% of cal") || actionLower.includes("% calories")) {
    if (cvLower.includes("% of cal") || cvLower === "calories") return true;
  }

  // Exercise family — all exercise types are related to each other
  const exerciseLabels = [
    "exercise duration",
    "cardio duration",
    "strength training duration",
    "active calories",
    "steps",
  ];
  if (
    actionLower.includes("exercise") ||
    actionLower.includes("cardio") ||
    actionLower.includes("strength") ||
    actionLower.includes("yoga") ||
    actionLower.includes("flexibility") ||
    actionLower.includes("cycling")
  ) {
    if (exerciseLabels.includes(cvLower)) return true;
  }

  return false;
}

export function findConfounders(test: ConditionalTest, joined: JoinedDay[]): string[] {
  // Split the same way the test does
  const trueIndices: number[] = [];
  const falseIndices: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const day = joined[i];
    if (!day) continue;
    const split = test.splitFn(day, joined, i);
    if (split === true) trueIndices.push(i);
    else if (split === false) falseIndices.push(i);
  }
  if (trueIndices.length < 5 || falseIndices.length < 5) return [];

  const confounders: string[] = [];
  const contextVars = getContextVariables();

  for (const cv of contextVars) {
    // Skip if this variable IS the metric or action being tested
    if (test.metric.toLowerCase().includes(cv.label.toLowerCase())) continue;
    if (test.action.toLowerCase().includes(cv.label.toLowerCase())) continue;
    // Skip if mechanically related (subset/superset)
    if (isRelatedToAction(test.action, cv.label)) continue;

    const trueVals = trueIndices
      .map((i) => {
        const joinedDay = joined[i];
        return joinedDay ? cv.extract(joinedDay) : undefined;
      })
      .filter((v): v is number => v != null);
    const falseVals = falseIndices
      .map((i) => {
        const joinedDay = joined[i];
        return joinedDay ? cv.extract(joinedDay) : undefined;
      })
      .filter((v): v is number => v != null);

    if (trueVals.length < 5 || falseVals.length < 5) continue;

    const effectSize = cohensD(trueVals, falseVals);
    if (Math.abs(effectSize) < 0.3) continue; // only report meaningful differences

    const trueAvg = trueVals.reduce((a, b) => a + b, 0) / trueVals.length;
    const falseAvg = falseVals.reduce((a, b) => a + b, 0) / falseVals.length;
    const direction = trueAvg > falseAvg ? "higher" : "lower";
    const pctDiff = falseAvg !== 0 ? Math.abs((trueAvg - falseAvg) / falseAvg) * 100 : 0;

    const fmtTrue = trueAvg < 10 ? trueAvg.toFixed(1) : Math.round(trueAvg).toString();
    const fmtFalse = falseAvg < 10 ? falseAvg.toFixed(1) : Math.round(falseAvg).toString();

    confounders.push(
      `${cv.label} also ${direction} (${fmtTrue} vs ${fmtFalse}${cv.unit ? ` ${cv.unit}` : ""}, ${pctDiff.toFixed(0)}% diff)`,
    );
  }

  // Deduplicate confounder families: if a parent is present, remove children
  // e.g., if "calories" is flagged, don't also list "protein", "carbs", "fat"
  const families: Array<{ parent: string; children: string[] }> = [
    {
      parent: "calories",
      children: [
        "protein",
        "carbs",
        "fat",
        "fiber",
        "protein % of cal",
        "carb % of cal",
        "fat % of cal",
      ],
    },
    {
      parent: "exercise duration",
      children: ["cardio duration", "strength training duration", "steps", "active calories"],
    },
    { parent: "sleep duration", children: ["deep sleep", "sleep efficiency"] },
  ];

  const presentLabels = new Set(confounders.map((c) => c.split(" also ")[0]));
  const filtered = confounders.filter((c) => {
    const label = c.split(" also ")[0] ?? "";
    for (const fam of families) {
      if (fam.children.includes(label) && presentLabels.has(fam.parent)) return false;
    }
    return true;
  });

  return filtered.slice(0, 5);
}
