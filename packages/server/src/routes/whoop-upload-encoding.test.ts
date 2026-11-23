import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { WHOOP_SENSOR_BATCH_BYTES } from "@dofek/providers/whoop-sensors";
import { TRPCError } from "@trpc/server";
import express from "express";
import { describe, expect, it } from "vitest";
import { mountTrpcWithWhoopEncoding, whoopUploadResponseMeta } from "./whoop-upload-encoding.ts";

const uploadProcedures = [
  "inertialMeasurementUnitSync.pushSamples",
  "whoopBleSync.pushRealtimeData",
  "whoopBleSync.pushSensorRecords",
];
const uploadProcedure = "whoopBleSync.pushRealtimeData";
const sample = { deviceId: "unit-test", samples: [] };
const plain = JSON.stringify(sample);
const compressed = Uint8Array.from(gzipSync(plain));

async function post(
  procedure: string,
  body: string | Uint8Array<ArrayBuffer>,
  headers: Record<string, string> = {},
) {
  const app = express();
  const downstream = express.Router();
  downstream.post(/.*/, (req, res) => {
    res.json("body" in req ? { parsed: true, body: req.body } : { parsed: false });
  });
  mountTrpcWithWhoopEncoding(app, downstream);
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a loopback port");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/trpc/${procedure}`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", ...headers },
      signal: AbortSignal.timeout(5_000),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("mountTrpcWithWhoopEncoding", () => {
  it.each(uploadProcedures)("decodes gzip submitted to %s", async (procedure) => {
    const result = await post(procedure, compressed, { "content-encoding": "GZIP" });
    expect(result).toEqual({ status: 200, body: { parsed: true, body: sample } });
  });

  it("leaves ordinary JSON and unrelated procedures for the downstream handler", async () => {
    await expect(post(uploadProcedure, plain)).resolves.toEqual({
      status: 200,
      body: { parsed: false },
    });
    await expect(
      post("sync.providers", compressed, { "content-encoding": "gzip" }),
    ).resolves.toEqual({
      status: 200,
      body: { parsed: false },
    });
  });

  it("accepts the exact decoded byte limit and rejects one extra byte", async () => {
    const padding = "x".repeat(WHOOP_SENSOR_BATCH_BYTES - JSON.stringify({ data: "" }).length);
    const encode = (data: string) => Uint8Array.from(gzipSync(JSON.stringify({ data })));
    const headers = { "content-encoding": "gzip" };
    await expect(post(uploadProcedure, encode(padding), headers)).resolves.toEqual({
      status: 200,
      body: { parsed: true, body: { data: padding } },
    });
    await expect(post(uploadProcedure, encode(`${padding}x`), headers)).resolves.toEqual({
      status: 413,
      body: { error: "Compressed sensor upload exceeds 262144 bytes when decoded" },
    });
  });

  it("returns JSON errors for malformed gzip and an unsupported charset", async () => {
    await expect(post(uploadProcedure, plain, { "content-encoding": "gzip" })).resolves.toEqual({
      status: 400,
      body: { error: "Invalid compressed sensor upload" },
    });
    await expect(
      post(uploadProcedure, compressed, {
        "content-encoding": "gzip",
        "content-type": "application/json; charset=iso-8859-1",
      }),
    ).resolves.toEqual({
      status: 415,
      body: { error: "Invalid compressed sensor upload" },
    });
  });
});

describe("whoopUploadResponseMeta", () => {
  it.each(uploadProcedures)("advertises gzip for a successful single %s mutation", (procedure) => {
    const metadata = whoopUploadResponseMeta({ type: "mutation", paths: [procedure], errors: [] });
    expect(metadata.headers?.get("accept-encoding")).toBe("gzip");
  });

  it.each([
    { type: "query" as const, paths: [uploadProcedure], errors: [] },
    { type: "mutation" as const, paths: ["sync.providers"], errors: [] },
    { type: "mutation" as const, paths: [uploadProcedure, uploadProcedure], errors: [] },
    { type: "mutation" as const, paths: undefined, errors: [] },
    {
      type: "mutation" as const,
      paths: [uploadProcedure],
      errors: [new TRPCError({ code: "UNAUTHORIZED" })],
    },
  ])("omits the capability for $type with paths $paths and errors $errors", (metadata) => {
    expect(whoopUploadResponseMeta(metadata)).toEqual({});
  });
});
