import {
  type BoundedSensorFixture,
  type SensorFixtureRow,
  sensorRow,
} from "./bounded-sensor-test-helpers.ts";

export const sensorResourceIds = 400_000;
export const sensorResourceKeys = 1_000;
const batchRows = 10_000;

export function sensorResourceId(index: number): string {
  return `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

export function sensorResourceTime(key: number): string {
  return `2026-01-01 00:00:00.${String(key).padStart(3, "0")}000`;
}

export function sensorResourceRow(
  index: number,
  version: 1 | 2,
  keyCount = sensorResourceKeys,
): SensorFixtureRow {
  const key = index % keyCount;
  const candidate = Math.floor(index / keyCount);
  return sensorRow(1, {
    id: sensorResourceId(index),
    activity_id: index % 2 === 0 ? null : sensorResourceId(sensorResourceIds + index),
    recorded_at: sensorResourceTime(key),
    provider_id: candidate % 4 < 2 ? "reported" : "fallback",
    external_id: index % 2 === 0 ? null : String(index),
    device_id: index % 2 === 0 ? null : "d".repeat(32),
    source_type: index % 2 === 0 ? null : "t".repeat(16),
    scalar: version * 111,
    metadata: JSON.stringify({ measurement_kind: candidate % 2 === 0 ? "direct" : "estimated" }),
    version: String(version),
    ingested_at: version === 1 ? "2026-01-02 00:00:00.123456781" : "2026-01-03 00:00:00.123456782",
    is_deleted:
      keyCount === sensorResourceKeys && key === sensorResourceKeys - 1 && version === 2 ? 1 : 0,
  });
}

/** Fixture input only; both measured transformations still run through native dbt. */
export async function seedSensorResourceHistory(
  fixture: BoundedSensorFixture,
  shape: "distributed" | "pathological",
): Promise<void> {
  const keyCount = shape === "distributed" ? sensorResourceKeys : 1;
  await fixture.command(`SYSTEM STOP MERGES ${fixture.database}.metric_stream`);
  if (shape === "distributed") {
    await fixture.command(`SYSTEM STOP MERGES ${fixture.database}.sensor_scalar_sample`);
  }
  for (const version of [1, 2] as const) {
    const ingestion =
      version === 1 ? "2026-01-02 00:00:00.123456781" : "2026-01-03 00:00:00.123456782";
    for (let offset = 0; offset < sensorResourceIds; offset += batchRows) {
      await fixture.command(`INSERT INTO ${fixture.database}.metric_stream
        (id, activity_id, user_id, recorded_at, channel, provider_id, external_id,
          device_id, source_type, scalar, metadata, ingested_at, version, generation, is_deleted)
        SELECT
          toUUID(concat('10000000-0000-4000-8000-', leftPad(toString(number + 1), 12, '0'))),
          if(number % 2 = 0, NULL,
            toUUID(concat('10000000-0000-4000-8000-', leftPad(toString(number + ${sensorResourceIds} + 1), 12, '0')))),
          toUUID('00000000-0000-4000-8000-000000000001'),
          toDateTime64('2026-01-01', 6) + toIntervalMillisecond(number % ${keyCount}),
          'heart_rate', if(intDiv(number, ${keyCount}) % 4 < 2, 'reported', 'fallback'),
          if(number % 2 = 0, NULL, toString(number)),
          if(number % 2 = 0, NULL, repeat('d', 32)),
          if(number % 2 = 0, NULL, repeat('t', 16)), ${version * 111},
          if(intDiv(number, ${keyCount}) % 2 = 0,
            '{"measurement_kind":"direct"}', '{"measurement_kind":"estimated"}'),
          toDateTime64('${ingestion}', 9), ${version}, 1,
          ${shape === "distributed" && version === 2 ? `toInt8(number % ${keyCount} = 999)` : "toInt8(0)"}
        FROM numbers(${offset}, ${batchRows})`);
      if (shape === "distributed") {
        // Preserve the original 800,000 normalized versions, independently of the new page.
        await fixture.command(`INSERT INTO ${fixture.database}.sensor_scalar_sample
          (id, activity_id, member_activity_id, user_id, recorded_at, recorded_date,
            channel, provider_id, source_external_id, device_id, source_type,
            measurement_kind, scalar, provider_priority, _peerdb_synced_at,
            _peerdb_is_deleted, _peerdb_version, refresh_version)
          SELECT id, activity_id, activity_id, user_id, recorded_at, toDate(recorded_at),
            channel, provider_id, external_id, device_id, source_type,
            JSONExtractString(metadata, 'measurement_kind'), scalar,
            if(provider_id = 'reported', toUInt16(1), toUInt16(2)), ingested_at,
            toUInt8(is_deleted), version, toUInt64(${version})
          FROM ${fixture.database}.metric_stream
          WHERE version = ${version} AND id IN (
            SELECT toUUID(concat('10000000-0000-4000-8000-', leftPad(toString(number + 1), 12, '0')))
            FROM numbers(${offset}, ${batchRows})
          )`);
      }
    }
  }
}

/** Add unrelated neighboring keys without changing any original source or affected key. */
export async function seedInterleavedSensorResourceBackground(
  fixture: BoundedSensorFixture,
): Promise<void> {
  const backgroundIds = 1_200_000;
  for (const version of [1, 2] as const) {
    const ingestion =
      version === 1 ? "2026-01-02 00:00:00.123456781" : "2026-01-03 00:00:00.123456782";
    for (let offset = 0; offset < backgroundIds; offset += batchRows) {
      const input = `SELECT
        toUUID(concat('10000000-0000-4000-8000-', leftPad(toString(number + 400001), 12, '0'))) AS id,
        if(number % 2 = 0, NULL,
          toUUID(concat('10000000-0000-4000-8000-', leftPad(toString(number + 800001), 12, '0')))) AS activity_id,
        toUUID('00000000-0000-4000-8000-000000000001') AS user_id,
        toDateTime64('2026-01-01', 6) + toIntervalMicrosecond(
          intDiv(number % 3000, 3) * 1000 + (number % 3 + 1) * 250) AS recorded_at,
        'heart_rate' AS channel,
        if(intDiv(number, 3000) % 4 < 2, 'reported', 'fallback') AS provider_id,
        if(number % 2 = 0, NULL, toString(number + 400000)) AS external_id,
        if(number % 2 = 0, NULL, repeat('d', 32)) AS device_id,
        if(number % 2 = 0, NULL, repeat('t', 16)) AS source_type,
        ${version * 111} AS scalar,
        if(intDiv(number, 3000) % 2 = 0,
          '{"measurement_kind":"direct"}', '{"measurement_kind":"estimated"}') AS metadata,
        toDateTime64('${ingestion}', 9) AS ingested_at,
        toInt64(${version}) AS version, toUInt64(1) AS generation, toInt8(0) AS is_deleted
        FROM numbers(${offset}, ${batchRows})`;
      await fixture.command(`INSERT INTO ${fixture.database}.metric_stream
        (id, activity_id, user_id, recorded_at, channel, provider_id, external_id,
          device_id, source_type, scalar, metadata, ingested_at, version, generation, is_deleted)
        ${input}`);
      // Known fixture history, not a measured scalar transformation or a production writer.
      await fixture.command(`INSERT INTO ${fixture.database}.sensor_scalar_sample
        (id, activity_id, member_activity_id, user_id, recorded_at, recorded_date,
          channel, provider_id, source_external_id, device_id, source_type,
          measurement_kind, scalar, provider_priority, _peerdb_synced_at,
          _peerdb_is_deleted, _peerdb_version, refresh_version)
        SELECT id, activity_id, activity_id, user_id, recorded_at, toDate(recorded_at),
          channel, provider_id, external_id, device_id, source_type,
          JSONExtractString(metadata, 'measurement_kind'), scalar,
          if(provider_id = 'reported', toUInt16(1), toUInt16(2)), ingested_at,
          toUInt8(is_deleted), version, toUInt64(${version})
        FROM (${input})`);
    }
  }
}
