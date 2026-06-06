import { describe, expect, it, vi } from "vitest";
import { createMetricStreamEvent } from "./events.ts";
import { runMetricStreamEventConsumer } from "./redpanda-consumer.ts";

const event = createMetricStreamEvent({
  id: "10000000-0000-4000-8000-000000000001",
  recordedAt: "2026-06-06T19:00:00.000Z",
  userId: "00000000-0000-0000-0000-000000000001",
  providerId: "apple_health",
  externalId: "hk:heart-rate-1",
  deviceId: "Apple Watch",
  sourceType: "api",
  channel: "heart_rate",
  scalar: 72,
});

describe("runMetricStreamEventConsumer", () => {
  it("subscribes to the metric stream topic and handles parsed events before resolving offsets", async () => {
    const connect = vi.fn(async () => undefined);
    const subscribe = vi.fn(async () => undefined);
    const resolveOffset = vi.fn();
    const heartbeat = vi.fn(async () => undefined);
    const commitOffsetsIfNecessary = vi.fn(async () => undefined);
    const handleEvents = vi.fn(async () => undefined);
    const consumer = {
      connect,
      subscribe,
      run: vi.fn(async (options) => {
        await options.eachBatch({
          batch: {
            messages: [
              {
                offset: "12",
                value: Buffer.from(JSON.stringify(event)),
              },
            ],
          },
          commitOffsetsIfNecessary,
          heartbeat,
          resolveOffset,
        });
      }),
    };

    await runMetricStreamEventConsumer({
      consumer,
      handleEvents,
      topic: "metric-stream-v1",
    });

    expect(connect).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledWith({ topic: "metric-stream-v1", fromBeginning: false });
    expect(handleEvents).toHaveBeenCalledWith([event]);
    expect(resolveOffset).toHaveBeenCalledWith("12");
    expect(commitOffsetsIfNecessary).toHaveBeenCalled();
  });

  it("does not resolve offsets when the handler fails", async () => {
    const resolveOffset = vi.fn();
    const handleEvents = vi.fn(async () => {
      throw new Error("sink failed");
    });
    const consumer = {
      connect: vi.fn(async () => undefined),
      subscribe: vi.fn(async () => undefined),
      run: vi.fn(async (options) => {
        await options.eachBatch({
          batch: {
            messages: [
              {
                offset: "12",
                value: Buffer.from(JSON.stringify(event)),
              },
            ],
          },
          commitOffsetsIfNecessary: vi.fn(async () => undefined),
          heartbeat: vi.fn(async () => undefined),
          resolveOffset,
        });
      }),
    };

    await expect(
      runMetricStreamEventConsumer({
        consumer,
        handleEvents,
        topic: "metric-stream-v1",
      }),
    ).rejects.toThrow("sink failed");

    expect(resolveOffset).not.toHaveBeenCalled();
  });
});
