import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("./index");

const { mockGetPendingWatchFileNames } = vi.hoisted(() => ({
  mockGetPendingWatchFileNames: vi.fn<() => string[]>(),
}));

vi.mock("./src/WatchMotionModule", () => ({
  default: {
    getPendingWatchFileNames: mockGetPendingWatchFileNames,
  },
}));

import { getPendingWatchAltitudeFileNames, getPendingWatchFileNames } from "./index";

describe("pending Watch file classification", () => {
  beforeEach(() => {
    mockGetPendingWatchFileNames.mockReset();
  });

  it("separates accelerometer and altitude files from a mixed pending directory", () => {
    mockGetPendingWatchFileNames.mockReturnValue([
      "watch-accel-001.json.gz",
      "watch-altitude-001.json.gz",
      "corrupt-transfer.json.gz",
      "watch-accel-002.json.gz",
      "watch-altitude-002.json.gz",
    ]);

    expect(getPendingWatchFileNames()).toEqual([
      "watch-accel-001.json.gz",
      "watch-accel-002.json.gz",
    ]);
    expect(getPendingWatchAltitudeFileNames()).toEqual([
      "watch-altitude-001.json.gz",
      "watch-altitude-002.json.gz",
    ]);
  });
});
