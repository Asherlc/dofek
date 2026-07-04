import { beforeEach, describe, expect, it, vi } from "vitest";

type FileWriteArg = { path: string; data: ArrayBuffer };
type FileReadArg = { path: string; options: { encoding: string } };
type OpenArg = { path: string; flag: number };
type WriteArg = { data: ArrayBuffer };

const mockWriteFileSync = vi.hoisted(() => vi.fn<(arg: FileWriteArg) => void>());
const mockReadFileSync = vi.hoisted(() => vi.fn<(arg: FileReadArg) => ArrayBuffer | undefined>());
const mockOpenSync = vi.hoisted(() => vi.fn<(arg: OpenArg) => number>());
const mockWriteSync = vi.hoisted(() => vi.fn<(arg: WriteArg) => void>());
const mockCloseSync = vi.hoisted(() => vi.fn<(arg: { fd: number }) => void>());

vi.mock("@zos/fs", () => ({
  writeFileSync: mockWriteFileSync,
  readFileSync: mockReadFileSync,
  openSync: mockOpenSync,
  writeSync: mockWriteSync,
  closeSync: mockCloseSync,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_APPEND: 4,
  O_CREAT: 8,
}));

import {
  appendPhysicalSamples,
  appendSamples,
  finalizeSessionFile,
  resetSessionFile,
} from "./session-file.ts";

const SESSION_FILE = "data://imu/session.bin";
const HEADER_SIZE = 32;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resetSessionFile", () => {
  it("writes a header to the session file", () => {
    resetSessionFile(
      {
        hasGyro: true,
        sessionStartMs: 1000,
        sampleCount: 0,
        accelFreqMode: 2,
        gyroFreqMode: 2,
        observedHzX100: 2600,
      },
      SESSION_FILE,
    );

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const writeCalls = mockWriteFileSync.mock.calls;
    const firstCall = writeCalls[0];
    if (!firstCall) throw new Error("expected writeFileSync to be called");
    expect(firstCall[0].path).toBe(SESSION_FILE);
    expect(firstCall[0].data.byteLength).toBe(HEADER_SIZE);
  });
});

describe("appendSamples", () => {
  it("does not call openSync for empty samples", () => {
    appendSamples([], false, SESSION_FILE);
    expect(mockOpenSync).not.toHaveBeenCalled();
  });

  it("writes chunk to session file", () => {
    const samples = [{ tMs: 0, ax: 1, ay: 2, az: 3 }];
    appendSamples(samples, false, SESSION_FILE);

    expect(mockOpenSync).toHaveBeenCalledWith({
      path: SESSION_FILE,
      flag: 1 | 4 | 8,
    });
    expect(mockWriteSync).toHaveBeenCalledTimes(1);
    expect(mockCloseSync).toHaveBeenCalledTimes(1);
  });

  it("encodes gyro records when hasGyro is true", () => {
    const samples = [{ tMs: 10, ax: 0, ay: 0, az: 9.8, gx: 0.1, gy: 0.2, gz: 0.3 }];
    appendSamples(samples, true, SESSION_FILE);

    const writeCalls = mockWriteSync.mock.calls;
    const writeFirstCall = writeCalls[0];
    if (!writeFirstCall) throw new Error("expected writeSync to be called");
    expect(writeFirstCall[0].data.byteLength).toBe(4 + 28);
  });
});

describe("appendPhysicalSamples", () => {
  it("appends physical sensor chunks", () => {
    appendPhysicalSamples(
      [{ tMs: 10, channel: "heartRate", value: 72 }],
      [{ tMs: 20, latitude: 37.1, longitude: -122.1 }],
      SESSION_FILE,
    );

    expect(mockOpenSync).toHaveBeenCalledWith({
      path: SESSION_FILE,
      flag: 1 | 4 | 8,
    });
    expect(mockWriteSync).toHaveBeenCalledTimes(1);
    expect(mockCloseSync).toHaveBeenCalledTimes(1);

    const writeCalls = mockWriteSync.mock.calls;
    const writeFirstCall = writeCalls[0];
    if (!writeFirstCall) throw new Error("expected writeSync to be called");

    const view = new DataView(writeFirstCall[0].data);
    expect(view.getUint8(0)).toBe(2);
    expect(view.getUint16(2, true)).toBe(1);

    const locationChunkOffset = 4 + 16;
    expect(view.getUint8(locationChunkOffset)).toBe(3);
    expect(view.getUint16(locationChunkOffset + 2, true)).toBe(1);
  });
});

describe("finalizeSessionFile", () => {
  it("reads header, patches sampleCount, writes back", () => {
    const headerBuf = new ArrayBuffer(HEADER_SIZE);
    const view = new DataView(headerBuf);
    view.setUint32(0, 0x314d5549, true);

    mockReadFileSync.mockReturnValue(headerBuf);

    finalizeSessionFile(500, 2500, SESSION_FILE);

    expect(mockReadFileSync).toHaveBeenCalledWith({
      path: SESSION_FILE,
      options: { encoding: "binary" },
    });
    expect(mockOpenSync).toHaveBeenCalledWith({
      path: SESSION_FILE,
      flag: 2,
    });
    expect(mockWriteSync).toHaveBeenCalledTimes(1);
    expect(mockCloseSync).toHaveBeenCalledTimes(1);

    const writeCalls = mockWriteSync.mock.calls;
    const writeFirstCall = writeCalls[0];
    if (!writeFirstCall) throw new Error("expected writeSync to be called");
    const patchedView = new DataView(writeFirstCall[0].data);
    expect(patchedView.getUint32(16, true)).toBe(500);
    expect(patchedView.getUint16(22, true)).toBe(2500);
  });

  it("does nothing when session file is missing", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("File not found");
    });

    expect(() => finalizeSessionFile(100, 1000, SESSION_FILE)).not.toThrow();
  });

  it("does nothing when header buffer is too small", () => {
    mockReadFileSync.mockReturnValue(new ArrayBuffer(8));

    finalizeSessionFile(100, 1000, SESSION_FILE);

    expect(mockOpenSync).not.toHaveBeenCalled();
  });
});
