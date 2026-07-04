import { createHash } from "node:crypto";
import type { SyncDatabase } from "../../db/index.ts";
import { imuSession } from "../../db/schema/events.ts";
import {
  ALTITUDE,
  BAROMETRIC_PRESSURE,
  BODY_TEMPERATURE,
  COMPASS_HEADING,
  HEART_RATE,
  LOCATION,
  SOURCE_TYPE_FILE,
  SPO2,
  STRESS,
} from "../../db/sensor-channels.ts";
import { ensureProvider } from "../../db/tokens.ts";
import type { MetricStreamRowInput } from "../../metric-stream/events.ts";
import {
  getDefaultMetricStreamEventPublisher,
  type MetricStreamEventPublisher,
} from "../../metric-stream/redpanda-producer.ts";
import type { ImportProvider, SyncError, SyncResult } from "../types.ts";
import { type DecodedSession, decodeBin, type PhysicalScalarChannel } from "./decode.ts";

export const ZOS_APP_PROVIDER_ID = "zos-app";

const PHYSICAL_CHANNEL_TO_METRIC_CHANNEL = {
  heartRate: HEART_RATE,
  spo2: SPO2,
  stress: STRESS,
  bodyTemperature: BODY_TEMPERATURE,
  barometricPressure: BAROMETRIC_PRESSURE,
  altitude: ALTITUDE,
  compassHeading: COMPASS_HEADING,
} satisfies Record<PhysicalScalarChannel, string>;

function createPhysicalMetricStreamRows(
  decoded: DecodedSession,
  userId: string,
): MetricStreamRowInput[] {
  const rows: MetricStreamRowInput[] = decoded.physicalSamples.map((sample) => {
    const channel = PHYSICAL_CHANNEL_TO_METRIC_CHANNEL[sample.channel];
    return {
      recordedAt: new Date(decoded.sessionStartMs + sample.tMs),
      userId,
      providerId: ZOS_APP_PROVIDER_ID,
      externalId: `zos-app:${decoded.sessionStartMs}:${channel}:${sample.tMs}`,
      deviceId: null,
      sourceType: SOURCE_TYPE_FILE,
      channel,
      scalar: sample.value,
    };
  });

  for (const sample of decoded.locationSamples) {
    rows.push({
      recordedAt: new Date(decoded.sessionStartMs + sample.tMs),
      userId,
      providerId: ZOS_APP_PROVIDER_ID,
      externalId: `zos-app:${decoded.sessionStartMs}:location:${sample.tMs}`,
      deviceId: null,
      sourceType: SOURCE_TYPE_FILE,
      channel: LOCATION,
      point: `SRID=4326;POINT(${sample.longitude} ${sample.latitude})`,
    });

    if (sample.altitude !== undefined && Number.isFinite(sample.altitude)) {
      rows.push({
        recordedAt: new Date(decoded.sessionStartMs + sample.tMs),
        userId,
        providerId: ZOS_APP_PROVIDER_ID,
        externalId: `zos-app:${decoded.sessionStartMs}:location-altitude:${sample.tMs}`,
        deviceId: null,
        sourceType: SOURCE_TYPE_FILE,
        channel: ALTITUDE,
        scalar: sample.altitude,
      });
    }
  }

  return rows;
}

export async function importZosAppBin(
  db: SyncDatabase,
  binData: Buffer,
  userId: string,
  metricStreamPublisher?: MetricStreamEventPublisher,
): Promise<SyncResult> {
  const start = Date.now();
  const errors: SyncError[] = [];

  await ensureProvider(db, ZOS_APP_PROVIDER_ID, "Zepp OS App", undefined, userId);

  let decoded: ReturnType<typeof decodeBin>;
  try {
    decoded = decodeBin(new Uint8Array(binData).buffer);
  } catch (err) {
    return {
      provider: ZOS_APP_PROVIDER_ID,
      recordsSynced: 0,
      errors: [
        {
          message: `Failed to decode IMU binary: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        },
      ],
      duration: Date.now() - start,
    };
  }

  const externalId = `zos-app:${createHash("sha256").update(decoded.sessionStartMs.toString()).digest("hex").slice(0, 16)}`;
  const sessionStartAt = new Date(decoded.sessionStartMs);
  const rawData = binData.toString("base64");

  try {
    await db
      .insert(imuSession)
      .values({
        providerId: ZOS_APP_PROVIDER_ID,
        userId,
        externalId,
        sessionStartAt,
        sampleCount: decoded.samples.length,
        observedHz: decoded.observedHz,
        hasGyro: decoded.hasGyro,
        accelFreqMode: decoded.accelFreqMode,
        gyroFreqMode: decoded.hasGyro ? decoded.gyroFreqMode : null,
        rawData,
      })
      .onConflictDoNothing();
  } catch (err) {
    return {
      provider: ZOS_APP_PROVIDER_ID,
      recordsSynced: 0,
      errors: [
        {
          message: `Failed to store IMU session: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        },
      ],
      duration: Date.now() - start,
    };
  }

  const metricStreamRows = createPhysicalMetricStreamRows(decoded, userId);
  if (metricStreamRows.length > 0) {
    try {
      const publisher = metricStreamPublisher ?? (await getDefaultMetricStreamEventPublisher());
      await publisher.publishRows(metricStreamRows);
    } catch (err) {
      return {
        provider: ZOS_APP_PROVIDER_ID,
        recordsSynced: 1,
        errors: [
          {
            message: `Failed to publish Zepp physical samples: ${
              err instanceof Error ? err.message : String(err)
            }`,
            cause: err,
          },
        ],
        duration: Date.now() - start,
      };
    }
  }

  return {
    provider: ZOS_APP_PROVIDER_ID,
    recordsSynced: 1 + metricStreamRows.length,
    errors,
    duration: Date.now() - start,
  };
}

export class ZosAppProvider implements ImportProvider {
  readonly id = ZOS_APP_PROVIDER_ID;
  readonly name = "Zepp OS App";
  readonly importOnly = true as const;

  validate(): string | null {
    return null;
  }
}
