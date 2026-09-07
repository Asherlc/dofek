import { beforeEach, describe, expect, it, vi } from "vitest";
import { concatArrayBuffers, createHeader, encodeChunk } from "./imu-format.ts";
import { uploadImuFile } from "./imu-upload.ts";

const readFile = vi.hoisted(() => vi.fn());
vi.mock("@zos/fs", () => ({ readFileSync: readFile }));

function recording(count: number): ArrayBuffer {
  return concatArrayBuffers([
    createHeader({ sessionStartMs: 1_780_000_000_000, sampleCount: count, hasGyro: true }),
    encodeChunk(
      Array.from({ length: count }, (_, i) => ({
        tMs: i * 10,
        sensor: i % 2 ? "gyroscope" : "accelerometer",
        x: i,
        y: 2,
        z: 3,
      })),
    ),
  ]);
}

beforeEach(() => vi.resetAllMocks());

describe("uploadImuFile", () => {
  it("does not acknowledge an unexpectedly empty recording", async () => {
    readFile.mockReturnValue(recording(0));
    const send = vi.fn();
    await expect(uploadImuFile("file", send)).rejects.toThrow("no samples");
    expect(send).not.toHaveBeenCalled();
  });
  it("sends bounded self-contained batches with stable file time and record offsets", async () => {
    const file = recording(260);
    readFile.mockReturnValue(file);
    const send = vi.fn().mockResolvedValue({ ok: true });
    await uploadImuFile("data://imu/a.bin", send);
    expect(send.mock.calls.map(([batch]) => batch.sampleOffset)).toEqual([0, 128, 256]);
    expect(
      send.mock.calls.map(([batch]) =>
        new DataView(Uint8Array.from(batch.data).buffer).getUint32(16, true),
      ),
    ).toEqual([128, 128, 4]);
    for (const [batch] of send.mock.calls) {
      expect(batch.data.length).toBeLessThanOrEqual(32 + 4 + 128 * 20);
      expect(batch.data.slice(8, 16)).toEqual(Array.from(new Uint8Array(file).slice(8, 16)));
    }
    const firstAttempt = send.mock.calls.map(([batch]) => batch);
    send.mockClear();
    await uploadImuFile("data://imu/a.bin", send);
    expect(send.mock.calls.map(([batch]) => batch)).toEqual(firstAttempt);
  });

  it("waits for acknowledgement before sending the next batch", async () => {
    readFile.mockReturnValue(recording(129));
    let acknowledge = (_value: { ok: boolean }) => {};
    const send = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            acknowledge = resolve;
          }),
      )
      .mockResolvedValue({ ok: true });
    const upload = uploadImuFile("file", send);
    expect(send).toHaveBeenCalledTimes(1);
    acknowledge({ ok: true });
    await upload;
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("rejects missing acknowledgement and network failure without continuing", async () => {
    readFile.mockReturnValue(recording(129));
    const send = vi.fn().mockResolvedValue({ ok: false });
    await expect(uploadImuFile("file", send)).rejects.toThrow("acknowledge");
    expect(send).toHaveBeenCalledTimes(1);
    send.mockRejectedValue(new Error("offline"));
    await expect(uploadImuFile("file", send)).rejects.toThrow("offline");
  });

  it("validates the entire file before publishing any part", async () => {
    const file = recording(129);
    readFile.mockReturnValue(file.slice(0, -1));
    const send = vi.fn();
    await expect(uploadImuFile("file", send)).rejects.toThrow("truncated");
    expect(send).not.toHaveBeenCalled();
    new DataView(file).setUint32(16, 130, true);
    readFile.mockReturnValue(file);
    await expect(uploadImuFile("file", send)).rejects.toThrow("count");
  });

  it("retains original legacy paired records and offsets", async () => {
    const header = createHeader({ sessionStartMs: 1000, sampleCount: 1, hasGyro: true });
    new DataView(header).setUint8(4, 1);
    const chunk = new ArrayBuffer(32);
    new DataView(chunk).setUint16(0, 1, true);
    readFile.mockReturnValue(concatArrayBuffers([header, chunk]));
    const send = vi.fn().mockResolvedValue({ ok: true });
    await uploadImuFile("file", send);
    expect(send).toHaveBeenCalledWith({
      data: Array.from(new Uint8Array(concatArrayBuffers([header, chunk]))),
      sampleOffset: 0,
    });
  });
});
