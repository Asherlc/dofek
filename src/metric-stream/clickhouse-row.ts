import type { MetricStreamRowEvent } from "./events.ts";

export interface ClickHouseMetricStreamRow {
  recorded_at: string;
  user_id: string;
  provider_id: string;
  generation: number;
  external_id: string | null;
  device_id: string | null;
  source_type: string;
  channel: string;
  activity_id: string | null;
  scalar: number | null;
  vector: number[];
  point: string | null;
  metadata: string;
  id: string;
  ingested_at: string;
  is_deleted: 0 | 1;
  version: number | string;
}

export function mapMetricStreamEventToClickHouseRow(
  event: MetricStreamRowEvent,
  ingestedAt: string,
): ClickHouseMetricStreamRow {
  const point = event.point;
  const ewkt = point && /^SRID=4326;POINT\((-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)\)$/.exec(point);
  return {
    recorded_at: event.recordedAt,
    user_id: event.userId,
    provider_id: event.providerId,
    generation: event.generation,
    external_id: event.externalId ?? null,
    device_id: event.deviceId ?? null,
    source_type: event.sourceType,
    channel: event.channel,
    activity_id: event.activityId ?? null,
    scalar: event.scalar ?? null,
    vector: event.vector ?? [],
    point: ewkt
      ? JSON.stringify({ type: "Point", coordinates: [Number(ewkt[1]), Number(ewkt[2])] })
      : point || null,
    metadata: JSON.stringify(event.metadata ?? null),
    id: event.id,
    ingested_at: ingestedAt,
    is_deleted: 0,
    version: event.version === 1 ? 0 : (BigInt(event.operationRevision) * 2n + 1n).toString(),
  };
}
