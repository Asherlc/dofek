export interface StrainTargetResult {
  /** Recommended strain target for the day (0-21 scale) */
  targetStrain: number;
  /** Zone label */
  zone: "Push" | "Maintain" | "Recovery";
  /** Human-readable explanation */
  explanation: string;
}

/**
 * Compute a daily strain target based on readiness.
 *
 * - High readiness (70+): target 14-18, Push zone
 * - Moderate readiness (50-69): target 10-14, Maintain zone
 * - Low readiness (<50): target 4-10, Recovery zone
 */
export function computeStrainTarget(readinessScore: number): StrainTargetResult {
  let zone: StrainTargetResult["zone"];
  let minStrain: number;
  let maxStrain: number;

  if (readinessScore >= 70) {
    zone = "Push";
    minStrain = 14;
    maxStrain = 18;
  } else if (readinessScore >= 50) {
    zone = "Maintain";
    minStrain = 10;
    maxStrain = 14;
  } else {
    zone = "Recovery";
    minStrain = 4;
    maxStrain = 10;
  }

  // Interpolate within the zone based on readiness
  const zoneReadinessMin = zone === "Push" ? 70 : zone === "Maintain" ? 50 : 0;
  const zoneReadinessMax = zone === "Push" ? 100 : zone === "Maintain" ? 69 : 49;
  const fraction = Math.min(
    1,
    Math.max(0, (readinessScore - zoneReadinessMin) / (zoneReadinessMax - zoneReadinessMin)),
  );
  const targetStrain = minStrain + fraction * (maxStrain - minStrain);

  let explanation: string;
  if (zone === "Push") {
    explanation = `Recovery is strong (${readinessScore}). Push for a high-strain day to build fitness.`;
  } else if (zone === "Maintain") {
    explanation = `Moderate recovery (${readinessScore}). Aim for a steady training day.`;
  } else {
    explanation = `Recovery is low (${readinessScore}). Keep it light and focus on restoration.`;
  }

  return {
    targetStrain: Math.round(targetStrain * 10) / 10,
    zone,
    explanation,
  };
}
