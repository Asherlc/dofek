import { sql } from "drizzle-orm";
import { z } from "zod";
import type { SyncDatabase } from "../../../../src/db/index.ts";
import { getProviderDataGenerations } from "../../../../src/db/provider-data-deletion.ts";
import {
  getDefaultMetricStreamEventPublisher,
  type MetricStreamEventPublisher,
} from "../../../../src/metric-stream/redpanda-producer.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";

const PROVIDER_ID = "apple_health";

const metricStreamTypes = new Set([
  "HKQuantityTypeIdentifierBodyMass",
  "HKQuantityTypeIdentifierBodyFatPercentage",
  "HKQuantityTypeIdentifierBodyMassIndex",
  "HKQuantityTypeIdentifierHeight",
  "HKQuantityTypeIdentifierHeartRate",
  "HKQuantityTypeIdentifierOxygenSaturation",
  "HKQuantityTypeIdentifierRespiratoryRate",
  "HKQuantityTypeIdentifierBloodGlucose",
  "HKQuantityTypeIdentifierEnvironmentalAudioExposure",
  "HKQuantityTypeIdentifierAppleSleepingWristTemperature",
]);

export class HealthKitDeletionTombstonesUnsupportedError extends Error {
  constructor() {
    super("Metric stream publisher does not support HealthKit deletion tombstones");
    this.name = "HealthKitDeletionTombstonesUnsupportedError";
  }
}

/** Applies HealthKit anchored-query deletions to canonical stores. */
export class HealthKitSyncRepository {
  readonly #db: SyncDatabase;
  readonly #userId: string;
  readonly #metricStreamPublisher?: MetricStreamEventPublisher;

  constructor(
    db: SyncDatabase,
    userId: string,
    metricStreamPublisher?: MetricStreamEventPublisher,
  ) {
    this.#db = db;
    this.#userId = userId;
    this.#metricStreamPublisher = metricStreamPublisher;
  }

  async #publisher(): Promise<MetricStreamEventPublisher> {
    return this.#metricStreamPublisher ?? getDefaultMetricStreamEventPublisher();
  }

  /** Apply anchored-query deletions to UUID-addressable canonical stores. */
  async processDeletedQuantitySamples(
    typeIdentifier: string,
    deletedUUIDs: string[],
  ): Promise<number> {
    const uniqueUUIDs = [...new Set(deletedUUIDs)];
    if (uniqueUUIDs.length === 0) {
      return 0;
    }

    if (metricStreamTypes.has(typeIdentifier)) {
      const publisher = await this.#publisher();
      const replaceRows = publisher.replaceRows?.bind(publisher);
      if (!replaceRows) {
        throw new HealthKitDeletionTombstonesUnsupportedError();
      }
      const context = await getProviderDataGenerations(this.#db, [
        { providerId: PROVIDER_ID, userId: this.#userId },
      ]);
      await Promise.all(
        uniqueUUIDs.map((uuid) =>
          replaceRows(
            {
              userId: this.#userId,
              providerId: PROVIDER_ID,
              externalId: `hk:${uuid}`,
            },
            [],
            context.operationRevision,
          ),
        ),
      );
      return uniqueUUIDs.length;
    }

    const externalIds = uniqueUUIDs.map((uuid) => `hk:${uuid}`);
    const deletedRows = await executeWithSchema(
      this.#db,
      z.object({ externalId: z.string() }),
      sql`DELETE FROM fitness.health_event
          WHERE user_id = ${this.#userId}
            AND provider_id = ${PROVIDER_ID}
            AND external_id IN (${sql.join(
              externalIds.map((externalId) => sql`${externalId}`),
              sql`, `,
            )})
          RETURNING external_id AS "externalId"`,
    );
    return deletedRows.length;
  }
}
