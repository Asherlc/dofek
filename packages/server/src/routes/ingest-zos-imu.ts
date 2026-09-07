import type { Database } from "dofek/db";
import { ensureProvider } from "dofek/db/tokens";
import { captureException } from "dofek/lib/error-reporting";
import express, { type Request, type Response, Router } from "express";
import { z } from "zod";
import { SOURCE_TYPE_API } from "../../../../src/db/sensor-channels.ts";
import type { MetricStreamRowInput } from "../../../../src/metric-stream/events.ts";
import {
  getDefaultMetricStreamEventPublisher,
  type MetricStreamEventPublisher,
} from "../../../../src/metric-stream/redpanda-producer.ts";
import { writeMetricStreamRows } from "../../../../src/metric-stream/write-metric-stream.ts";
import { decodeBin } from "../../../../src/providers/zos-app/decode.ts";
import { validateCompanionToken } from "../companion/token-repository.ts";

const payloadSchema = z.strictObject({
  accountId: z.guid(),
  data: z.array(z.number().int().min(0).max(255)).min(32).max(16384),
  sampleOffset: z.number().int().nonnegative(),
});

function decodeRows(data: number[], sampleOffset: number, userId: string): MetricStreamRowInput[] {
  const session = decodeBin(Uint8Array.from(data).buffer);
  if (!Number.isSafeInteger(session.sessionStartMs) || session.samples.length === 0) {
    throw new Error("IMU batch must have a valid start time and at least one sample.");
  }
  return session.samples.map((sample, index) => {
    const recordIndex = session.version === 1 && session.hasGyro ? Math.floor(index / 2) : index;
    const originalIndex = sampleOffset + recordIndex;
    const timestamp = session.sessionStartMs + sample.tMs;
    const recordedAt = new Date(timestamp);
    if (
      !Number.isSafeInteger(originalIndex) ||
      !Number.isSafeInteger(timestamp) ||
      !Number.isFinite(recordedAt.getTime()) ||
      ![sample.x, sample.y, sample.z].every(Number.isFinite)
    ) {
      throw new Error(
        "IMU samples must have finite vectors, valid timestamps, and safe record offsets.",
      );
    }
    return {
      recordedAt,
      userId,
      providerId: "amazfit-zepp",
      externalId: `zos-imu:${session.sessionStartMs}:${originalIndex}:${sample.sensor}`,
      sourceType: SOURCE_TYPE_API,
      channel: sample.sensor,
      vector: [sample.x, sample.y, sample.z],
      // Preserve Zepp's raw units; Apple's accel/imu channels use g and rad/s.
      // https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/Accelerometer/
      // https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/Gyroscope/
      metadata: {
        units: sample.sensor === "accelerometer" ? "cm/s²" : "deg/s",
        imuFormatVersion: session.version,
        frequencyMode:
          sample.sensor === "accelerometer" ? session.accelFreqMode : session.gyroFreqMode,
      },
    };
  });
}

export function createIngestZosImuRouter(deps: {
  db: Pick<Database, "execute">;
  metricStreamPublisher?: MetricStreamEventPublisher;
}): Router {
  const router = Router();
  async function authenticate(req: Request, res: Response): Promise<string | null> {
    const authorization = req.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!token) {
      res.status(401).json({ error: "Dofek connection is required." });
      return null;
    }

    try {
      const validatedUserId = await validateCompanionToken(deps.db, token);
      if (!validatedUserId) {
        res.status(401).json({ error: "Invalid or revoked Dofek connection." });
        return null;
      }
      return validatedUserId;
    } catch (error) {
      captureException(error);
      res.status(500).json({ error: "Failed to validate Dofek connection." });
      return null;
    }
  }

  router.get("/zos-imu/connection", async (req, res) => {
    const userId = await authenticate(req, res);
    if (userId === null) return;
    res.status(200).json({ accountId: userId });
  });

  router.post("/zos-imu", express.json({ limit: "100kb" }), async (req, res) => {
    const userId = await authenticate(req, res);
    if (userId === null) return;

    const parsed = payloadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error:
          "Invalid IMU payload. Include the bound accountId, at most 16384 bytes, and a nonnegative integer sampleOffset.",
      });
      return;
    }
    if (parsed.data.accountId !== userId) {
      res.status(409).json({
        error:
          "This IMU recording belongs to a different Dofek account. Reconnect the account used when its upload started.",
      });
      return;
    }
    let rows: MetricStreamRowInput[];
    try {
      rows = decodeRows(parsed.data.data, parsed.data.sampleOffset, userId);
    } catch (error) {
      res
        .status(400)
        .json({ error: error instanceof Error ? error.message : "Invalid IMU binary data." });
      return;
    }

    try {
      await ensureProvider(deps.db, "amazfit-zepp", "Amazfit / Zepp", undefined, userId);
      const publisher =
        deps.metricStreamPublisher ?? (await getDefaultMetricStreamEventPublisher());
      await writeMetricStreamRows({ database: deps.db, publisher, rows });
      res.status(200).json({ status: "ok" });
    } catch (error) {
      captureException(error);
      res.status(500).json({ error: "Failed to store IMU samples. Retry this batch." });
    }
  });
  return router;
}
