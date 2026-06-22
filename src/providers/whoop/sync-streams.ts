import { writeMetricStreamBatch } from "../../db/metric-stream-writer.ts";
import { SOURCE_TYPE_API } from "../../db/sensor-channels.ts";
import { withSyncLog } from "../../db/sync-log.ts";
import { parseHeartRateValues } from "./parsing.ts";
import { isWhoopRateLimitError } from "./rate-limit.ts";
import type { WhoopSyncContext } from "./sync-types.ts";

export type WhoopStreamSyncResult = {
  count: number;
  rateLimited: boolean;
};

export async function syncWhoopHeartRateForWindow(
  context: WhoopSyncContext,
  start: string,
  end: string,
): Promise<number> {
  const { db, client, providerId, options } = context;
  const values = await client.getHeartRate(start, end, 6);
  const parsed = parseHeartRateValues(values);
  const metricRows = parsed.map((row) => ({
    providerId,
    recordedAt: row.recordedAt,
    heartRate: row.heartRate,
  }));
  await writeMetricStreamBatch(
    db,
    metricRows,
    SOURCE_TYPE_API,
    undefined,
    options?.metricStreamPublisher,
  );
  return parsed.length;
}

export async function syncWhoopHeartRateStream(
  context: WhoopSyncContext,
): Promise<WhoopStreamSyncResult> {
  const { db, client, providerId, since, options } = context;

  try {
    const count = await withSyncLog(
      db,
      providerId,
      "hr_stream",
      async () => {
        const weekMs = 7 * 24 * 60 * 60 * 1000;
        let windowStart = since.getTime();
        const nowMs = Date.now();
        let totalRecords = 0;

        while (windowStart < nowMs) {
          const windowEnd = Math.min(windowStart + weekMs, nowMs);
          const startStr = new Date(windowStart).toISOString();
          const endStr = new Date(windowEnd).toISOString();

          const values = await client.getHeartRate(startStr, endStr, 6);
          const parsed = parseHeartRateValues(values);

          const metricRows = parsed.map((row) => ({
            providerId,
            recordedAt: row.recordedAt,
            heartRate: row.heartRate,
          }));
          await writeMetricStreamBatch(
            db,
            metricRows,
            SOURCE_TYPE_API,
            undefined,
            options?.metricStreamPublisher,
          );

          totalRecords += parsed.length;
          windowStart = windowEnd;
        }

        return { recordCount: totalRecords, result: totalRecords };
      },
      options?.userId,
    );
    return { count, rateLimited: false };
  } catch (err) {
    if (isWhoopRateLimitError(err)) {
      context.errors.push({
        message: `hr_stream: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
      return { count: 0, rateLimited: true };
    }
    context.errors.push({
      message: `hr_stream: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
    return { count: 0, rateLimited: false };
  }
}
