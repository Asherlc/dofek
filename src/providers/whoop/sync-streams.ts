import { WhoopRateLimitError } from "whoop-whoop/client";
import { writeMetricStreamBatch } from "../../db/metric-stream-writer.ts";
import { SOURCE_TYPE_API } from "../../db/sensor-channels.ts";
import { withSyncLog } from "../../db/sync-log.ts";
import { parseHeartRateValues } from "./parsing.ts";
import type { WhoopSyncContext } from "./sync-types.ts";

export type WhoopStreamSyncResult = {
  count: number;
  rateLimited: boolean;
};

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
          await writeMetricStreamBatch(db, metricRows, SOURCE_TYPE_API);

          totalRecords += parsed.length;
          windowStart = windowEnd;
        }

        return { recordCount: totalRecords, result: totalRecords };
      },
      options?.userId,
    );
    return { count, rateLimited: false };
  } catch (err) {
    if (err instanceof WhoopRateLimitError) {
      context.errors.push({
        message: `hr_stream: ${err.message}`,
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
