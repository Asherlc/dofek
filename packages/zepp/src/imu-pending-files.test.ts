import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  openSync: vi.fn(() => 7),
  closeSync: vi.fn(),
}));
vi.mock("@zos/fs", () => ({ ...mocks, O_RDWR: 2, O_CREAT: 8 }));

import { readPendingImuFiles, writePendingImuFiles } from "./imu-pending-files.ts";

beforeEach(() => vi.clearAllMocks());
it("restores both unacknowledged file slots across restart", () => {
  const files = [
    { slot: "A" as const, sampleCount: 128, observedHzX100: 2500 },
    { slot: "B" as const, sampleCount: 64, observedHzX100: 2600 },
  ];
  writePendingImuFiles(files);
  const serialized = mocks.writeFileSync.mock.calls[0]?.[0].data;
  mocks.readFileSync.mockReturnValue(serialized);
  expect(readPendingImuFiles()).toEqual(files);
});
it("creates a first-use journal without truncating an existing one", () => {
  mocks.readFileSync.mockReturnValue("");
  expect(readPendingImuFiles()).toEqual([]);
  expect(mocks.openSync).toHaveBeenCalledWith({ path: "data://imu/pending.json", flag: 10 });
  expect(mocks.closeSync).toHaveBeenCalledWith({ fd: 7 });
});
it("fails loudly on corrupt pending state instead of overwriting sessions", () => {
  mocks.readFileSync.mockReturnValue('[{"slot":"C","sampleCount":1}]');
  expect(() => readPendingImuFiles()).toThrow("pending");
  mocks.readFileSync.mockImplementation(() => {
    throw new Error("disk failure");
  });
  expect(() => readPendingImuFiles()).toThrow("disk failure");
});

it("preserves bound account identity and rejects malformed bindings", () => {
  const file = {
    slot: "A",
    sampleCount: 2,
    observedHzX100: 100,
    connection: { serverUrl: "https://dofek.example", accountId: "account-a" },
  };
  mocks.readFileSync.mockReturnValue(JSON.stringify([file]));
  expect(readPendingImuFiles()).toEqual([file]);
  mocks.readFileSync.mockReturnValue(
    JSON.stringify([{ ...file, connection: { serverUrl: "https://dofek.example" } }]),
  );
  expect(() => readPendingImuFiles()).toThrow("pending");
});
