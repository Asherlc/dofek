export const SPORT_DATA_TYPES = [
  "speed",
  "avg_speed",
  "pace",
  "avg_pace",
  "distance",
  "duration",
  "cadence",
  "avg_cadence",
  "altitude",
  "total_up_altitude",
  "total_count",
  "vertical_speed",
  "downhill_count",
  "total_downhill_distance",
] as const;

export type SportDataType = (typeof SPORT_DATA_TYPES)[number];

interface SportDataCallbackResult {
  code: number;
  data: string;
}

export type GetSportData = (
  options: { type: SportDataType },
  callback: (result: SportDataCallbackResult) => void,
) => boolean;

export interface LiveWorkoutSnapshot {
  recordedAt: string;
  heartRate?: number;
  metrics: Partial<Record<SportDataType, number>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function durationSeconds(value: string): number | undefined {
  const parts = value.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return undefined;
  if (parts.length === 3) return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  if (parts.length === 2) return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
  return undefined;
}

function paceSeconds(value: string): number | undefined {
  const match = /^(\d+)'\s*(\d+)/.exec(value);
  if (!match) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}

function parseMetric(type: SportDataType, data: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(data);
    if (!Array.isArray(parsed) || !isRecord(parsed[0])) return undefined;
    const rawValue = parsed[0][type];
    if (typeof rawValue === "number") return rawValue;
    if (typeof rawValue !== "string") return undefined;
    if (type === "duration") return durationSeconds(rawValue);
    if (type === "pace" || type === "avg_pace") return paceSeconds(rawValue);
    const numericValue = Number(rawValue);
    return Number.isFinite(numericValue) ? numericValue : undefined;
  } catch {
    return undefined;
  }
}

function requestMetric(
  getSportData: GetSportData,
  type: SportDataType,
): Promise<number | undefined> {
  return new Promise((resolve) => {
    const requested = getSportData({ type }, (result) => {
      resolve(result.code === 0 ? parseMetric(type, result.data) : undefined);
    });
    if (!requested) resolve(undefined);
  });
}

export async function collectLiveWorkoutSnapshot(
  getSportData: GetSportData,
  getHeartRate: () => number,
  now = Date.now(),
): Promise<LiveWorkoutSnapshot> {
  const metricValues = await Promise.all(
    SPORT_DATA_TYPES.map(async (type) => [type, await requestMetric(getSportData, type)] as const),
  );
  const metrics: Partial<Record<SportDataType, number>> = {};
  for (const [type, value] of metricValues) {
    if (value !== undefined) metrics[type] = value;
  }
  const heartRate = getHeartRate();
  return {
    recordedAt: new Date(now).toISOString(),
    heartRate: heartRate > 0 ? heartRate : undefined,
    metrics,
  };
}

export function liveWorkoutExternalId(snapshot: LiveWorkoutSnapshot): string | undefined {
  const duration = snapshot.metrics.duration;
  if (duration === undefined) return undefined;
  return String(Math.round(new Date(snapshot.recordedAt).getTime() / 1000 - duration));
}

export function findLiveWorkoutExternalId(
  snapshot: LiveWorkoutSnapshot,
  existingExternalIds: string[],
): string | undefined {
  const candidate = liveWorkoutExternalId(snapshot);
  if (candidate === undefined) return existingExternalIds.at(-1);
  const candidateSeconds = Number(candidate);
  return (
    existingExternalIds.find(
      (externalId) => Math.abs(Number(externalId) - candidateSeconds) <= 5,
    ) ?? candidate
  );
}
