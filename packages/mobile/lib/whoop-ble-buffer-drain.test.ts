import { AppState } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InertialMeasurementUnitUploadClient,
  WhoopBleRealtimeUploadClient,
  WhoopBleSyncDeps,
} from "./background-whoop-ble-sync";
import { WhoopBleDiagnostics } from "./whoop-ble-diagnostics";
import {
  makeMockDeps,
  makeMockRealtimeClient,
  makeMockTrpcClient,
  makeWhoopCaptureStats,
} from "./whoop-ble-test-helpers";

vi.mock("./telemetry", () => ({
  captureException: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const { mockLoadDeviceErasureCutoff } = vi.hoisted(() => ({
  mockLoadDeviceErasureCutoff: vi.fn<() => Promise<string | null>>(),
}));
vi.mock("./device-erasure-cutoff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./device-erasure-cutoff")>()),
  loadDeviceErasureCutoff: mockLoadDeviceErasureCutoff,
}));

import { drainWhoopImuBuffer, drainWhoopRealtimeBuffer } from "./whoop-ble-buffer-drain";

let whoopDeps: WhoopBleSyncDeps;
let trpcClient: InertialMeasurementUnitUploadClient;
let realtimeClient: WhoopBleRealtimeUploadClient;
let diagnostics: WhoopBleDiagnostics;
beforeEach(() => {
  whoopDeps = makeMockDeps();
  trpcClient = makeMockTrpcClient();
  realtimeClient = makeMockRealtimeClient();
  diagnostics = new WhoopBleDiagnostics();
  diagnostics.snapshot(makeWhoopCaptureStats(), "initial", "active");
  mockLoadDeviceErasureCutoff.mockResolvedValue(null);
  AppState.currentState = "active";
});

