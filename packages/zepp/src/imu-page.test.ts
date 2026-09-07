import { beforeAll, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  uploadImuFile: vi.fn(),
  request: vi.fn(),
  connection: vi.fn(),
  showToast: vi.fn(),
  loggerError: vi.fn(),
  readPendingImuFiles: vi.fn<() => PendingFile[]>(() => []),
  writePendingImuFiles: vi.fn(),
  resetSessionFile: vi.fn(),
  appendSamples: vi.fn(),
  finalizeSessionFile: vi.fn(),
}));
vi.mock("./imu-upload.ts", () => ({ uploadImuFile: mocks.uploadImuFile }));
vi.mock("./imu-pending-files.ts", () => ({
  readPendingImuFiles: mocks.readPendingImuFiles,
  writePendingImuFiles: mocks.writePendingImuFiles,
}));
vi.mock("./session-file.ts", () => ({ ...mocks, writeSessionMetaFile: vi.fn() }));
vi.mock("./background-health-storage.ts", () => ({}));
vi.mock("@zeppos/zml/3.0/module/messaging/plugin/page", () => ({ pagePlugin: {} }));
vi.mock("@zeppos/zml/base-page", () => ({
  BasePage: Object.assign((value: unknown) => value, { use: vi.fn() }),
}));
vi.mock("@zos/utils", () => {
  const BasePage = Object.assign((value: unknown) => value, { use: vi.fn() });
  return {
    BasePage,
    pagePlugin: {},
    queryPermission: vi.fn(),
    requestPermission: vi.fn(),
    start: vi.fn(),
    getDeviceInfo: () => ({ width: 480, height: 480, screenShape: 1 }),
    SCREEN_SHAPE_ROUND: 1,
    setWakeUpRelaunch: vi.fn(),
    showToast: mocks.showToast,
    Accelerometer: class {},
    BloodOxygen: class {},
    BodyTemperature: class {},
    checkSensor: vi.fn(),
    Distance: class {},
    FatBurning: class {},
    Gyroscope: class {},
    HeartRate: class {},
    Pai: class {},
    Sleep: class {},
    Stand: class {},
    Step: class {},
    Stress: class {},
    Workout: class {},
    log: { getLogger: () => ({ log: vi.fn(), error: mocks.loggerError }) },
    px: (value: number) => value,
  };
});
vi.mock("@zos/ui", () => ({
  align: {},
  createKeyboard: vi.fn(),
  createWidget: vi.fn(),
  deleteWidget: vi.fn(),
  inputType: {},
  prop: {},
  text_style: {},
  widget: {},
}));
type PendingFile = {
  slot: "A" | "B";
  sampleCount: number;
  observedHzX100: number;
  connection?: { serverUrl: string; accountId: string };
};
const originalConnection = { serverUrl: "https://dofek.example", accountId: "account-a" };
interface PageContext {
  state: {
    transferInProgress: boolean;
    pendingFiles: PendingFile[];
    failedTransfer: PendingFile | null;
    pendingManualExport: boolean;
    logging: boolean;
    [key: string]: unknown;
  };
  startTransfer(args: {
    path: string;
    sampleCount: number;
    observedHzX100: number;
    failedSlot: "A" | "B" | null;
  }): Promise<void>;
  onInit(): void;
  publishSessionStatus(state: "idle" | "recording"): void;
  startLogging(): void;
  stopLogging(): void;
  swapAndTransfer(): void;
  rememberPendingFile(slot: "A" | "B", sampleCount: number, observedHzX100: number): void;
  refreshPreferences: () => void;
  transferStoppedSession: () => void;
  request: typeof mocks.request;
  sendFile: ReturnType<typeof vi.fn>;
}
let config: PageContext;
beforeAll(async () => {
  vi.stubGlobal("Page", (value: PageContext) => {
    config = value;
  });
  await import("../page/index.ts");
});
function context(): PageContext {
  return {
    ...config,
    state: { ...config.state, pendingFiles: [], failedTransfer: null },
    request: mocks.request,
    sendFile: vi.fn(() => ({ on: vi.fn() })),
    refreshPreferences: vi.fn(),
    transferStoppedSession: vi.fn(),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.uploadImuFile.mockReset().mockResolvedValue(undefined);
  mocks.writePendingImuFiles.mockReset();
  mocks.connection.mockReset().mockResolvedValue(originalConnection);
  mocks.request
    .mockReset()
    .mockImplementation(async (request) =>
      request.method === "imu.getConnection" ? mocks.connection() : { ok: true },
    );
  mocks.readPendingImuFiles.mockReturnValue([]);
});
it("keeps an upload pending until the server acknowledges every batch", async () => {
  const page = context();
  const file: PendingFile = {
    slot: "A",
    sampleCount: 2,
    observedHzX100: 100,
    connection: originalConnection,
  };
  page.state.pendingFiles = [file];
  page.state.failedTransfer = file;
  let finish = () => {};
  mocks.uploadImuFile.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const uploading = page.startTransfer({
    path: "data://imu/session_a.bin",
    ...file,
    failedSlot: "A",
  });
  expect(page.state.transferInProgress).toBe(true);
  expect(mocks.request).toHaveBeenCalledWith({
    method: "imu.publishStatus",
    params: expect.objectContaining({ transferState: "uploading", pendingFileCount: 1 }),
  });
  expect(mocks.request).not.toHaveBeenCalledWith({
    method: "imu.publishStatus",
    params: expect.objectContaining({ transferState: "sent" }),
  });
  expect(page.state.pendingFiles).toEqual([file]);
  finish();
  await uploading;
  expect(page.state.transferInProgress).toBe(false);
  expect(page.state.pendingFiles).toEqual([]);
  expect(mocks.writePendingImuFiles).toHaveBeenLastCalledWith([]);
  expect(mocks.request).toHaveBeenCalledWith({
    method: "imu.publishStatus",
    params: expect.objectContaining({ transferState: "sent", pendingFileCount: 0 }),
  });
});
it("retains failed files and reports upload errors for retry", async () => {
  const page = context();
  const file: PendingFile = {
    slot: "B",
    sampleCount: 2,
    observedHzX100: 100,
    connection: originalConnection,
  };
  page.state.pendingFiles = [file];
  mocks.uploadImuFile.mockRejectedValueOnce(new Error("phone offline"));
  await page.startTransfer({ path: "data://imu/session_b.bin", ...file, failedSlot: "B" });
  expect(page.state.failedTransfer).toEqual(file);
  expect(mocks.request).toHaveBeenCalledWith({
    method: "imu.publishStatus",
    params: expect.objectContaining({ transferState: "error", pendingFileCount: 1 }),
  });
  expect(page.state.pendingFiles).toEqual([file]);
  expect(page.state.transferInProgress).toBe(false);
  expect(mocks.request).toHaveBeenCalledWith({
    method: "telemetry.report",
    params: expect.objectContaining({ message: "phone offline", category: "imu-upload" }),
  });
});
it("restores pending slots and blocks a new recording after restart", () => {
  const file: PendingFile = {
    slot: "A",
    sampleCount: 2,
    observedHzX100: 100,
    connection: originalConnection,
  };
  mocks.readPendingImuFiles.mockReturnValueOnce([file]);
  const page = context();
  page.onInit();
  page.startLogging();
  expect(page.state.pendingFiles).toEqual([file]);
  expect(mocks.resetSessionFile).not.toHaveBeenCalled();
  expect(mocks.showToast).toHaveBeenCalled();
});

