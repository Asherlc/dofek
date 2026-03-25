export interface StrainTargetResult {
  /** Recommended strain target for the day (0-21 scale) */
  targetStrain: number;
  /** Zone label */
  zone: "Push" | "Maintain" | "Recovery";
  /** Human-readable explanation */
  explanation: string;
}

/**
 * Compute a daily strain target based on readiness, chronic load, and acute load.
 *
 * - High readiness (70+): target 14-18, Push zone
 * - Moderate readiness (50-69): target 10-14, Maintain zone
 * - Low readiness (<50): target 4-10, Recovery zone
 * - If ACWR (acute/chronic) > 1.3, caps the target to prevent injury
 */
export function computeStrainTarget(
  readinessScore: number,
  chronicLoad: number,
  acuteLoad: number,
): StrainTargetResult {
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
  let targetStrain = minStrain + fraction * (maxStrain - minStrain);

  // Cap if ACWR is too high (injury risk)
  let explanation: string;
  const acwr = chronicLoad > 0 ? acuteLoad / chronicLoad : 0;

  if (acwr > 1.3 && chronicLoad > 0) {
    const cappedTarget = Math.min(targetStrain, 12);
    if (cappedTarget < targetStrain) {
      targetStrain = cappedTarget;
      zone = targetStrain < 10 ? "Recovery" : "Maintain";
    }
    explanation = `Your acute:chronic workload ratio (${acwr.toFixed(2)}) is elevated. Strain target capped to reduce injury risk.`;
  } else if (zone === "Push") {
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