async function drainBuffers(includeRealtime: boolean) {
  const cutoff = await mockLoadDeviceErasureCutoff();
  await Promise.all([
    drainWhoopImuBuffer(
      trpcClient,
      whoopDeps,
      cutoff,
      () => true,
      "initial",
      diagnostics,
      () => true,
    ),
    ...(includeRealtime
      ? [
          drainWhoopRealtimeBuffer(
            realtimeClient,
            whoopDeps,
            cutoff,
            () => true,
            "initial",
            diagnostics,
            () => true,
          ),
        ]
      : []),
  ]);
}
describe("WHOOP buffer upload payloads and confirmation", () => {
  it("uploads buffered samples with gyroscope data immediately on init", async () => {
    const samples = [
      {
        timestamp: "2026-03-27T10:00:00.000Z",
        x: 1,
        y: 2,
        z: 3,
        gyroscopeX: 10,
        gyroscopeY: -20,
        gyroscopeZ: 30,
      },
    ];
    vi.mocked(whoopDeps.peekBufferedSamples).mockResolvedValueOnce(samples);

    await drainBuffers(false);

    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledWith({
      telemetry: expect.objectContaining({ batchId: expect.any(String) }),
      deviceId: "WHOOP Strap",
      deviceType: "whoop",
      samples: [
        {
          timestamp: "2026-03-27T10:00:00.000Z",
          x: 1,
          y: 2,
          z: 3,
          gyroscopeX: 10,
          gyroscopeY: -20,
          gyroscopeZ: 30,
        },
      ],
    });
  });

  it("requests bounded IMU batches from the native buffer", async () => {
    await drainBuffers(false);

    expect(whoopDeps.peekBufferedSamples).toHaveBeenCalledWith(500);
  });

  it("does not upload when buffer is empty", async () => {
    await drainBuffers(false);
    await drainBuffers(false);

    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).not.toHaveBeenCalled();
  });

  it("drains buffer in multiple batches until empty", async () => {
    const batch1 = [
      {
        timestamp: "2026-03-27T10:00:00.000Z",
        x: 1,
        y: 2,
        z: 3,
        gyroscopeX: 10,
        gyroscopeY: -20,
        gyroscopeZ: 30,
      },
    ];
    const batch2 = [
      {
        timestamp: "2026-03-27T10:00:01.000Z",
        x: 4,
        y: 5,
        z: 6,
        gyroscopeX: 40,
        gyroscopeY: -50,
        gyroscopeZ: 60,
      },
    ];

    // Return batch1 on first call, batch2 on second, then empty
    vi.mocked(whoopDeps.peekBufferedSamples)
      .mockResolvedValueOnce(batch1)
      .mockResolvedValueOnce(batch2)
      .mockResolvedValueOnce([]);

    await drainBuffers(false);

    // Should have uploaded twice — once per batch
    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledTimes(2);
    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        samples: expect.arrayContaining([
          expect.objectContaining({ timestamp: "2026-03-27T10:00:00.000Z" }),
        ]),
      }),
    );
    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        samples: expect.arrayContaining([
          expect.objectContaining({ timestamp: "2026-03-27T10:00:01.000Z" }),
        ]),
      }),
    );
  });

  it("confirms drain after successful upload", async () => {
    const samples = [
      {
        timestamp: "2026-03-27T10:00:00.000Z",
        x: 1,
        y: 2,
        z: 3,
        gyroscopeX: 10,
        gyroscopeY: -20,
        gyroscopeZ: 30,
      },
    ];
    vi.mocked(whoopDeps.peekBufferedSamples).mockResolvedValueOnce(samples);

    await drainBuffers(false);

    expect(whoopDeps.confirmSamplesDrain).toHaveBeenCalledWith(1);
  });

  it("discards old-account IMU and realtime samples at the durable cutoff", async () => {
    const cutoff = "2026-03-27T10:00:00.000Z";
    mockLoadDeviceErasureCutoff.mockResolvedValue(cutoff);
    vi.mocked(whoopDeps.peekBufferedSamples).mockResolvedValueOnce([
      {
        timestamp: cutoff,
        x: 1,
        y: 2,
        z: 3,
      },
      {
        timestamp: "2026-03-27T10:00:01.000Z",
        x: 4,
        y: 5,
        z: 6,
      },
    ]);
    vi.mocked(whoopDeps.peekBufferedRealtimeData).mockResolvedValueOnce([
      {
        timestamp: cutoff,
        heartRateBpm: 67,
        rrIntervalMs: 900,
        quaternionW: 1,
        quaternionX: 0,
        quaternionY: 0,
        quaternionZ: 0,
        opticalRawHex: "old",
      },
      {
        timestamp: "2026-03-27T10:00:01.000Z",
        heartRateBpm: 75,
        rrIntervalMs: 800,
        quaternionW: 1,
        quaternionX: 0,
        quaternionY: 0,
        quaternionZ: 0,
        opticalRawHex: "new",
      },
    ]);
    realtimeClient = makeMockRealtimeClient();

    await drainBuffers(true);

    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        samples: [expect.objectContaining({ timestamp: "2026-03-27T10:00:01.000Z" })],
      }),
    );
    expect(realtimeClient.whoopBleSync.pushRealtimeData.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        samples: [expect.objectContaining({ timestamp: "2026-03-27T10:00:01.000Z" })],
      }),
    );
    expect(whoopDeps.confirmSamplesDrain).toHaveBeenCalledWith(2);
    expect(whoopDeps.confirmRealtimeDataDrain).toHaveBeenCalledWith(2);
  });

  it("groups buffered IMU samples by captured device id before upload", async () => {
    const strapA1 = {
      deviceId: "whoop-a",
      timestamp: "2026-03-27T10:00:00.000Z",
      x: 1,
      y: 2,
      z: 3,
      gyroscopeX: 10,
      gyroscopeY: -20,
      gyroscopeZ: 30,
    };
    const strapB = {
      deviceId: "whoop-b",
      timestamp: "2026-03-27T10:00:01.000Z",
      x: 4,
      y: 5,
      z: 6,
      gyroscopeX: 40,
      gyroscopeY: -50,
      gyroscopeZ: 60,
    };
    const strapA2 = {
      deviceId: "whoop-a",
      timestamp: "2026-03-27T10:00:02.000Z",
      x: 7,
      y: 8,
      z: 9,
      gyroscopeX: 70,
      gyroscopeY: -80,
      gyroscopeZ: 90,
    };
    vi.mocked(whoopDeps.peekBufferedSamples).mockResolvedValueOnce([strapA1, strapB, strapA2]);

    await drainBuffers(false);

    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledTimes(2);
    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenNthCalledWith(1, {
      telemetry: expect.objectContaining({ batchId: expect.any(String) }),
      deviceId: "whoop-a",
      deviceType: "whoop",
      samples: [
        {
          timestamp: strapA1.timestamp,
          x: strapA1.x,
          y: strapA1.y,
          z: strapA1.z,
          gyroscopeX: strapA1.gyroscopeX,
          gyroscopeY: strapA1.gyroscopeY,
          gyroscopeZ: strapA1.gyroscopeZ,
        },
        {
          timestamp: strapA2.timestamp,
          x: strapA2.x,
          y: strapA2.y,
          z: strapA2.z,
          gyroscopeX: strapA2.gyroscopeX,
          gyroscopeY: strapA2.gyroscopeY,
          gyroscopeZ: strapA2.gyroscopeZ,
        },
      ],
    });
    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenNthCalledWith(2, {
      telemetry: expect.objectContaining({ batchId: expect.any(String) }),
      deviceId: "whoop-b",
      deviceType: "whoop",
      samples: [
        {
          timestamp: strapB.timestamp,
          x: strapB.x,
          y: strapB.y,
          z: strapB.z,
          gyroscopeX: strapB.gyroscopeX,
          gyroscopeY: strapB.gyroscopeY,
          gyroscopeZ: strapB.gyroscopeZ,
        },
      ],
    });
    expect(whoopDeps.confirmSamplesDrain).toHaveBeenCalledWith(3);
  });

  it("leaves a mixed-device IMU page buffered when one device upload fails", async () => {
    const strapA = {
      deviceId: "whoop-a",
      timestamp: "2026-03-27T10:00:00.000Z",
      x: 1,
      y: 2,
      z: 3,
      gyroscopeX: 10,
      gyroscopeY: -20,
      gyroscopeZ: 30,
    };
    const strapB = {
      deviceId: "whoop-b",
      timestamp: "2026-03-27T10:00:01.000Z",
      x: 4,
      y: 5,
      z: 6,
      gyroscopeX: 40,
      gyroscopeY: -50,
      gyroscopeZ: 60,
    };
    vi.mocked(whoopDeps.peekBufferedSamples).mockResolvedValue([strapA, strapB]);
    vi.mocked(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate)
      .mockResolvedValueOnce({ inserted: 1 })
      .mockRejectedValueOnce(new Error("network error"));

    await drainBuffers(false);

    expect(whoopDeps.confirmSamplesDrain).not.toHaveBeenCalled();
  });

  it("does not confirm drain when upload fails", async () => {
    const { captureException } = await import("./telemetry");
    const samples = [
      {
        timestamp: "2026-03-27T10:00:00.000Z",
        x: 1,
        y: 2,
        z: 3,
        gyroscopeX: 10,
        gyroscopeY: -20,
        gyroscopeZ: 30,
      },
    ];
    vi.mocked(whoopDeps.peekBufferedSamples).mockResolvedValue(samples);
    vi.mocked(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).mockRejectedValue(
      new Error("network error"),
    );

    await drainBuffers(false);

    expect(whoopDeps.confirmSamplesDrain).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      source: "whoop-ble-imu-upload",
      batchId: expect.any(String),
      bufferInstanceId: "11111111-1111-4111-8111-111111111111",
      bufferedSampleCount: 1,
      deviceCount: 1,
      deviceIds: ["WHOOP Strap"],
      firstTimestamp: "2026-03-27T10:00:00.000Z",
      lastTimestamp: "2026-03-27T10:00:00.000Z",
    });
  });

  it("reports raw device context when IMU grouping fails before upload", async () => {
    const { captureException } = await import("./telemetry");
    const groupingError = new Error("malformed buffered sample");
    const malformedSample = {
      deviceId: "whoop-a",
      timestamp: "2026-03-27T10:00:00.000Z",
      get x() {
        throw groupingError;
      },
      y: 2,
      z: 3,
      gyroscopeX: 10,
      gyroscopeY: -20,
      gyroscopeZ: 30,
    };
    vi.mocked(whoopDeps.peekBufferedSamples).mockResolvedValue([malformedSample]);

    await drainBuffers(false);

    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).not.toHaveBeenCalled();
    expect(whoopDeps.confirmSamplesDrain).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(groupingError, {
      source: "whoop-ble-imu-upload",
      bufferedSampleCount: 1,
      deviceCount: 1,
      deviceIds: ["whoop-a"],
      firstTimestamp: "2026-03-27T10:00:00.000Z",
      lastTimestamp: "2026-03-27T10:00:00.000Z",
    });
  });

  it("uploads reported heart rate when beat intervals are unavailable", async () => {
    const realtimeSamples = [
      {
        timestamp: "2026-03-30T12:00:00.000Z",
        heartRateBpm: 72,
        quaternionW: 0.02,
        quaternionX: 0.68,
        quaternionY: -0.71,
        quaternionZ: 0.2,
        rrIntervalMs: 0,
        opticalRawHex: "000000000000000000000000000000000000",
      },
    ];
    vi.mocked(whoopDeps.peekBufferedRealtimeData).mockResolvedValueOnce(realtimeSamples);

    await drainBuffers(true);

    expect(realtimeClient.whoopBleSync.pushRealtimeData.mutate).toHaveBeenCalledWith({
      telemetry: expect.objectContaining({ batchId: expect.any(String) }),
      deviceId: "WHOOP Strap",
      samples: [
        {
          timestamp: "2026-03-30T12:00:00.000Z",
          heartRateBpm: 72,
          quaternionW: 0.02,
          quaternionX: 0.68,
          quaternionY: -0.71,
          quaternionZ: 0.2,
          rrIntervalMs: 0,
          opticalRawHex: "000000000000000000000000000000000000",
        },
      ],
    });
  });

  it("groups buffered realtime data by captured device id before upload", async () => {
    type BufferedRealtimeSample = Awaited<
      ReturnType<WhoopBleSyncDeps["peekBufferedRealtimeData"]>
    >[number] & { deviceId: string };
    const strapA1: BufferedRealtimeSample = {
      deviceId: "whoop-a",
      timestamp: "2026-03-30T12:00:00.000Z",
      heartRateBpm: 72,
      quaternionW: 0.02,
      quaternionX: 0.68,
      quaternionY: -0.71,
      quaternionZ: 0.2,
      rrIntervalMs: 0,
      opticalRawHex: "000000000000000000000000000000000000",
    };
    const strapB: BufferedRealtimeSample = {
      deviceId: "whoop-b",
      timestamp: "2026-03-30T12:00:01.000Z",
      heartRateBpm: 73,
      quaternionW: 1,
      quaternionX: 0,
      quaternionY: 0,
      quaternionZ: 0,
      rrIntervalMs: 833,
      opticalRawHex: "111111111111111111111111111111111111",
    };
    const strapA2: BufferedRealtimeSample = {
      deviceId: "whoop-a",
      timestamp: "2026-03-30T12:00:02.000Z",
      heartRateBpm: 74,
      quaternionW: 0,
      quaternionX: 1,
      quaternionY: 0,
      quaternionZ: 0,
      rrIntervalMs: 900,
      opticalRawHex: "222222222222222222222222222222222222",
    };
    vi.mocked(whoopDeps.peekBufferedRealtimeData)
      .mockResolvedValueOnce([strapA1, strapB, strapA2])
      .mockResolvedValue([]);

    await drainBuffers(true);

    expect(realtimeClient.whoopBleSync.pushRealtimeData.mutate).toHaveBeenCalledTimes(2);
    expect(realtimeClient.whoopBleSync.pushRealtimeData.mutate).toHaveBeenNthCalledWith(1, {
      telemetry: expect.objectContaining({ batchId: expect.any(String) }),
      deviceId: "whoop-a",
      samples: [
        {
          timestamp: strapA1.timestamp,
          heartRateBpm: strapA1.heartRateBpm,
          quaternionW: strapA1.quaternionW,
          quaternionX: strapA1.quaternionX,
          quaternionY: strapA1.quaternionY,
          quaternionZ: strapA1.quaternionZ,
          rrIntervalMs: strapA1.rrIntervalMs,
          opticalRawHex: strapA1.opticalRawHex,
        },
        {
          timestamp: strapA2.timestamp,
          heartRateBpm: strapA2.heartRateBpm,
          quaternionW: strapA2.quaternionW,
          quaternionX: strapA2.quaternionX,
          quaternionY: strapA2.quaternionY,
          quaternionZ: strapA2.quaternionZ,
          rrIntervalMs: strapA2.rrIntervalMs,
          opticalRawHex: strapA2.opticalRawHex,
        },
      ],
    });
    expect(realtimeClient.whoopBleSync.pushRealtimeData.mutate).toHaveBeenNthCalledWith(2, {
      telemetry: expect.objectContaining({ batchId: expect.any(String) }),
      deviceId: "whoop-b",
      samples: [
        {
          timestamp: strapB.timestamp,
          heartRateBpm: strapB.heartRateBpm,
          quaternionW: strapB.quaternionW,
          quaternionX: strapB.quaternionX,
          quaternionY: strapB.quaternionY,
          quaternionZ: strapB.quaternionZ,
          rrIntervalMs: strapB.rrIntervalMs,
          opticalRawHex: strapB.opticalRawHex,
        },
      ],
    });
    expect(whoopDeps.confirmRealtimeDataDrain).toHaveBeenCalledWith(3);
  });

  it("uses the fallback device id for blank native realtime device ids", async () => {
    vi.mocked(whoopDeps.peekBufferedRealtimeData)
      .mockResolvedValueOnce([
        {
          deviceId: "  ",
          timestamp: "2026-03-30T12:00:00.000Z",
          heartRateBpm: 72,
          quaternionW: 1,
          quaternionX: 0,
          quaternionY: 0,
          quaternionZ: 0,
          rrIntervalMs: 833,
          opticalRawHex: "111111111111111111111111111111111111",
        },
      ])
      .mockResolvedValue([]);

    await drainBuffers(true);

    expect(realtimeClient.whoopBleSync.pushRealtimeData.mutate).toHaveBeenCalledWith({
      telemetry: expect.objectContaining({ batchId: expect.any(String) }),
      deviceId: "WHOOP Strap",
      samples: [
        {
          timestamp: "2026-03-30T12:00:00.000Z",
          heartRateBpm: 72,
          quaternionW: 1,
          quaternionX: 0,
          quaternionY: 0,
          quaternionZ: 0,
          rrIntervalMs: 833,
          opticalRawHex: "111111111111111111111111111111111111",
        },
      ],
    });
  });

  it("requests bounded realtime batches from the native buffer", async () => {
    await drainBuffers(true);

    expect(whoopDeps.peekBufferedRealtimeData).toHaveBeenCalledWith(500);
  });

  it("uploads reported heart rate alongside beat intervals", async () => {
    const realtimeSamples = [
      {
        timestamp: "2026-03-30T12:00:00.000Z",
        heartRateBpm: 72,
        quaternionW: 0,
        quaternionX: 0,
        quaternionY: 0,
        quaternionZ: 0,
        rrIntervalMs: 833,
        opticalRawHex: "000000000000000000000000000000000000",
      },
    ];
    vi.mocked(whoopDeps.peekBufferedRealtimeData).mockResolvedValueOnce(realtimeSamples);

    await drainBuffers(true);

    expect(realtimeClient.whoopBleSync.pushRealtimeData.mutate).toHaveBeenCalledWith({
      telemetry: expect.objectContaining({ batchId: expect.any(String) }),
      deviceId: "WHOOP Strap",
      samples: [
        {
          timestamp: "2026-03-30T12:00:00.000Z",
          heartRateBpm: 72,
          quaternionW: 0,
          quaternionX: 0,
          quaternionY: 0,
          quaternionZ: 0,
          rrIntervalMs: 833,
          opticalRawHex: "000000000000000000000000000000000000",
        },
      ],
    });
  });

  it("correlates upload acknowledgment and native confirmation without logging sensor values", async () => {
    const { logger } = await import("./telemetry");
    vi.mocked(logger.info).mockClear();
    vi.mocked(whoopDeps.peekBufferedRealtimeData).mockResolvedValueOnce([
      {
        deviceId: "whoop-a",
        timestamp: "2026-10-23T00:00:00.000Z",
        heartRateBpm: 75,
        rrIntervalMs: 800,
        quaternionW: 1,
        quaternionX: 0,
        quaternionY: 0,
        quaternionZ: 0,
        opticalRawHex: "private-optical-payload",
      },
    ]);
    vi.mocked(whoopDeps.confirmRealtimeDataDrain).mockImplementation(() => {
      expect(logger.info).toHaveBeenCalledWith(
        "whoop-ble",
        "upload_acknowledged",
        expect.objectContaining({ stream: "realtime", publishedRowCount: 3 }),
      );
      expect(
        vi.mocked(logger.info).mock.calls.some(([, message]) => message === "buffer_confirmed"),
      ).toBe(false);
    });
    vi.mocked(realtimeClient.whoopBleSync.pushRealtimeData.mutate).mockResolvedValue({
      inserted: 3,
    });

    await drainBuffers(true);

    const upload = vi.mocked(realtimeClient.whoopBleSync.pushRealtimeData.mutate).mock
      .calls[0]?.[0];
    expect(upload).toMatchObject({
      telemetry: {
        batchId: expect.any(String),
        bufferInstanceId: "11111111-1111-4111-8111-111111111111",
      },
    });
    expect(logger.info).toHaveBeenCalledWith(
      "whoop-ble",
      "buffer_confirmed",
      expect.objectContaining({
        stream: "realtime",
        batchIds: upload?.telemetry?.batchId,
        requestedConfirmationCount: 1,
      }),
    );
    const structured = JSON.stringify(
      vi.mocked(logger.info).mock.calls.filter(([, , attributes]) => attributes),
    );
    expect(structured).not.toContain("private-optical-payload");
    expect(structured).not.toContain("heartRateBpm");
  });

  it("drains both IMU and realtime buffers independently", async () => {
    const imuSamples = [
      {
        timestamp: "2026-03-30T12:00:00.000Z",
        x: 100,
        y: -200,
        z: 4096,
        gyroscopeX: 10,
        gyroscopeY: -20,
        gyroscopeZ: 30,
      },
    ];
    const realtimeSamples = [
      {
        timestamp: "2026-03-30T12:00:00.500Z",
        heartRateBpm: 75,
        quaternionW: 0.5,
        quaternionX: 0.5,
        quaternionY: 0.5,
        quaternionZ: 0.5,
        rrIntervalMs: 0,
        opticalRawHex: "000000000000000000000000000000000000",
      },
    ];

    vi.mocked(whoopDeps.peekBufferedSamples).mockResolvedValueOnce(imuSamples);
    vi.mocked(whoopDeps.peekBufferedRealtimeData).mockResolvedValueOnce(realtimeSamples);

    await drainBuffers(true);

    // Both should be uploaded
    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalled();
    expect(realtimeClient.whoopBleSync.pushRealtimeData.mutate).toHaveBeenCalledWith({
      telemetry: expect.objectContaining({ batchId: expect.any(String) }),
      deviceId: "WHOOP Strap",
      samples: [
        {
          timestamp: "2026-03-30T12:00:00.500Z",
          heartRateBpm: 75,
          quaternionW: 0.5,
          quaternionX: 0.5,
          quaternionY: 0.5,
          quaternionZ: 0.5,
          rrIntervalMs: 0,
          opticalRawHex: "000000000000000000000000000000000000",
        },
      ],
    });
  });
});
