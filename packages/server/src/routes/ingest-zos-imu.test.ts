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
const samples = [
  { tMs: 42, sensor: "accelerometer", x: 1, y: 2, z: 3 },
  { tMs: 42, sensor: "gyroscope", x: 4, y: 5, z: 6 },
  { tMs: 42, sensor: "accelerometer", x: 7, y: 8, z: 9 },
];
function payload(overrides: Record<string, unknown> = {}) {
  return {
    formatVersion: 2,
    segmentId: "segment",
    sessionStartMs,
    hasGyroscope: true,
    sampleOffset: 128,
    accelFreqMode: 1,
    gyroFreqMode: 2,
    samples,
    ...overrides,
  };
}
function event(data: unknown = payload(), eventId = "segment:128") {
  return { eventId, createdAt: "2023-11-14T22:13:20.042Z", payload: data };
}
function envelope(events = [event()], overrides: Record<string, unknown> = {}) {
  return {
    accountId: userId,
    version: 1,
    batchId: "batch",
    source: { connectionType: "zepp", installId: "install-1" },
    events,
    ...overrides,
  };
}
function app(injectPublisher = true) {
  const instance = express();
  instance.use(
    "/api/ingest",
    createIngestZosImuRouter({
      db,
      ...(injectPublisher ? { metricStreamPublisher: publisher } : {}),
    }),
  );
  return instance;
}
function post(body: unknown = envelope(), token: string | null = "valid") {
  return postJsonInProcess(
    app(),
    "/api/ingest/zos-imu",
    body,
    token === null ? {} : { authorization: `Bearer ${token}` },
  );
}
function connection(token: string | null = "valid") {
  return getJsonInProcess(
    app(),
    "/api/ingest/zos-imu/connection",
    token === null ? {} : { authorization: `Bearer ${token}` },
  );
}

