import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveWorkoutSnapshot } from "./workout-live.ts";
import type { LiveWorkoutBatch } from "./workout-live-storage.ts";

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
}));

vi.mock("@zos/app-access", () => ({ getSportData: moduleMocks.getSportData }));
vi.mock("@zos/sensor", () => ({
  HeartRate: class {
    getLast(): number {
      return moduleMocks.heartRateGetLast();
    }
  },
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
}));
vi.mock("@zeppos/zml/base-page", () => ({ BasePage: (value: unknown) => value }));
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
}

interface DataWidgetConfiguration {
  state: WidgetState;
  build(this: DataWidgetContext): void;
  collectSnapshot(this: DataWidgetContext): Promise<void>;
  flushSnapshots(this: DataWidgetContext): Promise<void>;
  startCollection(this: DataWidgetContext): void;
  stopCollection(this: DataWidgetContext): void;
  onResume(this: DataWidgetContext): void;
  onPause(this: DataWidgetContext): void;
  onDestroy(this: DataWidgetContext): void;
}

type DataWidgetContext = DataWidgetConfiguration & {
  state: WidgetState;
  request: typeof moduleMocks.request;
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
    },
    request: moduleMocks.request,
  };
}

beforeAll(async () => {
  vi.stubGlobal("DataWidget", (value: DataWidgetConfiguration) => {
    configuration = value;
  });
  await import("../workout-extension/data-widget/index.ts");
});

beforeEach(() => {
  vi.clearAllMocks();
  moduleMocks.readLiveWorkoutBuffer.mockReturnValue({ batches: [] });
  moduleMocks.createWidget.mockReturnValue({ setProperty: vi.fn() });
});

describe("workout extension data widget", () => {
  it("restores durable batches, renders status, and starts collection", () => {
    const context = makeContext();
    const batch = { externalId: "1720000000", snapshots: [] };
    moduleMocks.readLiveWorkoutBuffer.mockReturnValue({ batches: [batch] });
    context.startCollection = vi.fn();

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
      "live workout collection failed %j",
      expect.any(Error),
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
    moduleMocks.request.mockImplementation(async () => {
      batch.snapshots.push(newSnapshot);
    });

    await context.flushSnapshots.call(context);

    expect(moduleMocks.request).toHaveBeenCalledWith({
      method: "health.upload",
      params: {
        data: {
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
          data: expect.objectContaining({
            activities: [
              expect.objectContaining({
                startedAt: "2024-07-03T09:46:40.000Z",
                endedAt: "2024-07-03T09:46:40.000Z",
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

  it("starts, stops, resumes, pauses, and destroys collection", () => {
    vi.useFakeTimers();
    const context = makeContext();
    context.collectSnapshot = vi.fn().mockResolvedValue(undefined);
    context.flushSnapshots = vi.fn().mockResolvedValue(undefined);

    context.startCollection.call(context);
    const firstInterval = context.state.intervalId;
    expect(context.collectSnapshot).toHaveBeenCalledOnce();
    expect(firstInterval).not.toBeNull();
    context.startCollection.call(context);
    expect(context.collectSnapshot).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(10_000);
    expect(context.collectSnapshot).toHaveBeenCalledTimes(2);

    context.onPause.call(context);
    expect(context.state.intervalId).toBeNull();
    expect(context.flushSnapshots).toHaveBeenCalledOnce();
    context.onResume.call(context);
    expect(context.state.intervalId).not.toBeNull();
    context.onDestroy.call(context);
    expect(context.state.intervalId).toBeNull();
    context.stopCollection.call(context);
    expect(context.flushSnapshots).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
