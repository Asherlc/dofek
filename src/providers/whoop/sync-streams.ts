import { writeMetricStreamBatch } from "../../db/metric-stream-writer.ts";
import { SOURCE_TYPE_API } from "../../db/sensor-channels.ts";
import { parseHeartRateValues } from "./parsing.ts";
import type { WhoopSyncContext } from "./sync-types.ts";

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
