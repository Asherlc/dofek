import { describe, expect, it, vi } from "vitest";
import { createMetricStreamEvent, type MetricStreamRowInput } from "./events.ts";
import type { MetricStreamEventPublisher } from "./redpanda-producer.ts";
import { writeMetricStreamRows } from "./write-metric-stream.ts";

const metricStreamRows: MetricStreamRowInput[] = [
  {
    recordedAt: "2026-06-06T19:00:00.000Z",
    userId: "00000000-0000-0000-0000-000000000001",
    providerId: "apple_health",
    externalId: "hk:heart-rate-1",
    deviceId: "Apple Watch",
    sourceType: "api",
    channel: "heart_rate",
    scalar: 72,
  },
];

function makePublisher(): MetricStreamEventPublisher {
  return {
    publishRows: vi.fn(async (rows: readonly MetricStreamRowInput[]) =>
      rows.map((row) => createMetricStreamEvent(row)),
    ),
  };
}

describe("writeMetricStreamRows", () => {
  it("publishes rows through the supplied Redpanda publisher", async () => {
    const publisher = makePublisher();
    const database = { execute: vi.fn().mockResolvedValue([{ generation: "4" }]) };

    const result = await writeMetricStreamRows({
      database,
      publisher,
      rows: metricStreamRows,
    });

    expect(publisher.publishRows).toHaveBeenCalledWith([
      expect.objectContaining({ generation: 4 }),
    ]);
    expect(result.published).toBe(1);
    expect(result.events[0]?.channel).toBe("heart_rate");
    expect(result.events[0]?.generation).toBe(4);
  });

  it("loads the provider generation before publishing", async () => {
    const publisher = makePublisher();
    const database = { execute: vi.fn().mockResolvedValue([]) };

    await writeMetricStreamRows({
      database,
      publisher,
      rows: metricStreamRows,
    });

    expect(database.execute).toHaveBeenCalledTimes(1);
    expect(publisher.publishRows).toHaveBeenCalledTimes(1);
  });
});
