import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { KafkaMetricStreamQuarantineWriter } from "./redpanda-quarantine.ts";

interface QuarantineSendRequest {
  acks: -1;
  messages: {
    headers: Record<string, string>;
    key: string;
    value: Buffer;
  }[];
  topic: string;
}

describe("KafkaMetricStreamQuarantineWriter", () => {
  it("loads through Node's native ESM loader", () => {
    const moduleUrl = new URL("./redpanda-quarantine.ts", import.meta.url);
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--enable-source-maps",
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(moduleUrl.href)})`,
      ],
      { encoding: "utf8" },
    );

    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
  });

  it("stores full replay context with all-replica acknowledgement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T00:00:00.000Z"));
    const producer = {
      connect: vi.fn(async () => undefined),
      send: vi.fn(async (_request: QuarantineSendRequest) => undefined),
    };
    const writer = new KafkaMetricStreamQuarantineWriter({
      admin: {
        alterConfigs: vi.fn(async () => undefined),
        connect: vi.fn(async () => undefined),
        createTopics: vi.fn(async () => true),
        disconnect: vi.fn(async () => undefined),
      },
      producer,
      sourceTopic: "metric-stream-v1",
    });

    await writer.write({
      error: new Error("invalid event"),
      offset: "14",
      partition: 2,
      payload: Buffer.from("{not-json"),
      topic: "metric-stream-v1",
    });

    expect(producer.send).toHaveBeenCalledWith({
      acks: -1,
      messages: [
        {
          headers: {
            "dofek-error-message": "invalid event",
            "dofek-error-name": "Error",
            "dofek-quarantine-version": "1",
            "dofek-quarantined-at": "2026-07-25T00:00:00.000Z",
            "dofek-source-offset": "14",
            "dofek-source-partition": "2",
            "dofek-source-topic": "metric-stream-v1",
          },
          key: "metric-stream-v1:2:14",
          value: Buffer.from("{not-json"),
        },
      ],
      topic: "metric-stream-v1.quarantine.v1",
    });
    vi.useRealTimers();
  });

  it("serializes non-Error parse failures without losing their reason", async () => {
    const producer = {
      connect: vi.fn(async () => undefined),
      send: vi.fn(async (_request: QuarantineSendRequest) => undefined),
    };
    const writer = new KafkaMetricStreamQuarantineWriter({
      admin: {
        alterConfigs: vi.fn(async () => undefined),
        connect: vi.fn(async () => undefined),
        createTopics: vi.fn(async () => true),
        disconnect: vi.fn(async () => undefined),
      },
      producer,
      sourceTopic: "metric-stream-v1",
    });

    await writer.write({
      error: "invalid event",
      offset: "14",
      partition: 2,
      payload: Buffer.from("bad"),
      topic: "metric-stream-v1",
    });

    const request = producer.send.mock.calls[0]?.[0];
    expect(request).toBeDefined();
    expect(request?.messages[0]?.headers).toMatchObject({
      "dofek-error-message": "invalid event",
      "dofek-error-name": "NonError",
    });
  });
});
