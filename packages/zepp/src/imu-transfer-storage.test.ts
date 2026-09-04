import { readFileSync, renameSync, writeFileSync } from "@zos/fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingImuTransfer,
  persistAndApplyPendingImuTransfer,
  readPendingImuTransfers,
  savePendingImuTransfer,
} from "./imu-transfer-storage.ts";

vi.mock("@zos/fs", () => ({
  readFileSync: vi.fn(),
  renameSync: vi.fn(() => 0),
  writeFileSync: vi.fn(),
}));

const pending = {
  slot: "A" as const,
  path: "data://imu/normal_a.bin",
  sampleCount: 120,
  observedHzX100: 2_500,
  hasGyroscope: true,
  accelFreqMode: 1,
  gyroFreqMode: 1,
  sessionStartMs: 1_720_000_000_000,
};

describe("pending IMU transfer storage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists completed slot metadata and restores it after restart", () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    savePendingImuTransfer("data://imu/normal_transfers.json", pending);

    expect(writeFileSync).toHaveBeenCalledWith({
      path: "data://imu/normal_transfers.json.tmp",
      data: JSON.stringify({ version: 1, pending: [pending] }),
    });
    expect(renameSync).toHaveBeenCalledWith({
      oldPath: "data://imu/normal_transfers.json.tmp",
      newPath: "data://imu/normal_transfers.json",
    });

    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify({ version: 1, pending: [pending] }));
    expect(readPendingImuTransfers("data://imu/normal_transfers.json")).toEqual([pending]);
  });

  it("clears only the acknowledged slot from the latest manifest", () => {
    const pendingB = { ...pending, slot: "B" as const, path: "data://imu/normal_b.bin" };
    vi.mocked(readFileSync).mockReturnValueOnce(
      JSON.stringify({ version: 1, pending: [pending, pendingB] }),
    );

    clearPendingImuTransfer("data://imu/normal_transfers.json", "A");

    expect(writeFileSync).toHaveBeenCalledWith({
      path: "data://imu/normal_transfers.json.tmp",
      data: JSON.stringify({ version: 1, pending: [pendingB] }),
    });
  });

  it("applies in-memory slot state only after the manifest commit succeeds", () => {
    const apply = vi.fn();
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify({ version: 1, pending: [pending] }));
    vi.mocked(renameSync).mockReturnValueOnce(-1);

    expect(() =>
      persistAndApplyPendingImuTransfer("data://imu/normal_transfers.json", "A", null, apply),
    ).toThrow("Could not commit the pending IMU transfer manifest (-1).");
    expect(apply).not.toHaveBeenCalled();
  });
});
