import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImuSegmentResult, ImuSessionController } from "./imu-session-controller.ts";
import type { LiveWorkoutSnapshot } from "./workout-live.ts";
import type { LiveWorkoutBatch } from "./workout-live-storage.ts";

type TransferListener = (event: { data: Record<string, unknown> }) => void;

function segmentResult(path = "data://imu/workout_a.bin"): ImuSegmentResult {
  return {
    path,
    sampleCount: 120,
    observedHzX100: 2_500,
    hasGyroscope: true,
    accelFreqMode: 1,
    gyroFreqMode: 1,
    sessionStartMs: 1_720_000_000_000,
  };
}

function mockController(): ImuSessionController {
  return {
    active: true,
    available: true,
    reason: null,
    hasGyroscope: true,
    accelFreqMode: 1,
    gyroFreqMode: 1,
    sampleCount: 0,
    observedHzX100: 0,
    start: vi.fn(() => true),
    rotate: vi.fn(() => null),
    stop: vi.fn(() => segmentResult()),
  };
}

const moduleMocks = vi.hoisted(() => ({
  collectLiveWorkoutSnapshot: vi.fn(),
  findLiveWorkoutExternalId: vi.fn(),
  readLiveWorkoutBuffer: vi.fn(),
  writeLiveWorkoutBuffer: vi.fn(),
  request: vi.fn(),
  loggerError: vi.fn(),
  createWidget: vi.fn(),
  getSportData: vi.fn(),
  heartRateGetLast: vi.fn(() => 148),
  createImuSessionController: vi.fn(),
  readPendingImuTransfers: vi.fn(),
  savePendingImuTransfer: vi.fn(),
  clearPendingImuTransfer: vi.fn(),
  sendFile: vi.fn(),
}));

vi.mock("@zos/app-access", () => ({ getSportData: moduleMocks.getSportData }));
vi.mock("@zos/sensor", () => ({
  Accelerometer: class {},
  Gyroscope: class {},
  checkSensor: vi.fn(() => true),
  HeartRate: class {
    getLast(): number {
      return moduleMocks.heartRateGetLast();
    }
  },
}));
vi.mock("@zos/display", () => ({
  pauseDropWristScreenOff: vi.fn(() => 0),
  resetDropWristScreenOff: vi.fn(() => 0),
  setPageBrightTime: vi.fn(() => 0),
  resetPageBrightTime: vi.fn(() => 0),
}));
vi.mock("@zos/ui", () => ({
  align: { CENTER_H: 1 },
  createWidget: moduleMocks.createWidget,
  prop: { TEXT: 2 },
  text_style: { NONE: 0, WRAP: 1 },
  widget: { TEXT: 3 },
}));
vi.mock("@zos/utils", () => ({
  HeartRate: class {
    getLast(): number {
      return moduleMocks.heartRateGetLast();
    }
  },
  align: { CENTER_H: 1 },
  createWidget: moduleMocks.createWidget,
  getSportData: moduleMocks.getSportData,
  log: { getLogger: () => ({ error: moduleMocks.loggerError }) },
  prop: { TEXT: 2 },
  px: (value: number) => value,
  text_style: { NONE: 0, WRAP: 1 },
  widget: { TEXT: 3 },
  pauseDropWristScreenOff: vi.fn(() => 0),
  resetDropWristScreenOff: vi.fn(() => 0),
  setPageBrightTime: vi.fn(() => 0),
  resetPageBrightTime: vi.fn(() => 0),
}));
vi.mock("@zeppos/zml/base-page", () => ({ BasePage: (value: unknown) => value }));
vi.mock("./imu-session-controller.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./imu-session-controller.ts")>();
  return {
    ...original,
    createImuSessionController: moduleMocks.createImuSessionController,
  };
});
vi.mock("./imu-transfer-storage.ts", () => ({
  readPendingImuTransfers: moduleMocks.readPendingImuTransfers,
  savePendingImuTransfer: moduleMocks.savePendingImuTransfer,
  clearPendingImuTransfer: moduleMocks.clearPendingImuTransfer,
}));
vi.mock("./workout-live.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./workout-live.ts")>();
  return {
    ...original,
    collectLiveWorkoutSnapshot: moduleMocks.collectLiveWorkoutSnapshot,
    findLiveWorkoutExternalId: moduleMocks.findLiveWorkoutExternalId,
  };
});
vi.mock("./workout-live-storage.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./workout-live-storage.ts")>();
  return {
    ...original,
    readLiveWorkoutBuffer: moduleMocks.readLiveWorkoutBuffer,
    writeLiveWorkoutBuffer: moduleMocks.writeLiveWorkoutBuffer,
  };
});

