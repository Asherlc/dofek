import { createHash } from "node:crypto";
import type { SyncDatabase } from "../../db/index.ts";
import { imuSession } from "../../db/schema/events.ts";
import { ensureProvider } from "../../db/tokens.ts";
import type { ImportProvider, SyncError, SyncResult } from "../types.ts";
import { decodeBin } from "./decode.ts";

export const ZOS_APP_PROVIDER_ID = "zos-app";

export async function importZosAppBin(
  db: SyncDatabase,
  binData: Buffer,
  userId: string,
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

  return {
    provider: ZOS_APP_PROVIDER_ID,
    recordsSynced: 1,
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
