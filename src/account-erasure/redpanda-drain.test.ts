import { describe, expect, it, vi } from "vitest";
import {
  assertAccountErasureConsumersDrained,
  assertAccountErasureQuarantineExpired,
  assertAccountErasureReplayExpired,
  captureAccountErasureHighWatermarks,
  captureAccountErasureQuarantineHighWatermarks,
  createAccountErasureRedpandaAdminFromEnv,
} from "./redpanda-drain.ts";

describe("account erasure Redpanda drain", () => {
  it("fails worker startup when the metric-stream topic is missing", () => {
    expect(() =>
      createAccountErasureRedpandaAdminFromEnv({
        REDPANDA_BROKERS: "redpanda-1:9092",
      }),
    ).toThrow("METRIC_STREAM_TOPIC is required for account erasure");
  });

  it("fails worker startup when Redpanda brokers are missing", () => {
    expect(() =>
      createAccountErasureRedpandaAdminFromEnv({
        METRIC_STREAM_TOPIC: "metric-stream-v1",
      }),
    ).toThrow("REDPANDA_BROKERS is required for account erasure");
  });

  it("captures each topic partition high watermark in order", async () => {
    const admin = {
      fetchOffsets: vi.fn(),
      fetchTopicOffsets: vi.fn(async () => [
        { partition: 2, offset: "30", high: "30", low: "4" },
        { partition: 0, offset: "10", high: "10", low: "2" },
      ]),
    };

    await expect(captureAccountErasureHighWatermarks(admin, "metric-stream-v1")).resolves.toEqual([
      { partition: 0, offset: "10", low: "2" },
      { partition: 2, offset: "30", low: "4" },
    ]);
  });

  it("captures the quarantine boundary only with the exact bounded-retention policy", async () => {
    const admin = {
      describeConfigs: vi.fn(async () => ({
        resources: [
          {
            configEntries: [
              { configName: "cleanup.policy", configValue: "delete" },
              { configName: "retention.ms", configValue: "604800000" },
              { configName: "retention.bytes", configValue: "1073741824" },
            ],
            errorCode: 0,
            errorMessage: "",
            resourceName: "metric-stream-v1.quarantine.v1",
            resourceType: 2,
          },
        ],
        throttleTime: 0,
      })),
      fetchOffsets: vi.fn(),
      fetchTopicOffsets: vi.fn(async (topic: string) => {
        expect(topic).toBe("metric-stream-v1.quarantine.v1");
        return [{ partition: 0, offset: "12", high: "12", low: "4" }];
      }),
    };

    await expect(
      captureAccountErasureQuarantineHighWatermarks(admin, "metric-stream-v1"),
    ).resolves.toEqual([{ partition: 0, offset: "12", low: "4" }]);
    expect(admin.describeConfigs).toHaveBeenCalledWith({
      includeSynonyms: false,
      resources: [
        {
          configNames: ["cleanup.policy", "retention.ms", "retention.bytes"],
          name: "metric-stream-v1.quarantine.v1",
          type: 2,
        },
      ],
    });
  });

  it("fails closed when quarantine retention configuration drifts", async () => {
    const admin = {
      describeConfigs: vi.fn(async () => ({
        resources: [
          {
            configEntries: [
              { configName: "cleanup.policy", configValue: "delete" },
              { configName: "retention.ms", configValue: "2592000000" },
              { configName: "retention.bytes", configValue: "1073741824" },
            ],
            errorCode: 0,
            errorMessage: "",
            resourceName: "metric-stream-v1.quarantine.v1",
            resourceType: 2,
          },
        ],
        throttleTime: 0,
      })),
      fetchOffsets: vi.fn(),
      fetchTopicOffsets: vi.fn(),
    };

    await expect(
      captureAccountErasureQuarantineHighWatermarks(admin, "metric-stream-v1"),
    ).rejects.toThrow("retention.ms");
    expect(admin.fetchTopicOffsets).not.toHaveBeenCalled();
  });

  it("requires every serving and archive consumer offset to reach the fence", async () => {
    const fetchOffsets = vi.fn(async ({ groupId }: { groupId: string }) => [
      {
        topic: "metric-stream-v1",
        partitions: [
          { partition: 0, offset: "10" },
          {
            partition: 1,
            offset: groupId === "metric-stream-r2-archive" ? "19" : "20",
          },
        ],
      },
    ]);
    const admin = { fetchOffsets, fetchTopicOffsets: vi.fn() };

    await expect(
      assertAccountErasureConsumersDrained(admin, "metric-stream-v1", [
        { partition: 0, offset: "10", low: "0" },
        { partition: 1, offset: "20", low: "0" },
      ]),
    ).rejects.toThrow("metric-stream-r2-archive partition(s): 1");
  });

  it("treats an uncommitted empty partition as drained", async () => {
    const admin = {
      fetchOffsets: vi.fn(async () => [
        {
          topic: "metric-stream-v1",
          partitions: [{ partition: 4, offset: "-1" }],
        },
      ]),
      fetchTopicOffsets: vi.fn(),
    };

    await expect(
      assertAccountErasureConsumersDrained(admin, "metric-stream-v1", [
        { partition: 4, offset: "12", low: "12" },
      ]),
    ).resolves.toBeUndefined();
  });

  it("rejects finalization while any captured record remains in the replay log", async () => {
    const admin = {
      fetchOffsets: vi.fn(),
      fetchTopicOffsets: vi.fn(async () => [
        { partition: 0, offset: "15", high: "15", low: "9" },
        { partition: 1, offset: "25", high: "25", low: "20" },
      ]),
    };

    await expect(
      assertAccountErasureReplayExpired(admin, "metric-stream-v1", [
        { partition: 0, offset: "10", low: "2" },
        { partition: 1, offset: "20", low: "4" },
      ]),
    ).rejects.toThrow("replay data remains in partition(s): 0");
  });

  it("accepts finalization only when every low watermark reaches the captured next offset", async () => {
    const admin = {
      fetchOffsets: vi.fn(),
      fetchTopicOffsets: vi.fn(async () => [
        { partition: 0, offset: "15", high: "15", low: "10" },
        { partition: 1, offset: "25", high: "25", low: "21" },
      ]),
    };

    await expect(
      assertAccountErasureReplayExpired(admin, "metric-stream-v1", [
        { partition: 0, offset: "10", low: "2" },
        { partition: 1, offset: "20", low: "4" },
      ]),
    ).resolves.toBeUndefined();
  });

  it("blocks final retention verification while a pre-boundary quarantine payload remains", async () => {
    const admin = {
      describeConfigs: vi.fn(async () => ({
        resources: [
          {
            configEntries: [
              { configName: "cleanup.policy", configValue: "delete" },
              { configName: "retention.ms", configValue: "604800000" },
              { configName: "retention.bytes", configValue: "1073741824" },
            ],
            errorCode: 0,
            errorMessage: "",
            resourceName: "metric-stream-v1.quarantine.v1",
            resourceType: 2,
          },
        ],
        throttleTime: 0,
      })),
      fetchOffsets: vi.fn(),
      fetchTopicOffsets: vi.fn(async () => [{ partition: 0, offset: "15", high: "15", low: "11" }]),
    };

    await expect(
      assertAccountErasureQuarantineExpired(admin, "metric-stream-v1", [
        { partition: 0, offset: "12", low: "4" },
      ]),
    ).rejects.toThrow("quarantine data remains in partition(s): 0");
  });

  it("proves every pre-boundary quarantine payload is physically absent", async () => {
    const admin = {
      describeConfigs: vi.fn(async () => ({
        resources: [
          {
            configEntries: [
              { configName: "cleanup.policy", configValue: "delete" },
              { configName: "retention.ms", configValue: "604800000" },
              { configName: "retention.bytes", configValue: "1073741824" },
            ],
            errorCode: 0,
            errorMessage: "",
            resourceName: "metric-stream-v1.quarantine.v1",
            resourceType: 2,
          },
        ],
        throttleTime: 0,
      })),
      fetchOffsets: vi.fn(),
      fetchTopicOffsets: vi.fn(async () => [{ partition: 0, offset: "15", high: "15", low: "12" }]),
    };

    await expect(
      assertAccountErasureQuarantineExpired(admin, "metric-stream-v1", [
        { partition: 0, offset: "12", low: "4" },
      ]),
    ).resolves.toBeUndefined();
  });
});
