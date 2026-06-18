import type { SyncDatabase } from "../../db/index.ts";
import { replaceMetricStreamBatch, writeMetricStreamBatch } from "../../db/metric-stream-writer.ts";
import { activity } from "../../db/schema.ts";
import { SOURCE_TYPE_FILE } from "../../db/sensor-channels.ts";
import { parseFitFile } from "../../fit/parser.ts";
import { fitRecordsToSensorSamples as fitRecordsToMetricStream } from "../../fit/records.ts";
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
  readonly #metricStreamPublisher?: MetricStreamEventPublisher;
  readonly #userId?: string;

  constructor(
    providerId: string,
    client: WahooClient,
    db: SyncDatabase,
    metricStreamPublisher?: MetricStreamEventPublisher,
    userId?: string,
  ) {
    this.#providerId = providerId;
    this.#client = client;
    this.#db = db;
    this.#metricStreamPublisher = metricStreamPublisher;
    this.#userId = userId;
  }

  async persist(
    parsed: ParsedCardioActivity,
    options?: {
      deleteExistingSamples?: boolean;
      formatLogMessage?: (rowCount: number, externalId: string) => string;
    },
  ): Promise<PersistResult> {
    const errors: SyncError[] = [];

    try {
      const [row] = await this.#db
        .insert(activity)
        .values({
          providerId: this.#providerId,
          externalId: parsed.externalId,
          activityType: parsed.activityType,
          startedAt: parsed.startedAt,
          endedAt: parsed.endedAt,
          name: parsed.name,
        })
        .onConflictDoUpdate({
          target: [activity.userId, activity.providerId, activity.externalId],
          set: {
            activityType: parsed.activityType,
            startedAt: parsed.startedAt,
            endedAt: parsed.endedAt,
            name: parsed.name,
            providerAbsentAt: null,
          },
        })
        .returning({ id: activity.id });

      const activityId = row?.id;
      if (!activityId) {
        return { synced: true, errors };
      }

      if (parsed.fitFileUrl) {
        try {
          const fitBuffer = await this.#client.downloadFitFile(parsed.fitFileUrl);
          const fitData = await parseFitFile(fitBuffer);
          const metricRows = fitRecordsToMetricStream(
            fitData.records,
            this.#providerId,
            activityId,
            parsed.activityType,
          ).map((row) => ({ ...row, userId: this.#userId }));

          if (metricRows.length > 0) {
            if (options?.deleteExistingSamples) {
              await replaceMetricStreamBatch(
                this.#db,
                { activityId },
                metricRows,
                SOURCE_TYPE_FILE,
                this.#metricStreamPublisher,
              );
            } else {
              await writeMetricStreamBatch(
                this.#db,
                metricRows,
                SOURCE_TYPE_FILE,
                undefined,
                this.#metricStreamPublisher,
              );
            }

            const logMessage = options?.formatLogMessage
              ? options.formatLogMessage(metricRows.length, parsed.externalId)
              : `[wahoo] Inserted ${metricRows.length} metric stream rows for workout ${parsed.externalId}`;
            logger.info(logMessage);
          }
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
