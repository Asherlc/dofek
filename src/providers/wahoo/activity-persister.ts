import type { SyncDatabase } from "../../db/index.ts";
import { upsertProviderActivity } from "../../db/provider-activity-sync.ts";
import { enqueueFitFileImportAndWait } from "../../jobs/enqueue-fit-file-import.ts";
import { logger } from "../../logger.ts";
import type { MetricStreamEventPublisher } from "../../metric-stream/redpanda-producer.ts";
import type { SyncError } from "../types.ts";
import type { WahooClient } from "./client.ts";
import type { ParsedCardioActivity } from "./parsers.ts";

interface PersistResult {
  synced: boolean;
  activityId?: string;
  errors: SyncError[];
}

export class WahooActivityPersister {
  readonly #providerId: string;
  readonly #client: WahooClient;
  readonly #db: SyncDatabase;
  readonly #userId?: string;
  readonly #metricStreamPublisher?: MetricStreamEventPublisher;

  constructor(
    providerId: string,
    client: WahooClient,
    db: SyncDatabase,
    userId?: string,
    metricStreamPublisher?: MetricStreamEventPublisher,
  ) {
    this.#providerId = providerId;
    this.#client = client;
    this.#db = db;
    this.#userId = userId;
    this.#metricStreamPublisher = metricStreamPublisher;
  }

  async persist(parsed: ParsedCardioActivity): Promise<PersistResult> {
    const errors: SyncError[] = [];

    try {
      const row = await upsertProviderActivity(
        this.#db,
        {
          providerId: this.#providerId,
          externalId: parsed.externalId,
          activityType: parsed.activityType,
          startedAt: parsed.startedAt,
          endedAt: parsed.endedAt,
          name: parsed.name,
        },
        {
          activityType: parsed.activityType,
          startedAt: parsed.startedAt,
          endedAt: parsed.endedAt,
          name: parsed.name,
        },
      );

      const activityId = row?.id;
      if (!activityId) {
        return { synced: true, errors };
      }

      if (parsed.fitFileUrl) {
        try {
          const fitBuffer = await this.#client.downloadFitFile(parsed.fitFileUrl);
          await enqueueFitFileImportAndWait({
            fitBuffer,
            providerId: this.#providerId,
            sourceName: "Wahoo",
            ...(this.#userId ? { userId: this.#userId } : {}),
            ...(this.#metricStreamPublisher
              ? { db: this.#db, metricStreamPublisher: this.#metricStreamPublisher }
              : {}),
            activitySummary: {
              externalId: parsed.externalId,
              activityType: parsed.activityType,
              startedAtIso: parsed.startedAt.toISOString(),
              ...(parsed.endedAt ? { endedAtIso: parsed.endedAt.toISOString() } : {}),
              name:
                parsed.name ??
                `Wahoo ${parsed.activityType.canonicalType.replace(/_/g, " ")}`,
            },
          });
          logger.info(`[wahoo] Imported FIT file for workout ${parsed.externalId}`);
        } catch (fitErr) {
          errors.push({
            message: `FIT file for ${parsed.externalId}: ${fitErr instanceof Error ? fitErr.message : String(fitErr)}`,
            externalId: parsed.externalId,
            cause: fitErr,
          });
        }
      }

      return { synced: true, activityId, errors };
    } catch (err) {
      errors.push({
        message: err instanceof Error ? err.message : String(err),
        externalId: parsed.externalId,
        cause: err,
      });
      return { synced: false, errors };
    }
  }
}