describe("Zepp IMU envelope ingestion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateToken.mockResolvedValue(userId);
    mocks.write.mockReset().mockResolvedValue({ published: 3 });
    mocks.ensureProvider.mockReset().mockResolvedValue("amazfit-zepp");
  });
  it("returns an authenticated account binding without writes", async () => {
    expect(await connection()).toEqual({ status: 200, body: { accountId: userId } });
    expect(mocks.validateToken).toHaveBeenCalledWith(db, "valid");
    expect(mocks.ensureProvider).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("rate limits repeated authenticated requests before another token lookup", async () => {
    const instance = app();
    for (let index = 0; index < 600; index += 1) {
      expect(
        (
          await getJsonInProcess(instance, "/api/ingest/zos-imu/connection", {
            authorization: "Bearer valid",
          })
        ).status,
      ).toBe(200);
    }

    expect(
      await getJsonInProcess(instance, "/api/ingest/zos-imu/connection", {
        authorization: "Bearer valid",
      }),
    ).toMatchObject({
      status: 429,
      body: { error: "Too many Zepp IMU requests. Retry later." },
    });
    expect(mocks.validateToken).toHaveBeenCalledTimes(600);
  });
  it("rejects missing and revoked companion tokens for binding and ingest", async () => {
    expect((await connection(null)).status).toBe(401);
    expect((await post({}, null)).status).toBe(401);
    expect(mocks.validateToken).not.toHaveBeenCalled();
    mocks.validateToken.mockResolvedValue(null);
    expect((await connection("revoked")).status).toBe(401);
    expect((await post({}, "revoked")).status).toBe(401);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("reports authentication lookup failures", async () => {
    const error = new Error("connection lookup unavailable");
    mocks.validateToken.mockRejectedValue(error);
    expect((await connection()).status).toBe(500);
    expect((await post()).status).toBe(500);
    expect(mocks.captureException).toHaveBeenCalledWith(error);
  });
  it("rejects an account change before publication", async () => {
    mocks.validateToken.mockResolvedValue("00000000-0000-0000-0000-000000000002");
    expect((await post()).status).toBe(409);
    expect(mocks.ensureProvider).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("accepts rotated tokens for the bound account with stable identities", async () => {
    expect((await post()).status).toBe(200);
    expect((await post(undefined, "rotated")).status).toBe(200);
    expect(mocks.validateToken).toHaveBeenLastCalledWith(db, "rotated");
    expect(mocks.write.mock.calls[0]?.[0].rows).toEqual(mocks.write.mock.calls[1]?.[0].rows);
  });
  it.each([
    {},
    envelope([], {}),
    envelope(undefined, { accountId: undefined }),
    envelope(undefined, { userId: "other-user" }),
    envelope(undefined, { version: 2 }),
  ])("rejects invalid envelope %#", async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("preserves tagged raw vectors, units, modes, and same-millisecond record identities", async () => {
    expect(await post()).toEqual({
      status: 200,
      body: { status: "ok", acceptedEventIds: ["segment:128"], rejected: [] },
    });
    expect(mocks.ensureProvider).toHaveBeenCalledWith(
      db,
      "amazfit-zepp",
      "Amazfit / Zepp",
      undefined,
      userId,
    );
    const rows = mocks.write.mock.calls[0]?.[0].rows;
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      samples.map((sample, index) =>
        expect.objectContaining({
          userId,
          providerId: "amazfit-zepp",
          deviceId: "zepp:install-1",
          channel: sample.sensor,
          externalId: `amazfit-zepp:install-1:segment:128:${index}:${sample.sensor}`,
          vector: [sample.x, sample.y, sample.z],
          metadata: {
            units: sample.sensor === "accelerometer" ? "cm/s²" : "deg/s",
            imuFormatVersion: 2,
            frequencyMode: sample.sensor === "accelerometer" ? 1 : 2,
          },
        }),
      ),
    );
    expect(new Set(rows?.map((row) => row.externalId)).size).toBe(3);
    expect(rows?.map((row) => new Date(row.recordedAt).getTime())).toEqual(
      Array(3).fill(sessionStartMs + 42),
    );
  });
  it("isolates identical chunks from different watch installations", async () => {
    await post();
    await post(
      envelope(undefined, { source: { connectionType: "zepp-workout", installId: "install-2" } }),
    );
    expect(mocks.write.mock.calls[0]?.[0].rows[0]?.externalId).not.toBe(
      mocks.write.mock.calls[1]?.[0].rows[0]?.externalId,
    );
    expect(mocks.write.mock.calls[1]?.[0].rows[0]?.deviceId).toBe("zepp-workout:install-2");
  });
  it("preserves migrated legacy tags without inventing frequency metadata", async () => {
    const legacy = {
      formatVersion: 1,
      segmentId: "old",
      sessionStartMs,
      hasGyroscope: true,
      samples,
    };
    expect((await post(envelope([event(legacy, "old-event")]))).body).toEqual({
      status: "ok",
      acceptedEventIds: ["old-event"],
      rejected: [],
    });
    const rows = mocks.write.mock.calls[0]?.[0].rows;
    expect(rows?.map((row) => row.metadata)).toEqual([
      { units: "cm/s²", imuFormatVersion: 1 },
      { units: "deg/s", imuFormatVersion: 1 },
      { units: "cm/s²", imuFormatVersion: 1 },
    ]);
  });
  it("publishes valid siblings and reports invalid events individually", async () => {
    const response = await post(envelope([event(), event(payload({ samples: [] }), "bad")]));
    expect(response).toMatchObject({
      status: 200,
      body: {
        status: "ok",
        acceptedEventIds: ["segment:128"],
        rejected: [{ eventId: "bad", issues: [{ path: "samples" }] }],
      },
    });
    expect(mocks.write.mock.calls[0]?.[0].rows).toHaveLength(3);
  });
  it.each([
    { samples: [] },
    { samples: Array(129).fill(samples[0]) },
    { hasGyroscope: false },
    { accelFreqMode: undefined },
    { gyroFreqMode: 256 },
    { sampleOffset: -1 },
    { sampleOffset: Number.MAX_SAFE_INTEGER },
    { formatVersion: 3 },
    { sessionStartMs: 8_640_000_000_000_000 },
    { samples: [{ ...samples[0], x: Number.NaN }] },
    { samples: [{ ...samples[0], tMs: -1 }] },
    { samples: [{ ...samples[0], sensor: "unknown" }] },
  ])("rejects invalid tagged payload %# without writing", async (overrides) => {
    const response = await post(envelope([event(payload(overrides))]));
    expect(response).toMatchObject({
      status: 200,
      body: {
        acceptedEventIds: [],
        rejected: [{ eventId: "segment:128", issues: expect.any(Array) }],
      },
    });
    expect(mocks.ensureProvider).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("accepts up to 200 migrated legacy vectors", async () => {
    const legacy = {
      formatVersion: 1,
      segmentId: "old",
      sessionStartMs,
      hasGyroscope: false,
      samples: Array(200).fill(samples[0]),
    };
    expect((await post(envelope([event(legacy)]))).body).toMatchObject({
      acceptedEventIds: ["segment:128"],
    });
    expect(mocks.write.mock.calls[0]?.[0].rows).toHaveLength(200);
  });
  it("does not acknowledge before publication resolves", async () => {
    const publishing = Promise.withResolvers<unknown>();
    const entered = Promise.withResolvers<void>();
    mocks.write.mockImplementation(() => {
      entered.resolve();
      return publishing.promise;
    });
    let acknowledged = false;
    const pending = post().then((response) => {
      acknowledged = true;
      return response;
    });
    await entered.promise;
    expect(acknowledged).toBe(false);
    publishing.resolve({ published: 3 });
    expect((await pending).body).toMatchObject({ acceptedEventIds: ["segment:128"] });
  });
  it("reports publication failure and leaves all events unacknowledged", async () => {
    const error = new Error("publisher unavailable");
    mocks.write.mockRejectedValueOnce(error);
    expect(await post()).toEqual({
      status: 500,
      body: { error: "Failed to store IMU samples. Retry this batch." },
    });
    expect(mocks.captureException).toHaveBeenCalledWith(error);
    expect((await post()).status).toBe(200);
    expect(mocks.write.mock.calls[0]?.[0].rows).toEqual(mocks.write.mock.calls[1]?.[0].rows);
  });
  it("uses the default durable publisher", async () => {
    mocks.defaultPublisher.mockResolvedValue(publisher);
    expect(
      (
        await postJsonInProcess(app(false), "/api/ingest/zos-imu", envelope(), {
          authorization: "Bearer valid",
        })
      ).status,
    ).toBe(200);
    expect(mocks.write.mock.calls[0]?.[0].publisher).toBe(publisher);
  });
});
