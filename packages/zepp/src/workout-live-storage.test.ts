import { readFileSync, writeFileSync } from "@zos/fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLiveWorkoutBuffer,
  readLiveWorkoutBuffer,
  removeUploadedLiveWorkoutSnapshots,
  writeLiveWorkoutBuffer,
} from "./workout-live-storage.ts";

vi.mock("@zos/fs", () => ({ readFileSync: vi.fn(), writeFileSync: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseLiveWorkoutBuffer", () => {
  it("parses a durable live workout buffer", () => {
    const snapshot = {
      recordedAt: "2024-07-03T09:51:52.000Z",
      heartRate: 148,
      metrics: { duration: 312, speed: 3.5 },
    };
    expect(
      parseLiveWorkoutBuffer(
        JSON.stringify({
          batches: [
            { externalId: "1720000000", snapshots: [snapshot] },
            {
              externalId: "1720003600",
              snapshots: [{ ...snapshot, recordedAt: "2024-07-03T10:51:52.000Z" }],
            },
          ],
        }),
      ),
    ).toEqual({
      batches: [
        { externalId: "1720000000", snapshots: [snapshot] },
        {
          externalId: "1720003600",
          snapshots: [{ ...snapshot, recordedAt: "2024-07-03T10:51:52.000Z" }],
        },
      ],
    });
  });

  it("returns an empty buffer for malformed data", () => {
    expect(parseLiveWorkoutBuffer("not-json")).toEqual({ batches: [] });
    expect(parseLiveWorkoutBuffer("{}")).toEqual({ batches: [] });
    expect(parseLiveWorkoutBuffer('{"batches":"invalid"}')).toEqual({ batches: [] });
  });

  it("filters malformed batches, snapshots, and metric values", () => {
    expect(
      parseLiveWorkoutBuffer(
        JSON.stringify({
          batches: [
            null,
            {},
            { externalId: 1, snapshots: [] },
            { externalId: "missing-snapshots" },
            {
              externalId: "valid",
              snapshots: [
                null,
                {},
                { recordedAt: 123, metrics: {} },
                { recordedAt: "missing-metrics" },
                {
                  recordedAt: "now",
                  heartRate: "148",
                  metrics: { speed: 3.5, pace: "invalid" },
                },
              ],
            },
          ],
        }),
      ),
    ).toEqual({
      batches: [
        {
          externalId: "valid",
          snapshots: [{ recordedAt: "now", heartRate: undefined, metrics: { speed: 3.5 } }],
        },
      ],
    });
  });

  it("preserves snapshots collected while an older upload is in flight", () => {
    const uploadedSnapshot = {
      recordedAt: "2024-07-03T09:51:52.000Z",
      metrics: { duration: 312 },
    };
    const newlyCollectedSnapshot = {
      recordedAt: "2024-07-03T09:52:02.000Z",
      metrics: { duration: 322 },
    };
    const otherWorkoutSnapshot = {
      recordedAt: "2024-07-03T10:51:52.000Z",
      metrics: { duration: 120 },
    };

    expect(
      removeUploadedLiveWorkoutSnapshots(
        {
          batches: [
            {
              externalId: "1720000000",
              snapshots: [uploadedSnapshot, newlyCollectedSnapshot],
            },
            { externalId: "1720003600", snapshots: [otherWorkoutSnapshot] },
          ],
        },
        "1720000000",
        [uploadedSnapshot],
      ),
    ).toEqual({
      batches: [
        { externalId: "1720000000", snapshots: [newlyCollectedSnapshot] },
        { externalId: "1720003600", snapshots: [otherWorkoutSnapshot] },
      ],
    });
  });

  it("removes an empty uploaded batch and leaves unrelated batches unchanged", () => {
    const snapshot = { recordedAt: "now", metrics: {} };
    const unrelatedBatch = { externalId: "other", snapshots: [snapshot] };
    expect(
      removeUploadedLiveWorkoutSnapshots(
        { batches: [{ externalId: "target", snapshots: [snapshot] }, unrelatedBatch] },
        "target",
        [snapshot],
      ),
    ).toEqual({ batches: [unrelatedBatch] });
  });

  it("reads, writes, and safely recovers from storage failures", () => {
    vi.mocked(readFileSync).mockReturnValueOnce('{"batches":[]}');
    expect(readLiveWorkoutBuffer()).toEqual({ batches: [] });
    expect(readFileSync).toHaveBeenCalledWith({
      path: "data://workout/live.json",
      options: { encoding: "utf8" },
    });

    vi.mocked(readFileSync).mockReturnValueOnce(new ArrayBuffer(0));
    expect(readLiveWorkoutBuffer()).toEqual({ batches: [] });
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("unavailable");
    });
    expect(readLiveWorkoutBuffer()).toEqual({ batches: [] });

    const buffer = { batches: [{ externalId: "id", snapshots: [] }] };
    writeLiveWorkoutBuffer(buffer);
    expect(writeFileSync).toHaveBeenCalledWith({
      path: "data://workout/live.json",
      data: JSON.stringify(buffer),
    });
  });
});