it("drains both restored files without re-uploading the acknowledged active file", async () => {
  const page = context();
  const first: PendingFile = {
    slot: "A",
    sampleCount: 2,
    observedHzX100: 100,
    connection: originalConnection,
  };
  const second: PendingFile = {
    slot: "B",
    sampleCount: 1,
    observedHzX100: 100,
    connection: originalConnection,
  };
  page.state.pendingFiles = [first, second];
  page.state.pendingManualExport = true;
  mocks.uploadImuFile.mockResolvedValue(undefined);
  await page.startTransfer({ path: "data://imu/session_a.bin", ...first, failedSlot: "A" });
  expect(page.state.pendingFiles).toEqual([second]);
  expect(page.transferStoppedSession).toHaveBeenCalledOnce();
  page.transferStoppedSession = vi.fn();
  await page.startTransfer({ path: "data://imu/session_b.bin", ...second, failedSlot: "B" });
  expect(page.state.pendingFiles).toEqual([]);
  expect(page.state.pendingManualExport).toBe(false);
  expect(page.transferStoppedSession).not.toHaveBeenCalled();
});

it("persists account binding before sending any nonempty data", async () => {
  const page = context();
  const file: PendingFile = { slot: "A", sampleCount: 2, observedHzX100: 100 };
  page.state.pendingFiles = [file];
  mocks.connection.mockResolvedValueOnce(originalConnection);
  mocks.uploadImuFile.mockImplementation(async (_path, send) => {
    expect(mocks.writePendingImuFiles).toHaveBeenLastCalledWith([
      { ...file, connection: originalConnection },
    ]);
    await send({ data: [1, 2], sampleOffset: 0 });
  });
  await page.startTransfer({ path: "data://imu/session_a.bin", ...file, failedSlot: "A" });
  expect(mocks.request).toHaveBeenCalledWith({ method: "imu.getConnection", params: {} });
  expect(mocks.request).toHaveBeenCalledWith({
    method: "imu.upload",
    params: { data: [1, 2], sampleOffset: 0, connection: originalConnection },
  });
});
it("preserves binding after a lost acknowledgement and restart", async () => {
  const page = context();
  const file: PendingFile = { slot: "A", sampleCount: 2, observedHzX100: 100 };
  page.state.pendingFiles = [file];
  mocks.connection.mockResolvedValueOnce(originalConnection);
  mocks.uploadImuFile.mockRejectedValueOnce(new Error("acknowledgement lost"));
  await page.startTransfer({ path: "data://imu/session_a.bin", ...file, failedSlot: "A" });
  const persisted = [{ ...file, connection: originalConnection }];
  expect(page.state.pendingFiles).toEqual(persisted);
  mocks.readPendingImuFiles.mockReturnValueOnce(persisted);
  const restarted = context();
  restarted.onInit();
  mocks.request.mockClear();
  mocks.uploadImuFile.mockImplementation(async (_path, send) => {
    await send({ data: [1], sampleOffset: 0 });
  });
  await restarted.startTransfer({ path: "data://imu/session_a.bin", ...file, failedSlot: "A" });
  expect(mocks.request).toHaveBeenCalledWith({
    method: "imu.upload",
    params: { data: [1], sampleOffset: 0, connection: originalConnection },
  });
  expect(mocks.request).not.toHaveBeenCalledWith(
    expect.objectContaining({ method: "imu.getConnection" }),
  );
});
it.each([
  undefined,
  { serverUrl: "https://dofek.example" },
  { serverUrl: "", accountId: "a" },
])("retains the slot when connection response is invalid: %j", async (response) => {
  const page = context();
  const file: PendingFile = { slot: "A", sampleCount: 2, observedHzX100: 100 };
  page.state.pendingFiles = [file];
  mocks.connection.mockResolvedValueOnce(response);
  await page.startTransfer({ path: "data://imu/session_a.bin", ...file, failedSlot: "A" });
  expect(mocks.uploadImuFile).not.toHaveBeenCalled();
  expect(page.state.pendingFiles).toEqual([file]);
  expect(page.state.failedTransfer).toEqual(file);
});
it("discards an empty finalized file without cloud authentication", async () => {
  const page = context();
  const file: PendingFile = { slot: "B", sampleCount: 0, observedHzX100: 0 };
  page.state.pendingFiles = [file];
  await page.startTransfer({ path: "data://imu/session_b.bin", ...file, failedSlot: "B" });
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.uploadImuFile).not.toHaveBeenCalled();
  expect(page.state.pendingFiles).toEqual([]);
});

