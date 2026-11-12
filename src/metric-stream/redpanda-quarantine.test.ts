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

function describedConfig(): {
  resources: [
    {
      resourceName: string;
      resourceType: number;
      errorCode: number;
      errorMessage: string | null;
      configEntries: Array<{ configName: string; configValue: string | null }>;
    },
  ];
  throttleTime: number;
} {
  return {
    resources: [
      {
        resourceName: "metric-stream-v1.quarantine.v1",
        resourceType: 2,
        errorCode: 0,
        errorMessage: null,
        configEntries: [
          { configName: "cleanup.policy", configValue: "delete" },
          { configName: "retention.ms", configValue: "604800000" },
          { configName: "retention.bytes", configValue: "1073741824" },
        ],
      },
    ],
    throttleTime: 0,
  };
}

function startup(response: unknown = describedConfig()) {
  const admin = {
    describeConfigs: vi.fn(async () => response),
    connect: vi.fn(async () => undefined),
    createTopics: vi.fn(async () => false),
    disconnect: vi.fn(async () => undefined),
  };
  const producer = {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    send: vi.fn(async (_request: QuarantineSendRequest) => undefined),
  };
  const writer = new KafkaMetricStreamQuarantineWriter({
    admin,
    producer,
    sourceTopic: "metric-stream-v1",
  });
  return { admin, producer, writer };
}

describe("KafkaMetricStreamQuarantineWriter", () => {
  it("connects the producer only after checking the exact quarantine policy", async () => {
    const { admin, producer, writer } = startup();
    await writer.connect();
    expect(admin.describeConfigs).toHaveBeenCalledWith({
      includeSynonyms: false,
      resources: [
        {
          name: "metric-stream-v1.quarantine.v1",
          type: 2,
          configNames: ["cleanup.policy", "retention.ms", "retention.bytes"],
        },
      ],
    });
    expect(producer.connect).toHaveBeenCalledOnce();
    expect(admin.disconnect).toHaveBeenCalledOnce();
  });

  it("disconnects the Kafka producer through the writer lifecycle", async () => {
    const { producer, writer } = startup();
    await writer.disconnect();
    expect(producer.disconnect).toHaveBeenCalledOnce();
  });

  it.each([
    ["cleanup.policy", "compact,delete"],
    ["retention.ms", "-1"],
    ["retention.bytes", "-1"],
    ["retention.ms", null],
  ])("rejects invalid %s without connecting the producer", async (name, value) => {
    const response = describedConfig();
    for (const entry of response.resources[0].configEntries) {
      if (entry.configName === name) entry.configValue = value;
    }
    const { admin, producer, writer } = startup(response);
    await expect(writer.connect()).rejects.toThrow(`found ${String(value)}`);
    expect(producer.connect).not.toHaveBeenCalled();
    expect(admin.disconnect).toHaveBeenCalledOnce();
  });

  it.each(["missing", "duplicate"])("rejects a %s required configuration entry", async (kind) => {
    const response = describedConfig();
    if (kind === "missing") response.resources[0].configEntries.pop();
    else
      response.resources[0].configEntries.push({
        configName: "retention.bytes",
        configValue: "1073741824",
      });
    const { admin, producer, writer } = startup(response);
    await expect(writer.connect()).rejects.toThrow(
      kind === "missing" ? "found missing" : "duplicate retention.bytes",
    );
    expect(producer.connect).not.toHaveBeenCalled();
    expect(admin.disconnect).toHaveBeenCalledOnce();
  });

  it.each(["missing", "wrong topic", "wrong type", "duplicate", "broker error", "malformed"])(
    "fails closed on a %s DescribeConfigs resource",
    async (kind) => {
      const response = describedConfig();
      const resource = response.resources[0];
      if (kind === "missing") response.resources.splice(0);
      if (kind === "wrong topic") resource.resourceName = "another.quarantine.v1";
      if (kind === "wrong type") resource.resourceType = 4;
      if (kind === "duplicate") response.resources.push(resource);
      if (kind === "broker error") {
        resource.errorCode = 29;
        resource.errorMessage = "Topic authorization failed";
      }
      const { admin, producer, writer } = startup(kind === "malformed" ? null : response);
      await expect(writer.connect()).rejects.toThrow(
        "could not verify quarantine topic metric-stream-v1.quarantine.v1",
      );
      expect(producer.connect).not.toHaveBeenCalled();
      expect(admin.disconnect).toHaveBeenCalledOnce();
    },
  );

  it("retains the parse failure cause for a malformed configuration response", async () => {
    const { writer } = startup(null);
    await expect(writer.connect()).rejects.toMatchObject({
      cause: expect.any(Error),
      message: expect.stringContaining("malformed DescribeConfigs response"),
    });
  });

  it.each([null, "Topic authorization failed"])(
    "reports broker errors with detail %s",
    async (message) => {
      const response = describedConfig();
      response.resources[0].errorCode = 29;
      response.resources[0].errorMessage = message;
      const { writer } = startup(response);
      await expect(writer.connect()).rejects.toThrow(message ?? "broker error 29");
    },
  );

  it("disconnects admin and propagates creation failure without starting the producer", async () => {
    const { admin, producer, writer } = startup();
    admin.createTopics.mockRejectedValueOnce(new Error("Topic authorization failed"));
    await expect(writer.connect()).rejects.toThrow("Topic authorization failed");
    expect(admin.disconnect).toHaveBeenCalledOnce();
    expect(producer.connect).not.toHaveBeenCalled();
  });

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
      disconnect: vi.fn(async () => undefined),
      send: vi.fn(async (_request: QuarantineSendRequest) => undefined),
    };
    const writer = new KafkaMetricStreamQuarantineWriter({
      admin: {
        describeConfigs: vi.fn(async () => describedConfig()),
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
      disconnect: vi.fn(async () => undefined),
      send: vi.fn(async (_request: QuarantineSendRequest) => undefined),
    };
    const writer = new KafkaMetricStreamQuarantineWriter({
      admin: {
        describeConfigs: vi.fn(async () => describedConfig()),
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
