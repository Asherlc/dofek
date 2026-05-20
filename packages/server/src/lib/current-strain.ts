import { StrainScore } from "@dofek/scoring/scoring";
import { z } from "zod";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";

export interface CurrentStrainResult {
  currentStrain: number;
  currentStrainSource: "heart_rate" | "activity" | "none";
  currentPhysiologyLoad: number | null;
}

const currentPhysiologyLoadRowSchema = z.object({
  physiological_load: z.coerce.number().nullable(),
});

export async function computeCurrentStrain({
  sensorStore,
  userId,
  timezone,
  endDate,
  fallbackActivityLoad,
}: {
  sensorStore: ActivitySensorStore;
  userId: string;
  timezone: string;
  endDate: string;
  fallbackActivityLoad: number;
}): Promise<CurrentStrainResult> {
  const rows = await sensorStore.query(
    currentPhysiologyLoadRowSchema,
    `WITH samples AS (
      SELECT recorded_at, scalar
      FROM analytics.deduped_sensor
      WHERE user_id = {userId:UUID}
        AND channel = 'heart_rate'
        AND scalar IS NOT NULL
        AND scalar > 0
        AND toDate(toTimeZone(recorded_at, {timezone:String})) = toDate({endDate:String})
    )
    SELECT
      if(
        count() > 1 AND max(scalar) > 0,
        dateDiff('second', min(recorded_at), max(recorded_at)) / 60.0
          * avg(scalar)
          / max(scalar)
          / 100.0,
        NULL
      ) AS physiological_load
    FROM samples`,
    { userId, timezone, endDate },
  );

  const physiologyLoad = rows[0]?.physiological_load ?? null;
  if (physiologyLoad != null) {
    return {
      currentStrain: StrainScore.fromPhysiologicalLoad(physiologyLoad).value,
      currentStrainSource: "heart_rate",
      currentPhysiologyLoad: Math.round(physiologyLoad * 100) / 100,
    };
  }

  if (fallbackActivityLoad > 0) {
    return {
      currentStrain: StrainScore.fromRawLoad(fallbackActivityLoad).value,
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