interface WidgetReference {
  setProperty(property: number, value: string): void;
}

interface WidgetState {
  intervalId: ReturnType<typeof setInterval> | null;
  collecting: boolean;
  flushing: boolean;
  pendingBatches: LiveWorkoutBatch[];
  statusWidget: WidgetReference | null;
  focused: boolean;
  imuController: ImuSessionController | null;
  activeImuSlot: "A" | "B";
  pendingImuA: ImuSegmentResult | null;
  pendingImuB: ImuSegmentResult | null;
  transferringImuA: boolean;
  transferringImuB: boolean;
}

interface DataWidgetConfiguration {
  state: WidgetState;
  build(this: DataWidgetContext): void;
  collectSnapshot(this: DataWidgetContext): Promise<void>;
  flushSnapshots(this: DataWidgetContext): Promise<void>;
  startCollection(this: DataWidgetContext): void;
  stopCollection(this: DataWidgetContext): void;
  startImuSegment(this: DataWidgetContext): void;
  stopImuSegment(this: DataWidgetContext): void;
  sendImuSegment(this: DataWidgetContext, result: ImuSegmentResult, slot: "A" | "B"): void;
  retryImuTransfers(this: DataWidgetContext): void;
  reportError(this: DataWidgetContext, error: unknown, category: string): void;
  onResume(this: DataWidgetContext): void;
  onPause(this: DataWidgetContext): void;
  onDestroy(this: DataWidgetContext): void;
}

type DataWidgetContext = DataWidgetConfiguration & {
  state: WidgetState;
  request: typeof moduleMocks.request;
  sendFile: typeof moduleMocks.sendFile;
};

let configuration: DataWidgetConfiguration | undefined;

function makeContext(): DataWidgetContext {
  if (!configuration) throw new Error("data widget configuration was not registered");
  return {
    ...configuration,
    state: {
      intervalId: null,
      collecting: false,
      flushing: false,
      pendingBatches: [],
      statusWidget: null,
      focused: false,
      imuController: null,
      activeImuSlot: "A",
      pendingImuA: null,
      pendingImuB: null,
      transferringImuA: false,
      transferringImuB: false,
    },
    request: moduleMocks.request,
    sendFile: moduleMocks.sendFile,
  };
}

beforeAll(async () => {
  vi.stubGlobal("settings", {
    settingsStorage: {
      getItem: vi.fn(() => "install-1"),
      setItem: vi.fn(),
    },
  });
  vi.stubGlobal("DataWidget", (value: DataWidgetConfiguration) => {
    configuration = value;
  });
  await import("../workout-extension/data-widget/index.ts");
});

beforeEach(() => {
  vi.clearAllMocks();
  moduleMocks.readLiveWorkoutBuffer.mockReturnValue({ batches: [] });
  moduleMocks.readPendingImuTransfers.mockReturnValue([]);
  moduleMocks.createWidget.mockReturnValue({ setProperty: vi.fn() });
  moduleMocks.request.mockImplementation(async (request) =>
    request.method === "health.upload"
      ? {
          status: "ok",
          acceptedEventIds: request.params.envelope.events.map(
            (event: { eventId: string }) => event.eventId,
          ),
          rejected: [],
        }
      : { ok: true },
  );
  moduleMocks.createImuSessionController.mockImplementation(() => mockController());
  moduleMocks.sendFile.mockReturnValue({ on: vi.fn() });
});

