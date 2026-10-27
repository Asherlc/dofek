import type { MacroNutritionSummary } from "@dofek/nutrition/selected-date-summary";

type MacroKey = "protein" | "carbs" | "fat";

interface MacroEnergy {
  key: MacroKey;
  calories: number;
  tieOrder: number;
}

export function summarizeMacros(
  proteinGrams: number,
  carbsGrams: number,
  fatGrams: number,
): Record<MacroKey, MacroNutritionSummary> {
  const macroEnergy: MacroEnergy[] = [
    { key: "protein", calories: proteinGrams * 4, tieOrder: 0 },
    { key: "carbs", calories: carbsGrams * 4, tieOrder: 1 },
    { key: "fat", calories: fatGrams * 9, tieOrder: 2 },
  ];
  const totalMacroCalories = macroEnergy.reduce((total, macro) => total + macro.calories, 0);
  const energySharePercentages: Record<MacroKey, number> = {
    protein: 0,
    carbs: 0,
    fat: 0,
  };

  if (totalMacroCalories > 0) {
    const allocations = macroEnergy.map((macro) => {
      const exactPercentage = (macro.calories / totalMacroCalories) * 100;
      const wholePercentage = Math.floor(exactPercentage);
      energySharePercentages[macro.key] = wholePercentage;
      return {
        key: macro.key,
        remainder: exactPercentage - wholePercentage,
        tieOrder: macro.tieOrder,
      };
    });
    const allocatedPercentage = Object.values(energySharePercentages).reduce(
      (total, percentage) => total + percentage,
      0,
    );
    const remainingPercentage = 100 - allocatedPercentage;
    const allocationOrder = [...allocations].sort(
      (left, right) => right.remainder - left.remainder || left.tieOrder - right.tieOrder,
    );

    for (let index = 0; index < remainingPercentage; index += 1) {
      const allocation = allocationOrder[index];
      if (allocation) {
        energySharePercentages[allocation.key] += 1;
      }
    }
  }

  return {
    protein: {
      grams: proteinGrams,
      calories: proteinGrams * 4,
      energySharePercentage: energySharePercentages.protein,
    },
    carbs: {
      grams: carbsGrams,
      calories: carbsGrams * 4,
      energySharePercentage: energySharePercentages.carbs,
    },
    fat: {
      grams: fatGrams,
      calories: fatGrams * 9,
      energySharePercentage: energySharePercentages.fat,
    },
  };
}