it("does not send or release the file when connection lookup fails", async () => {
  const page = context();
  const file: PendingFile = { slot: "A", sampleCount: 2, observedHzX100: 100 };
  page.state.pendingFiles = [file];
  mocks.connection.mockRejectedValueOnce(new Error("phone offline"));
  await page.startTransfer({ path: "data://imu/session_a.bin", ...file, failedSlot: "A" });
  expect(mocks.uploadImuFile).not.toHaveBeenCalled();
  expect(page.state.pendingFiles).toEqual([file]);
  expect(page.state.failedTransfer).toEqual(file);
});
it("does not upload if durable binding cannot be written", async () => {
  const page = context();
  const file: PendingFile = { slot: "A", sampleCount: 2, observedHzX100: 100 };
  page.state.pendingFiles = [file];
  mocks.connection.mockResolvedValueOnce(originalConnection);
  mocks.writePendingImuFiles.mockImplementationOnce(() => {
    throw new Error("journal write failed");
  });
  await page.startTransfer({ path: "data://imu/session_a.bin", ...file, failedSlot: "A" });
  expect(mocks.uploadImuFile).not.toHaveBeenCalled();
  expect(page.state.pendingFiles).toEqual([file]);
  expect(page.state.failedTransfer).toEqual(file);
});
it("preserves an existing binding when finalization updates file metadata", () => {
  const page = context();
  const file: PendingFile = {
    slot: "A",
    sampleCount: 2,
    observedHzX100: 100,
    connection: originalConnection,
  };
  page.state.pendingFiles = [file];
  page.rememberPendingFile("A", 2, 200);
  expect(page.state.pendingFiles).toEqual([{ ...file, observedHzX100: 200 }]);
});
it("stops recording instead of rotating over an unacknowledged slot", () => {
  const page = context();
  const file: PendingFile = {
    slot: "A",
    sampleCount: 2,
    observedHzX100: 100,
    connection: originalConnection,
  };
  page.state.pendingFiles = [file];
  page.state.failedTransfer = file;
  page.state.logging = true;
  page.state.activeFile = "B";
  page.stopLogging = vi.fn();
  page.swapAndTransfer();
  expect(page.stopLogging).toHaveBeenCalledOnce();
  expect(mocks.resetSessionFile).not.toHaveBeenCalled();
  expect(page.state.pendingFiles).toEqual([file]);
});