describe("workout extension data widget", () => {
  it("restores durable batches, renders status, and starts focused collectors", () => {
    const context = makeContext();
    const batch = { externalId: "1720000000", snapshots: [] };
    moduleMocks.readLiveWorkoutBuffer.mockReturnValue({ batches: [batch] });
    context.startCollection = vi.fn();
    context.startImuSegment = vi.fn();

    context.build.call(context);

    expect(context.state.pendingBatches).toEqual([batch]);
    expect(moduleMocks.createWidget).toHaveBeenCalledTimes(2);
    expect(moduleMocks.createWidget).toHaveBeenNthCalledWith(1, 3, {
      x: 20,
      y: 80,
      w: 440,
      h: 60,
      color: 0xffffff,
      text_size: 34,
      align_h: 1,
      text_style: 0,
      text: "Dofek Workout",
    });
    expect(moduleMocks.createWidget).toHaveBeenNthCalledWith(2, 3, {
      x: 20,
      y: 160,
      w: 440,
      h: 120,
      color: 0x9ca3af,
      text_size: 26,
      align_h: 1,
      text_style: 1,
      text: "Collecting live workout data",
    });
    expect(context.state.statusWidget).not.toBeNull();
    expect(context.startCollection).toHaveBeenCalledOnce();
    expect(context.startImuSegment).toHaveBeenCalledOnce();
    expect(context.state.focused).toBe(true);
  });

  it("uses the shared controller and automatically records gyroscope when available", () => {
    const context = makeContext();

    context.startImuSegment.call(context);

    expect(moduleMocks.createImuSessionController).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "data://imu/workout_a.bin",
        requestedFreqModeIndex: 1,
        displayLease: expect.any(Object),
        createCollector: expect.any(Function),
        file: expect.objectContaining({
          reset: expect.any(Function),
          append: expect.any(Function),
          finalize: expect.any(Function),
        }),
      }),
    );
    expect(context.state.imuController?.start).toHaveBeenCalledOnce();
    expect(context.state.activeImuSlot).toBe("A");
  });

  it("finalizes a focused IMU segment once and frees its slot only after transfer", () => {
    const listeners = new Map<string, TransferListener>();
    moduleMocks.sendFile.mockReturnValue({
      on: vi.fn((event: string, listener: TransferListener) => listeners.set(event, listener)),
    });
    const controller = mockController();
    const context = makeContext();
    context.state.imuController = controller;
    context.state.activeImuSlot = "A";

    context.stopImuSegment.call(context);
    context.stopImuSegment.call(context);

    expect(controller.stop).toHaveBeenCalledOnce();
    expect(context.state.pendingImuA).toEqual(segmentResult());
    expect(moduleMocks.sendFile).toHaveBeenCalledOnce();
    expect(moduleMocks.sendFile).toHaveBeenCalledWith("data://imu/workout_a.bin", {
      type: "imu-session",
      source: "zepp-workout",
      segmentId: "install-1:workout-imu:1720000000000",
      sampleCount: "120",
      observedHzX100: "2500",
    });

    listeners.get("change")?.({ data: { readyState: "transferred" } });
    expect(context.state.pendingImuA).toBeNull();
    expect(moduleMocks.clearPendingImuTransfer).toHaveBeenCalledWith(
      "data://imu/workout_transfers.json",
      "A",
    );
  });

  it("alternates files while a prior workout segment is transferring", () => {
    const context = makeContext();
    context.state.pendingImuA = segmentResult();

    context.startImuSegment.call(context);

    expect(moduleMocks.createImuSessionController).toHaveBeenCalledWith(
      expect.objectContaining({ path: "data://imu/workout_b.bin" }),
    );
    expect(context.state.activeImuSlot).toBe("B");
  });

  it("restores and retries a pending motion file before reusing its slot", () => {
    const restored = { ...segmentResult("data://imu/workout_a.bin"), slot: "A" as const };
    moduleMocks.readPendingImuTransfers.mockReturnValue([restored]);
    const context = makeContext();
    context.startCollection = vi.fn();

    context.build.call(context);

    expect(moduleMocks.sendFile).toHaveBeenCalledWith(
      "data://imu/workout_a.bin",
      expect.objectContaining({ segmentId: "install-1:workout-imu:1720000000000" }),
    );
    expect(moduleMocks.createImuSessionController).toHaveBeenCalledWith(
      expect.objectContaining({ path: "data://imu/workout_b.bin" }),
    );
  });

  it("collects, persists, and reports a live snapshot", async () => {
    const context = makeContext();
    const statusWidget = { setProperty: vi.fn() };
    context.state.statusWidget = statusWidget;
    context.flushSnapshots = vi.fn();
    const snapshot: LiveWorkoutSnapshot = {
      recordedAt: "2024-07-03T09:51:52.000Z",
      heartRate: 148,
      metrics: { duration: 312 },
    };
    moduleMocks.collectLiveWorkoutSnapshot.mockResolvedValue(snapshot);
    moduleMocks.findLiveWorkoutExternalId.mockReturnValue("1720000000");

    await context.collectSnapshot.call(context);

    expect(context.state.collecting).toBe(false);
    expect(context.state.pendingBatches).toEqual([
      { externalId: "1720000000", snapshots: [snapshot] },
    ]);
    expect(moduleMocks.collectLiveWorkoutSnapshot).toHaveBeenCalledWith(
      moduleMocks.getSportData,
      expect.any(Function),
    );
    const heartRateReader = moduleMocks.collectLiveWorkoutSnapshot.mock.calls[0]?.[1];
    expect(heartRateReader?.()).toBe(148);
    expect(moduleMocks.heartRateGetLast).toHaveBeenCalledOnce();
    expect(moduleMocks.findLiveWorkoutExternalId).toHaveBeenCalledWith(snapshot, []);
    expect(moduleMocks.writeLiveWorkoutBuffer).toHaveBeenCalledWith({
      batches: context.state.pendingBatches,
    });
    expect(statusWidget.setProperty).toHaveBeenCalledWith(2, "Captured 1 live sample");
    expect(context.flushSnapshots).not.toHaveBeenCalled();
  });

  it("drops snapshots that cannot be associated with a workout", async () => {
    const context = makeContext();
    const snapshot = { recordedAt: "2024-07-03T09:51:52.000Z", metrics: {} };
    moduleMocks.collectLiveWorkoutSnapshot.mockResolvedValue(snapshot);
    moduleMocks.findLiveWorkoutExternalId.mockReturnValue(undefined);

    await context.collectSnapshot.call(context);

    expect(context.state.pendingBatches).toEqual([]);
    expect(moduleMocks.writeLiveWorkoutBuffer).not.toHaveBeenCalled();
    expect(context.state.collecting).toBe(false);
  });

  it("reports collection errors and releases the collection guard", async () => {
    const context = makeContext();
    moduleMocks.collectLiveWorkoutSnapshot.mockRejectedValue(new Error("sensor unavailable"));

    await context.collectSnapshot.call(context);

    expect(moduleMocks.loggerError).toHaveBeenCalledWith(
      "%s failed %j",
      "workout-collection",
      expect.any(Error),
    );
    expect(moduleMocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "telemetry.report",
        params: expect.objectContaining({ category: "workout-collection" }),
      }),
    );
    expect(context.state.collecting).toBe(false);
  });

  it("does not overlap collectors and flushes once the batch threshold is reached", async () => {
    const context = makeContext();
    context.state.collecting = true;
    await context.collectSnapshot.call(context);
    expect(moduleMocks.collectLiveWorkoutSnapshot).not.toHaveBeenCalled();

    context.state.collecting = false;
    context.flushSnapshots = vi.fn();
    const snapshots = Array.from({ length: 5 }, (_, index) => ({
      recordedAt: new Date(index * 10_000).toISOString(),
      metrics: { duration: index },
    }));
    context.state.pendingBatches = [{ externalId: "1720000000", snapshots }];
    moduleMocks.collectLiveWorkoutSnapshot.mockResolvedValue({
      recordedAt: "2024-07-03T09:51:52.000Z",
      metrics: { duration: 312 },
    });
    moduleMocks.findLiveWorkoutExternalId.mockReturnValue("1720000000");

    await context.collectSnapshot.call(context);
    expect(context.flushSnapshots).toHaveBeenCalledOnce();
  });

  it("keeps a newly collected snapshot after a successful in-flight upload", async () => {
    const context = makeContext();
    const uploadedSnapshot = {
      recordedAt: "2024-07-03T09:51:52.000Z",
      metrics: { duration: 312 },
    };
    const newSnapshot = {
      recordedAt: "2024-07-03T09:52:02.000Z",
      metrics: { duration: 322 },
    };
    const batch = { externalId: "1720000000", snapshots: [uploadedSnapshot] };
    context.state.pendingBatches = [batch];
    moduleMocks.request.mockImplementation(async (request) => {
      batch.snapshots.push(newSnapshot);
      return {
        status: "ok",
        acceptedEventIds: request.params.envelope.events.map(
          (event: { eventId: string }) => event.eventId,
        ),
        rejected: [],
      };
    });

    await context.flushSnapshots.call(context);

    expect(moduleMocks.request).toHaveBeenCalledWith({
      method: "health.upload",
      params: {
        envelope: {
          version: 1,
          batchId: "install-1:workout:1720000000:2024-07-03T09:51:52.000Z:2024-07-03T09:51:52.000Z",
          source: { connectionType: "zepp-workout", installId: "install-1" },
          events: [
            {
              eventId:
                "install-1:workout:1720000000:2024-07-03T09:51:52.000Z:2024-07-03T09:51:52.000Z",
              createdAt: "2024-07-03T09:51:52.000Z",
              payload: {
                activities: [
                  {
                    externalId: "1720000000",
                    activityType: "other",
                    startedAt: "2024-07-03T09:46:40.000Z",
                    endedAt: "2024-07-03T09:51:52.000Z",
                    raw: {
                      liveSnapshotsByRecordedAt: {
                        "2024-07-03T09:51:52.000Z": uploadedSnapshot,
                      },
                    },
                  },
                ],
                liveWorkoutSamples: [{ externalId: "1720000000", ...uploadedSnapshot }],
              },
            },
          ],
        },
      },
    });
    expect(context.state.pendingBatches).toEqual([
      { externalId: "1720000000", snapshots: [newSnapshot] },
    ]);
    expect(context.state.flushing).toBe(false);
  });

  it("uses zero duration and skips empty batches while syncing the rest", async () => {
    const context = makeContext();
    const snapshot = { recordedAt: "2024-07-03T09:46:40.000Z", metrics: {} };
    context.state.pendingBatches = [
      { externalId: "1719999999", snapshots: [] },
      { externalId: "1720000000", snapshots: [snapshot] },
    ];

    await context.flushSnapshots.call(context);

    expect(moduleMocks.request).toHaveBeenCalledOnce();
    expect(moduleMocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          envelope: expect.objectContaining({
            events: [
              expect.objectContaining({
                payload: expect.objectContaining({
                  activities: [
                    expect.objectContaining({
                      startedAt: "2024-07-03T09:46:40.000Z",
                      endedAt: "2024-07-03T09:46:40.000Z",
                    }),
                  ],
                }),
              }),
            ],
          }),
        }),
      }),
    );
    expect(context.state.statusWidget).toBeNull();
  });

  it("does not overlap flushes or upload an empty buffer", async () => {
    const context = makeContext();
    context.state.flushing = true;
    await context.flushSnapshots.call(context);
    expect(moduleMocks.request).not.toHaveBeenCalled();

    context.state.flushing = false;
    await context.flushSnapshots.call(context);
    expect(moduleMocks.request).not.toHaveBeenCalled();
  });

  it("persists batches after upload failure and resets the flushing guard", async () => {
    const context = makeContext();
    context.state.pendingBatches = [
      {
        externalId: "1720000000",
        snapshots: [{ recordedAt: "2024-07-03T09:51:52.000Z", metrics: {} }],
      },
    ];
    moduleMocks.request.mockRejectedValue(new Error("offline"));

    await context.flushSnapshots.call(context);

    expect(moduleMocks.writeLiveWorkoutBuffer).toHaveBeenCalledWith({
      batches: context.state.pendingBatches,
    });
    expect(moduleMocks.loggerError).toHaveBeenCalled();
    expect(context.state.flushing).toBe(false);
  });

  it("starts, stops, resumes, pauses, and destroys all focused collection", () => {
    vi.useFakeTimers();
    const context = makeContext();
    context.collectSnapshot = vi.fn().mockResolvedValue(undefined);
    context.flushSnapshots = vi.fn().mockResolvedValue(undefined);
    context.startImuSegment = vi.fn();
    context.stopImuSegment = vi.fn();

    context.startCollection.call(context);
    const firstInterval = context.state.intervalId;
    expect(context.collectSnapshot).toHaveBeenCalledOnce();
    expect(firstInterval).not.toBeNull();
    context.startCollection.call(context);
    expect(context.collectSnapshot).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(10_000);
    expect(context.collectSnapshot).toHaveBeenCalledTimes(2);

    context.onPause.call(context);
    expect(context.state.focused).toBe(false);
    expect(context.state.intervalId).toBeNull();
    expect(context.flushSnapshots).toHaveBeenCalledOnce();
    expect(context.stopImuSegment).toHaveBeenCalledOnce();
    context.onResume.call(context);
    expect(context.state.focused).toBe(true);
    expect(context.state.intervalId).not.toBeNull();
    expect(context.startImuSegment).toHaveBeenCalledOnce();
    context.onDestroy.call(context);
    expect(context.state.intervalId).toBeNull();
    expect(context.stopImuSegment).toHaveBeenCalledTimes(2);
    context.stopCollection.call(context);
    expect(context.flushSnapshots).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
