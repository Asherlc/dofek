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
  slot: "A",
  path: "data://imu/normal_a.bin",
  sampleCount: 120,
  observedHzX100: 2_500,
  hasGyroscope: true,
  accelFreqMode: 1,
  gyroFreqMode: 1,
  sessionStartMs: 1_720_000_000_000,
} satisfies Parameters<typeof savePendingImuTransfer>[1];

describe("pending IMU transfer storage", () => {
  const files = new Map<string, ArrayBuffer | string>();

  beforeEach(() => {
    vi.clearAllMocks();
    files.clear();
    vi.mocked(readFileSync).mockImplementation(({ path }) => {
      const value = files.get(path);
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return value;
    });
    vi.mocked(writeFileSync).mockImplementation(({ path, data }) => {
      files.set(path, data);
    });
    vi.mocked(renameSync).mockImplementation(({ oldPath, newPath }) => {
      const value = files.get(oldPath);
      if (value === undefined) return -1;
      files.set(newPath, value);
      files.delete(oldPath);
      return 0;
    });
  });

  it("persists completed slot metadata and restores it after restart", () => {
    savePendingImuTransfer("data://imu/normal_transfers.json", pending, vi.fn());

    expect(writeFileSync).toHaveBeenCalledWith({
      path: "data://imu/normal_transfers.json.tmp",
      data: JSON.stringify({ version: 1, pending: [pending] }),
    });
    expect(renameSync).toHaveBeenCalledWith({
      oldPath: "data://imu/normal_transfers.json.tmp",
      newPath: "data://imu/normal_transfers.json",
    });

    expect(readPendingImuTransfers("data://imu/normal_transfers.json")).toEqual([pending]);
  });

  it("restores the alternate file slot", () => {
    const pendingB = {
      ...pending,
      slot: "B",
      path: "data://imu/normal_b.bin",
    } satisfies Parameters<typeof savePendingImuTransfer>[1];
    files.set(
      "data://imu/normal_transfers.json",
      JSON.stringify({ version: 1, pending: [pendingB] }),
    );

    expect(readPendingImuTransfers("data://imu/normal_transfers.json")).toEqual([pendingB]);
  });

  it.each([
    null,
    [],
    "invalid",
    { ...pending, slot: "C" },
    { ...pending, path: 1 },
    { ...pending, path: " " },
    { ...pending, sampleCount: 1.5 },
    { ...pending, observedHzX100: 1.5 },
    { ...pending, hasGyroscope: "yes" },
    { ...pending, accelFreqMode: 1.5 },
    { ...pending, gyroFreqMode: 1.5 },
    { ...pending, sessionStartMs: 1.5 },
  ])("rejects invalid pending transfer metadata %#", (entry) => {
    files.set("data://imu/normal_transfers.json", JSON.stringify({ version: 1, pending: [entry] }));

    expect(() => readPendingImuTransfers("data://imu/normal_transfers.json")).toThrow(
      "Pending IMU transfer manifest is invalid.",
    );
  });

  it.each([
    "null",
    "[]",
    JSON.stringify({ version: 2, pending: [] }),
    JSON.stringify({ version: 1, pending: {} }),
  ])("rejects invalid manifest shape %#", (contents) => {
    files.set("data://imu/normal_transfers.json", contents);
    expect(() => readPendingImuTransfers("data://imu/normal_transfers.json")).toThrow(
      "Pending IMU transfer manifest is invalid.",
    );
  });

  it("returns an empty list only for a missing manifest", () => {
    expect(readPendingImuTransfers("data://imu/missing.json")).toEqual([]);

    const readError = new Error("storage unavailable");
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw readError;
    });
    expect(() => readPendingImuTransfers("data://imu/normal_transfers.json")).toThrow(readError);
  });

  it("clears only the acknowledged slot from the latest manifest", () => {
    const pendingB = {
      ...pending,
      slot: "B",
      path: "data://imu/normal_b.bin",
    } satisfies Parameters<typeof savePendingImuTransfer>[1];
    files.set(
      "data://imu/normal_transfers.json",
      JSON.stringify({ version: 1, pending: [pending, pendingB] }),
    );

    clearPendingImuTransfer("data://imu/normal_transfers.json", "A", vi.fn());

    expect(writeFileSync).toHaveBeenCalledWith({
      path: "data://imu/normal_transfers.json.tmp",
      data: JSON.stringify({ version: 1, pending: [pendingB] }),
    });
  });

  it("replaces only an older transfer in the same slot", () => {
    const pendingB = {
      ...pending,
      slot: "B",
      path: "data://imu/normal_b.bin",
    } satisfies Parameters<typeof savePendingImuTransfer>[1];
    const replacement = { ...pending, path: "data://imu/new_a.bin", sessionStartMs: 2 };
    files.set(
      "data://imu/normal_transfers.json",
      JSON.stringify({ version: 1, pending: [pending, pendingB] }),
    );

    savePendingImuTransfer("data://imu/normal_transfers.json", replacement, vi.fn());

    expect(readPendingImuTransfers("data://imu/normal_transfers.json")).toEqual([
      pendingB,
      replacement,
    ]);
  });

  it("applies in-memory slot state only after the manifest commit succeeds", () => {
    const apply = vi.fn();
    files.set(
      "data://imu/normal_transfers.json",
      JSON.stringify({ version: 1, pending: [pending] }),
    );
    vi.mocked(renameSync).mockReturnValueOnce(-1);

    expect(() =>
      persistAndApplyPendingImuTransfer(
        "data://imu/normal_transfers.json",
        "A",
        null,
        apply,
        vi.fn(),
      ),
    ).toThrow("Could not commit the pending IMU transfer manifest (-1).");
    expect(apply).not.toHaveBeenCalled();
  });

  it("replaces a corrupt manifest on the next mutation and reports the discarded state", () => {
    files.set("data://imu/normal_transfers.json", "not-json");
    const onDiscard = vi.fn();

    savePendingImuTransfer("data://imu/normal_transfers.json", pending, onDiscard);

    expect(onDiscard).toHaveBeenCalledOnce();
    expect(files.get("data://imu/normal_transfers.json.corrupt")).toBe("not-json");
    expect(readPendingImuTransfers("data://imu/normal_transfers.json")).toEqual([pending]);
  });

  it("fails loudly when a corrupt manifest cannot be quarantined", () => {
    files.set("data://imu/normal_transfers.json", "not-json");
    vi.mocked(renameSync).mockReturnValueOnce(-1);
    const onDiscard = vi.fn();

    expect(() =>
      savePendingImuTransfer("data://imu/normal_transfers.json", pending, onDiscard),
    ).toThrow("Could not quarantine the corrupt IMU transfer manifest (-1).");
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it("persists before applying both present and cleared in-memory state", () => {
    const apply = vi.fn();

    persistAndApplyPendingImuTransfer(
      "data://imu/normal_transfers.json",
      "A",
      pending,
      apply,
      vi.fn(),
    );
    persistAndApplyPendingImuTransfer(
      "data://imu/normal_transfers.json",
      "A",
      null,
      apply,
      vi.fn(),
    );

    expect(apply).toHaveBeenNthCalledWith(1, pending);
    expect(apply).toHaveBeenNthCalledWith(2, null);
    expect(readPendingImuTransfers("data://imu/normal_transfers.json")).toEqual([]);
  });

  it("rejects non-text manifest reads", () => {
    files.set("data://imu/normal_transfers.json", new ArrayBuffer(1));

    expect(() => readPendingImuTransfers("data://imu/normal_transfers.json")).toThrow(
      "Pending IMU transfer manifest is invalid.",
    );
  });
});
