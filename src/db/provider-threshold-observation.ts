import { type SQLWrapper, sql } from "drizzle-orm";

interface ThresholdObservationDatabase {
  execute(query: SQLWrapper): Promise<Array<Record<string, unknown>>>;
}

export interface ProviderThresholdObservationInput {
  userId: string;
  providerId: string;
  providerRecordId: string;
  sport: string;
  thresholdType: string;
  value: number;
  unit: string;
  observedAt: Date;
  effectiveAt?: Date | null;
  raw: Record<string, unknown>;
}

/** Append raw provider threshold evidence only when its latest value changed. */
export async function recordProviderThresholdObservation(
  db: ThresholdObservationDatabase,
  observation: ProviderThresholdObservationInput,
): Promise<boolean> {
  if (!Number.isFinite(observation.value) || observation.value <= 0) {
    throw new Error("threshold value must be a positive finite number");
  }

  const effectiveAt = observation.effectiveAt ?? null;
  const rows = await db.execute(sql`
    WITH source_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(
        ${`${observation.userId}:${observation.providerId}:${observation.providerRecordId}:${observation.thresholdType}`},
        0
      ))
    ),
    latest AS (
      SELECT value, unit, effective_at
      FROM fitness.provider_threshold_observation
      CROSS JOIN source_lock
      WHERE user_id = ${observation.userId}::uuid
        AND provider_id = ${observation.providerId}
        AND provider_record_id = ${observation.providerRecordId}
        AND threshold_type = ${observation.thresholdType}
      ORDER BY observed_at DESC, created_at DESC, id DESC
      LIMIT 1
    ),
    inserted AS (
      INSERT INTO fitness.provider_threshold_observation (
        user_id,
        provider_id,
        provider_record_id,
        sport,
        threshold_type,
        value,
        unit,
        observed_at,
        effective_at,
        raw
      )
      SELECT
        ${observation.userId}::uuid,
        ${observation.providerId},
        ${observation.providerRecordId},
        ${observation.sport},
        ${observation.thresholdType},
        ${observation.value},
        ${observation.unit},
        ${observation.observedAt},
        ${effectiveAt},
        ${JSON.stringify(observation.raw)}::jsonb
      WHERE NOT EXISTS (
        SELECT 1
        FROM latest
        WHERE latest.value IS NOT DISTINCT FROM ${observation.value}
          AND latest.unit IS NOT DISTINCT FROM ${observation.unit}
          AND latest.effective_at IS NOT DISTINCT FROM ${effectiveAt}
      )
      RETURNING true AS inserted
    )
    SELECT inserted FROM inserted
  `);

  return rows.length > 0;
}
