import type { Database } from "dofek/db";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WriteMetricStreamRowsOptions } from "../../../../src/metric-stream/write-metric-stream.ts";
import { getJsonInProcess, postJsonInProcess } from "./test-helpers.ts";

const mocks = vi.hoisted(() => ({
  validateToken: vi.fn(),
  ensureProvider: vi.fn(),
  captureException: vi.fn(),
  write: vi.fn<(options: WriteMetricStreamRowsOptions) => Promise<unknown>>(),
  defaultPublisher: vi.fn(),
}));
vi.mock("../companion/token-repository.ts", () => ({
  validateCompanionToken: mocks.validateToken,
}));
vi.mock("dofek/db/tokens", () => ({ ensureProvider: mocks.ensureProvider }));
vi.mock("dofek/lib/error-reporting", () => ({ captureException: mocks.captureException }));
vi.mock("../../../../src/metric-stream/write-metric-stream.ts", () => ({
  writeMetricStreamRows: mocks.write,
}));
vi.mock("../../../../src/metric-stream/redpanda-producer.ts", () => ({
  getDefaultMetricStreamEventPublisher: mocks.defaultPublisher,
}));

import { createIngestZosImuRouter } from "./ingest-zos-imu.ts";

const userId = "00000000-0000-0000-0000-000000000001";
const sessionStartMs = 1_700_000_000_000;
const publisher = { publishRows: vi.fn() };
const db = { execute: vi.fn() } satisfies Pick<Database, "execute">;

function binary(options: { version?: number; start?: number; value?: number } = {}): number[] {
  const version = options.version ?? 2;
  const count = version === 1 ? 1 : 3;
  const recordSize = version === 1 ? 28 : 20;
  const data = new Uint8Array(36 + count * recordSize);
  const view = new DataView(data.buffer);
  const start = options.start ?? sessionStartMs;
  view.setUint32(0, 0x314d5549, true);
  view.setUint8(4, version);
  view.setUint8(5, 1);
  view.setUint32(8, start % 0x100000000, true);
  view.setUint32(12, Math.floor(start / 0x100000000), true);
  view.setUint32(16, count, true);
  view.setUint8(20, 1);
  view.setUint8(21, 2);
  view.setUint16(32, count, true);
  for (let i = 0; i < count; i++) {
    const offset = 36 + i * recordSize;
    view.setUint32(offset, 42, true);
    if (version === 2) view.setUint32(offset + 4, i === 1 ? 1 : 0, true);
    const valuesOffset = offset + (version === 2 ? 8 : 4);
    for (let axis = 0; axis < (version === 1 ? 6 : 3); axis++) {
      view.setFloat32(valuesOffset + axis * 4, options.value ?? axis + 1, true);
    }
  }
  return Array.from(data);
}

function post(
  body: unknown = { accountId: userId, data: binary(), sampleOffset: 128 },
  token: string | null = "valid",
) {
  const app = express();
  app.use("/api/ingest", createIngestZosImuRouter({ db, metricStreamPublisher: publisher }));
  return postJsonInProcess(
    app,
    "/api/ingest/zos-imu",
    body,
    token === null ? {} : { authorization: `Bearer ${token}` },
  );
}

