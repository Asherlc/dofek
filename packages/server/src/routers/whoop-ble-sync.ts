import {
  WHOOP_SENSOR_BATCH_BYTES,
  whoopSensorRecordSchema,
  whoopSensorSnapshotSchema,
} from "@dofek/providers/whoop-sensors";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  SensorUploadTelemetry,
  sensorUploadTelemetrySchema,
} from "../lib/sensor-upload-telemetry.ts";
import { logger } from "../logger.ts";
import { WhoopBleSyncRepository } from "../repositories/whoop-ble-sync-repository.ts";
import { WhoopSensorRepository } from "../repositories/whoop-sensor-repository.ts";
import { decodeWhoopSensorRecord } from "../services/whoop-sensor-decoder.ts";
import { protectedProcedure, router } from "../trpc.ts";
import { filterFutureSamples } from "./sample-validation.ts";

const validatedSensorRecord = whoopSensorRecordSchema.superRefine((record, context) => {
  try {
    decodeWhoopSensorRecord(record);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid WHOOP sensor record",
    });
  }
});
const sensorRecordsInput = z
  .object({
    deviceId: z.string().min(1).max(200),
    samples: z.array(validatedSensorRecord).max(16),
    telemetry: sensorUploadTelemetrySchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (Buffer.byteLength(JSON.stringify(input)) > WHOOP_SENSOR_BATCH_BYTES) {
      context.addIssue({
        code: "custom",
        message: "WHOOP sensor upload exceeds 262144 bytes; reduce the batch size",
      });
    }
  });

// ── Zod schemas ──

const realtimeDataSampleSchema = z.object({
  timestamp: z.string(), // ISO 8601 with millisecond precision
  /** Independently reported by the strap; 0 when unavailable. */
  heartRateBpm: z.number().int().min(0).max(255).default(0),
  /** R-R interval in milliseconds (beat-to-beat timing from PPG). 0 when unavailable. */
  rrIntervalMs: z.number().int().min(0).max(32767).default(0),
  quaternionW: z.number(),
  quaternionX: z.number(),
  quaternionY: z.number(),
  quaternionZ: z.number(),
  /** Raw optical/PPG bytes from payload offsets 23-40, hex-encoded (36 chars = 18 bytes) */
  opticalRawHex: z
    .string()
    .regex(/^[0-9a-f]{36}$/)
    .default("0".repeat(36)),
});

const pushRealtimeDataInput = z.object({
  deviceId: z.string().min(1),
  samples: z.array(realtimeDataSampleSchema),
  telemetry: sensorUploadTelemetrySchema.optional(),
});

// ── Router ──

export const whoopBleSyncRouter = router({
  sensorSnapshot: protectedProcedure
    .output(whoopSensorSnapshotSchema)
    .query(({ ctx }) => new WhoopSensorRepository(ctx.sensorStore, ctx.userId).snapshot()),
  pushSensorRecords: protectedProcedure
    .input(sensorRecordsInput)
    .output(z.object({ inserted: z.number().int().nonnegative() }))
    .mutation(async ({ ctx, input }) => {
      if (input.samples.some((sample) => Date.parse(sample.timestamp) > Date.now() + 5 * 60_000)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "WHOOP packet reception time is in the future; check your phone's clock",
        });
      }
      const telemetry = new SensorUploadTelemetry({
        stream: "sensorRecords",
        userId: ctx.userId,
        deviceId: input.deviceId,
        appVersion: ctx.appVersion,
        assetsVersion: ctx.assetsVersion,
        telemetry: input.telemetry,
        inputSamples: input.samples,
        acceptedSamples: input.samples,
      });
      try {
        const repository = new WhoopBleSyncRepository(
          ctx.db,
          ctx.userId,
          ctx.metricStreamPublisher,
        );
        await repository.ensureProvider();
        const inserted = await repository.insertSensorRecords(input.deviceId, input.samples);
        telemetry.published(inserted);
        return { inserted };
      } catch (error) {
        telemetry.failed(error);
        throw error;
      }
    }),
  pushRealtimeData: protectedProcedure
    .input(pushRealtimeDataInput)
    .mutation(async ({ ctx, input }) => {
      const repository = new WhoopBleSyncRepository(ctx.db, ctx.userId, ctx.metricStreamPublisher);
      const now = new Date();
      const validSamples = filterFutureSamples(input.samples, now, "WHOOP BLE");
      const telemetry = new SensorUploadTelemetry({
        stream: "realtime",
        userId: ctx.userId,
        deviceId: input.deviceId,
        appVersion: ctx.appVersion,
        assetsVersion: ctx.assetsVersion,
        telemetry: input.telemetry,
        inputSamples: input.samples,
        acceptedSamples: validSamples,
      });

      try {
        if (input.samples.length === 0) {
          await repository.ensureProvider();
          logger.info("WHOOP BLE realtime push with 0 samples", { userId: ctx.userId });
          telemetry.published(0);
          return { inserted: 0 };
        }

        await repository.ensureProvider();

        const { firstTimestamp, lastTimestamp } = telemetry;

        const inserted = await repository.insertRealtimeDataBatch(input.deviceId, validSamples);
        telemetry.published(inserted);

        logger.info("WHOOP BLE realtime data pushed", {
          userId: ctx.userId,
          deviceId: input.deviceId,
          sampleCount: inserted,
          filteredCount: input.samples.length - validSamples.length,
          firstTimestamp,
          lastTimestamp,
          serverTime: now.toISOString(),
        });

        return { inserted };
      } catch (error) {
        telemetry.failed(error);
        throw error;
      }
    }),
});
