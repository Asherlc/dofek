import { WHOOP_SENSOR_BATCH_BYTES } from "@dofek/providers/whoop-sensors";
import type { AnyRouter } from "@trpc/server";
import type { ResponseMetaFn } from "@trpc/server/http";
import { type Express, json, type RequestHandler } from "express";

const sensorUploadProcedures = [
  "inertialMeasurementUnitSync.pushSamples",
  "whoopBleSync.pushRealtimeData",
  "whoopBleSync.pushSensorRecords",
];

/** Decode gzip only on the WHOOP upload endpoints before tRPC reads the stream. */
export function mountTrpcWithWhoopEncoding(app: Express, trpcMiddleware: RequestHandler) {
  const parseCompressedSensorUpload = json({ limit: WHOOP_SENSOR_BATCH_BYTES });
  for (const procedure of sensorUploadProcedures) {
    app.post(`/api/trpc/${procedure}`, (req, res, next) => {
      if (req.get("content-encoding")?.toLowerCase() === "gzip") {
        parseCompressedSensorUpload(req, res, (error?: unknown) => {
          if (typeof error === "object" && error !== null && "status" in error) {
            if (error.status === 413) {
              res.status(413).json({
                error: `Compressed sensor upload exceeds ${WHOOP_SENSOR_BATCH_BYTES} bytes when decoded`,
              });
              return;
            }
            if (error.status === 400 || error.status === 415) {
              res.status(error.status).json({ error: "Invalid compressed sensor upload" });
              return;
            }
          }
          next(error);
        });
        return;
      }
      // tRPC reads the original request stream for ordinary JSON uploads.
      next();
    });
  }
  app.use("/api/trpc", trpcMiddleware);
}

type UploadResponseMetaOptions = Pick<
  Parameters<ResponseMetaFn<AnyRouter>>[0],
  "paths" | "type" | "errors"
>;

export function whoopUploadResponseMeta({ paths, type, errors }: UploadResponseMetaOptions) {
  if (
    type === "mutation" &&
    errors.length === 0 &&
    paths?.length === 1 &&
    sensorUploadProcedures.some((procedure) => procedure === paths[0])
  ) {
    return { headers: new Headers({ "Accept-Encoding": "gzip" }) };
  }
  return {};
}