it("keeps successful acknowledgement durable even if status publication fails", async () => {
  const page = context();
  const file: PendingFile = {
    slot: "A",
    sampleCount: 2,
    observedHzX100: 100,
    connection: originalConnection,
  };
  page.state.pendingFiles = [file];
  mocks.request.mockImplementation(async (request) => {
    if (request.method === "imu.publishStatus") throw new Error("status offline");
    return { ok: true };
  });
  await expect(
    page.startTransfer({ path: "data://imu/session_a.bin", ...file, failedSlot: "A" }),
  ).resolves.toBeUndefined();
  expect(page.state.pendingFiles).toEqual([]);
  expect(mocks.writePendingImuFiles).toHaveBeenLastCalledWith([]);
});
it("retains the original file when error telemetry also fails", async () => {
  const page = context();
  const file: PendingFile = {
    slot: "A",
    sampleCount: 2,
    observedHzX100: 100,
    connection: originalConnection,
  };
  page.state.pendingFiles = [file];
  mocks.uploadImuFile.mockRejectedValueOnce(new Error("upload offline"));
  mocks.request.mockImplementation(async (request) => {
    if (request.method === "telemetry.report") throw new Error("telemetry offline");
    return { ok: true };
  });
  await expect(
    page.startTransfer({ path: "data://imu/session_a.bin", ...file, failedSlot: "A" }),
  ).resolves.toBeUndefined();
  expect(page.state.pendingFiles).toEqual([file]);
  expect(page.state.transferState).toBe("error");
});

it("publishes restored pending count while idle", () => {
  const file: PendingFile = {
    slot: "B",
    sampleCount: 2,
    observedHzX100: 100,
    connection: originalConnection,
  };
  mocks.readPendingImuFiles.mockReturnValueOnce([file]);
  const page = context();
  page.onInit();
  page.publishSessionStatus("idle");
  expect(mocks.request).toHaveBeenCalledWith({
    method: "imu.publishStatus",
    params: expect.objectContaining({ state: "idle", transferState: "idle", pendingFileCount: 1 }),
  });
});
it("does not report sent if acknowledging the durable journal fails", async () => {
  const page = context();
  const file: PendingFile = {
    slot: "A",
    sampleCount: 2,
    observedHzX100: 100,
    connection: originalConnection,
  };
  page.state.pendingFiles = [file];
  mocks.writePendingImuFiles.mockImplementationOnce(() => {
    throw new Error("journal unavailable");
  });
  await page.startTransfer({ path: "data://imu/session_a.bin", ...file, failedSlot: "A" });
  expect(page.state.pendingFiles).toEqual([file]);
  expect(page.state.transferState).toBe("error");
  expect(mocks.request).not.toHaveBeenCalledWith({
    method: "imu.publishStatus",
    params: expect.objectContaining({ transferState: "sent" }),
  });
});
