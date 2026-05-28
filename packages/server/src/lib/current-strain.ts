import { StrainScore } from "@dofek/scoring/scoring";

export interface CurrentStrainResult {
  currentStrain: number;
  currentStrainSource: "activity" | "none";
  currentPhysiologyLoad: number | null;
}

export function computeCurrentStrain({
  fallbackActivityLoad,
}: {
  fallbackActivityLoad: number;
}): CurrentStrainResult {
  const activityStrain =
    fallbackActivityLoad > 0 ? StrainScore.fromRawLoad(fallbackActivityLoad).value : 0;
  if (activityStrain > 0) {
    return {
      currentStrain: activityStrain,
      currentStrainSource: "activity",
      currentPhysiologyLoad: null,
    };
  }

  return {
    currentStrain: 0,
    currentStrainSource: "none",
    currentPhysiologyLoad: null,
  };
}