describe("Zepp IMU ingestion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateToken.mockResolvedValue(userId);
    mocks.write.mockReset().mockResolvedValue({ published: 3 });
    mocks.ensureProvider.mockReset().mockResolvedValue("amazfit-zepp");
  });

  async function connection(token: string | null = "valid") {
    const app = express();
    app.use("/api/ingest", createIngestZosImuRouter({ db, metricStreamPublisher: publisher }));
    return getJsonInProcess(
      app,
      "/api/ingest/zos-imu/connection",
      token === null ? {} : { authorization: `Bearer ${token}` },
    );
  }

  it("returns the authenticated account binding without publishing samples", async () => {
    expect(await connection()).toEqual({ status: 200, body: { accountId: userId } });
    expect(mocks.validateToken).toHaveBeenCalledWith(db, "valid");
    expect(mocks.ensureProvider).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("requires a valid companion token to obtain an account binding", async () => {
    expect((await connection(null)).status).toBe(401);
    expect(mocks.validateToken).not.toHaveBeenCalled();
    mocks.validateToken.mockResolvedValue(null);
    expect((await connection("revoked")).status).toBe(401);
  });

  it("reports binding lookup failures", async () => {
    const error = new Error("connection lookup unavailable");
    mocks.validateToken.mockRejectedValue(error);
    expect((await connection()).status).toBe(500);
    expect(mocks.captureException).toHaveBeenCalledWith(error);
  });

  it("rejects a batch when its persisted binding no longer matches the token owner", async () => {
    mocks.validateToken.mockResolvedValue("00000000-0000-0000-0000-000000000002");
    const response = await post();
    expect(response.status).toBe(409);
    expect(mocks.ensureProvider).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("accepts a rotated token for the same bound account", async () => {
    await post();
    expect((await post(undefined, "rotated-token")).status).toBe(200);
    expect(mocks.validateToken).toHaveBeenLastCalledWith(db, "rotated-token");
    expect(mocks.write.mock.calls[0]?.[0].rows).toEqual(mocks.write.mock.calls[1]?.[0].rows);
  });

  it("rejects a batch without an account binding", async () => {
    expect((await post({ data: binary(), sampleOffset: 0 })).status).toBe(400);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("rejects missing and revoked companion tokens before writing", async () => {
    expect((await post({}, null)).status).toBe(401);
    expect(mocks.validateToken).not.toHaveBeenCalled();
    mocks.validateToken.mockResolvedValue(null);
    expect((await post({}, "revoked")).status).toBe(401);
    expect(mocks.ensureProvider).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("stores raw vectors only for the authenticated user and preserves same-millisecond records", async () => {
    const response = await post();
    expect(response).toEqual({ status: 200, body: { status: "ok" } });
    expect(mocks.ensureProvider).toHaveBeenCalledWith(
      db,
      "amazfit-zepp",
      "Amazfit / Zepp",
      undefined,
      userId,
    );
    const rows = mocks.write.mock.calls[0]?.[0].rows;
    expect(rows).toHaveLength(3);
    expect(rows).toEqual([
      expect.objectContaining({
        userId,
        providerId: "amazfit-zepp",
        channel: "accelerometer",
        vector: [1, 2, 3],
        metadata: { units: "cm/s²", imuFormatVersion: 2, frequencyMode: 1 },
      }),
      expect.objectContaining({
        userId,
        channel: "gyroscope",
        vector: [1, 2, 3],
        metadata: { units: "deg/s", imuFormatVersion: 2, frequencyMode: 2 },
      }),
      expect.objectContaining({ userId, channel: "accelerometer", vector: [1, 2, 3] }),
    ]);
    expect(new Set(rows?.map((row) => row.externalId)).size).toBe(3);
    expect(rows?.map((row) => new Date(row.recordedAt).getTime())).toEqual(
      Array(3).fill(sessionStartMs + 42),
    );
    expect(mocks.write.mock.calls[0]?.[0].publisher).toBe(publisher);
  });

  it("rejects client-supplied account identity", async () => {
    expect(
      (await post({ accountId: userId, data: binary(), sampleOffset: 0, userId: "someone-else" }))
        .status,
    ).toBe(400);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("isolates identical watch batches by the companion token owner", async () => {
    const otherUser = "00000000-0000-0000-0000-000000000002";
    await post();
    mocks.validateToken.mockResolvedValueOnce(otherUser);
    await post({ accountId: otherUser, data: binary(), sampleOffset: 128 }, "other-user-token");
    expect(mocks.validateToken).toHaveBeenLastCalledWith(db, "other-user-token");
    expect(mocks.write.mock.calls[0]?.[0].rows.every((row) => row.userId === userId)).toBe(true);
    expect(mocks.write.mock.calls[1]?.[0].rows.every((row) => row.userId === otherUser)).toBe(true);
  });

  it("uses the default durable publisher when no publisher is injected", async () => {
    mocks.defaultPublisher.mockResolvedValue(publisher);
    const app = express();
    app.use("/api/ingest", createIngestZosImuRouter({ db }));
    expect(
      (
        await postJsonInProcess(
          app,
          "/api/ingest/zos-imu",
          { accountId: userId, data: binary(), sampleOffset: 0 },
          { authorization: "Bearer valid" },
        )
      ).status,
    ).toBe(200);
    expect(mocks.defaultPublisher).toHaveBeenCalledOnce();
    expect(mocks.write.mock.calls[0]?.[0].publisher).toBe(publisher);
  });

  it("keeps retry identities stable and distinguishes the next offset", async () => {
    await post();
    await post();
    await post({ accountId: userId, data: binary(), sampleOffset: 131 });
    const ids = mocks.write.mock.calls.map((call) => call[0].rows.map((row) => row.externalId));
    expect(ids[0]).toEqual(ids[1]);
    expect(ids[2]).not.toEqual(ids[0]);
  });

  it("uses the same original record offset for both sensors in a legacy paired record", async () => {
    expect(
      (await post({ accountId: userId, data: binary({ version: 1 }), sampleOffset: 7 })).status,
    ).toBe(200);
    const rows = mocks.write.mock.calls[0]?.[0].rows;
    expect(rows?.map((row) => row.externalId)).toEqual([
      `zos-imu:${sessionStartMs}:7:accelerometer`,
      `zos-imu:${sessionStartMs}:7:gyroscope`,
    ]);
    expect(rows?.[1]?.vector).toEqual([4, 5, 6]);
  });

  it.each([
    { accountId: userId, data: [], sampleOffset: 0 },
    { accountId: userId, data: [256], sampleOffset: 0 },
    { accountId: userId, data: [1.5], sampleOffset: 0 },
    { accountId: userId, data: Array(16385).fill(0), sampleOffset: 0 },
    { accountId: userId, data: binary(), sampleOffset: -1 },
    { accountId: userId, data: binary(), sampleOffset: 0.5 },
    { accountId: userId, data: binary(), sampleOffset: Number.MAX_SAFE_INTEGER },
    { accountId: userId, data: binary().slice(0, -1), sampleOffset: 0 },
    { accountId: userId, data: binary({ value: Number.NaN }), sampleOffset: 0 },
    { accountId: userId, data: binary({ value: Number.POSITIVE_INFINITY }), sampleOffset: 0 },
    { accountId: userId, data: binary({ start: 8_640_000_000_000_000 }), sampleOffset: 0 },
  ])("rejects malformed, oversized, or nonfinite IMU input %#", async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.ensureProvider).not.toHaveBeenCalled();
  });

  it("does not acknowledge until publishing resolves", async () => {
    const publishing = Promise.withResolvers<unknown>();
    const entered = Promise.withResolvers<void>();
    mocks.write.mockImplementation(() => {
      entered.resolve();
      return publishing.promise;
    });
    let acknowledged = false;
    const request = post().then((response) => {
      acknowledged = true;
      return response;
    });
    await entered.promise;
    expect(acknowledged).toBe(false);
    publishing.resolve({ published: 3 });
    expect((await request).status).toBe(200);
  });

  it("reports publisher failures and leaves the batch unacknowledged", async () => {
    const error = new Error("publish unavailable");
    mocks.write.mockRejectedValueOnce(error);
    expect(await post()).toEqual({
      status: 500,
      body: { error: "Failed to store IMU samples. Retry this batch." },
    });
    expect(mocks.captureException).toHaveBeenCalledWith(error);
    expect((await post()).status).toBe(200);
    expect(mocks.write.mock.calls[0]?.[0].rows).toEqual(mocks.write.mock.calls[1]?.[0].rows);
  });

  it("reports token repository failures", async () => {
    const error = new Error("token repository unavailable");
    mocks.validateToken.mockRejectedValue(error);
    expect((await post()).status).toBe(500);
    expect(mocks.captureException).toHaveBeenCalledWith(error);
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
