import type { Database } from "dofek/db";
import { type EffectiveParams, DEFAULT_PARAMS, getEffectiveParams } from "dofek/personalization/params";
import { refitAllParams } from "dofek/personalization/refit";
import { loadPersonalizedParams, SETTINGS_KEY } from "dofek/personalization/storage";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface PersonalizationStatus {
  isPersonalized: boolean;
  fittedAt: string | null;
  defaults: EffectiveParams;
  effective: EffectiveParams;
  parameters: PersonalizationParameters;
}

export interface PersonalizationParameters {
  exponentialMovingAverage: {
    chronicTrainingLoadDays: number;
    acuteTrainingLoadDays: number;
    sampleCount: number;
    correlation: number;
  } | null;
  readinessWeights: {
    hrv: number;
    restingHr: number;
    sleep: number;
    respiratoryRate: number;
    sampleCount: number;
    correlation: number;
  } | null;
  sleepTarget: { minutes: number; sampleCount: number } | null;
  stressThresholds: {
    hrvThresholds: [number, number, number];
    rhrThresholds: [number, number, number];
    sampleCount: number;
  } | null;
  trainingImpulseConstants: {
    genderFactor: number;
    exponent: number;
    sampleCount: number;
    r2: number;
  } | null;
}

export interface RefitResult {
  fittedAt: string;
  effective: EffectiveParams;
  parameters: PersonalizationParameters;
}

export interface ResetResult {
  effective: EffectiveParams;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for user personalization parameters. */
export class PersonalizationRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;

  constructor(db: Pick<Database, "execute">, userId: string) {
    this.#db = db;
    this.#userId = userId;
  }

  /** Load current personalization status including learned and effective params. */
  async getStatus(): Promise<PersonalizationStatus> {
    // loadPersonalizedParams requires full Database type but only uses execute
    const stored = await loadPersonalizedParams(this.#db as Database, this.#userId);
    const effective = getEffectiveParams(stored);

    return {
      isPersonalized:
        stored !== null &&
        (stored.exponentialMovingAverage !== null ||
          stored.readinessWeights !== null ||
          stored.sleepTarget !== null ||
          stored.stressThresholds !== null ||
          stored.trainingImpulseConstants !== null),
      fittedAt: stored?.fittedAt ?? null,
      defaults: DEFAULT_PARAMS,
      effective,
      parameters: {
        exponentialMovingAverage: stored?.exponentialMovingAverage ?? null,
        readinessWeights: stored?.readinessWeights ?? null,
        sleepTarget: stored?.sleepTarget ?? null,
        stressThresholds: stored?.stressThresholds ?? null,
        trainingImpulseConstants: stored?.trainingImpulseConstants ?? null,
      },
    };
  }

  /** Trigger an immediate refit of personalized parameters. */
  async refit(): Promise<RefitResult> {
    // refitAllParams requires full Database type but only uses execute
    const params = await refitAllParams(this.#db as Database, this.#userId);
    const effective = getEffectiveParams(params);

    return {
      fittedAt: params.fittedAt,
      effective,
      parameters: {
        exponentialMovingAverage: params.exponentialMovingAverage,
        readinessWeights: params.readinessWeights,
        sleepTarget: params.sleepTarget,
        stressThresholds: params.stressThresholds,
        trainingImpulseConstants: params.trainingImpulseConstants,
      },
    };
  }

  /** Reset personalization to defaults by deleting stored params. */
  async reset(): Promise<ResetResult> {
    await this.#db.execute(
      sql`DELETE FROM fitness.user_settings
          WHERE user_id = ${this.#userId} AND key = ${SETTINGS_KEY}`,
    );
    return { effective: DEFAULT_PARAMS };
  }
}
