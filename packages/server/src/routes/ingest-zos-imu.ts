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
import { validateCompanionToken } from "../companion/token-repository.ts";

const envelopeSchema = z.strictObject({
  accountId: z.guid(),
  version: z.literal(1),
  batchId: z.string().trim().min(1),
  source: z.object({
    connectionType: z.enum(["zepp", "zepp-workout"]),
    installId: z.string().trim().min(1),
  }),
  events: z
    .array(
      z.object({
        eventId: z.string().trim().min(1),
        createdAt: z.iso.datetime({ offset: true }),
        payload: z.unknown(),
      }),
    )
    .min(1)
    .max(500),
});
const sampleSchema = z.strictObject({
  tMs: z.number().int().nonnegative(),
  sensor: z.enum(["accelerometer", "gyroscope"]),
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});
const sharedPayloadFields = {
  segmentId: z.string().trim().min(1),
  sessionStartMs: z.number().int().nonnegative(),
  hasGyroscope: z.boolean(),
};
const payloadSchema = z
  .discriminatedUnion("formatVersion", [
    z.strictObject({
      ...sharedPayloadFields,
      formatVersion: z.literal(1),
      samples: z.array(sampleSchema).min(1).max(200),
    }),
    z.strictObject({
      ...sharedPayloadFields,
      formatVersion: z.literal(2),
      sampleOffset: z.number().int().nonnegative(),
      accelFreqMode: z.number().int().min(0).max(255),
      gyroFreqMode: z.number().int().min(0).max(255),
      samples: z.array(sampleSchema).min(1).max(128),
    }),
  ])
  .superRefine((payload, context) => {
    if (
      payload.formatVersion === 2 &&
      !Number.isSafeInteger(payload.sampleOffset + payload.samples.length - 1)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sampleOffset"],
        message: "IMU sample offsets must be safe integers.",
      });
    }
    for (const [index, sample] of payload.samples.entries()) {
      if (sample.sensor === "gyroscope" && !payload.hasGyroscope) {
        context.addIssue({
          code: "custom",
          path: ["samples", index, "sensor"],
          message: "Gyroscope sample requires hasGyroscope.",
        });
      }
      const timestamp = payload.sessionStartMs + sample.tMs;
      if (!Number.isSafeInteger(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) {
        context.addIssue({
          code: "custom",
          path: ["samples", index, "tMs"],
          message: "IMU sample timestamp is outside the supported range.",
        });
      }
    }
  });

function sampleRows(
  payload: z.infer<typeof payloadSchema>,
  eventId: string,
  source: z.infer<typeof envelopeSchema>["source"],
  userId: string,
): MetricStreamRowInput[] {
  return payload.samples.map((sample, index) => ({
    recordedAt: new Date(payload.sessionStartMs + sample.tMs),
    userId,
    providerId: "amazfit-zepp",
    externalId: `amazfit-zepp:${source.installId}:${eventId}:${index}:${sample.sensor}`,
    deviceId: `${source.connectionType}:${source.installId}`,
    sourceType: SOURCE_TYPE_API,
    channel: sample.sensor,
    vector: [sample.x, sample.y, sample.z],
    // https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/Accelerometer/
    // https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/Gyroscope/
    metadata: {
      units: sample.sensor === "accelerometer" ? "cm/s²" : "deg/s",
      imuFormatVersion: payload.formatVersion,
      ...(payload.formatVersion === 2
        ? {
            frequencyMode:
              sample.sensor === "accelerometer" ? payload.accelFreqMode : payload.gyroFreqMode,
          }
        : {}),
    },
  }));
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
      const userId = await validateCompanionToken(deps.db, token);
      if (!userId) {
        res.status(401).json({ error: "Invalid or revoked Dofek connection." });
        return null;
      }
      return userId;
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
    const envelope = envelopeSchema.safeParse(req.body);
    if (!envelope.success) {
      res.status(400).json({
        error: "Invalid IMU envelope. Include the bound accountId and versioned events.",
        details: envelope.error.flatten(),
      });
      return;
    }
    if (envelope.data.accountId !== userId) {
      res.status(409).json({
        error:
          "This IMU recording belongs to a different Dofek account. Reconnect the account used when its upload started.",
      });
      return;
    }
    const acceptedEventIds: string[] = [];
    const rejected: Array<{ eventId: string; issues: Array<{ path: string; message: string }> }> =
      [];
    const rows: MetricStreamRowInput[] = [];
    for (const event of envelope.data.events) {
      const payload = payloadSchema.safeParse(event.payload);
      if (!payload.success) {
        rejected.push({
          eventId: event.eventId,
          issues: payload.error.issues.map((issue) => ({
            path: issue.path.length ? issue.path.join(".") : "$",
            message: issue.message,
          })),
        });
      } else {
        acceptedEventIds.push(event.eventId);
        rows.push(...sampleRows(payload.data, event.eventId, envelope.data.source, userId));
      }
    }
    if (acceptedEventIds.length === 0) {
      res.status(200).json({ status: "ok", acceptedEventIds, rejected });
      return;
    }
    try {
      await ensureProvider(deps.db, "amazfit-zepp", "Amazfit / Zepp", undefined, userId);
      const publisher =
        deps.metricStreamPublisher ?? (await getDefaultMetricStreamEventPublisher());
      await writeMetricStreamRows({ database: deps.db, publisher, rows });
      res.status(200).json({ status: "ok", acceptedEventIds, rejected });
    } catch (error) {
      captureException(error);
      res.status(500).json({ error: "Failed to store IMU samples. Retry this batch." });
    }
  });
  return router;
}
