import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { resolveMetricStreamConsumerRoutes } from "./consumer-routes.ts";
import {
  type AccountErasureNativeFence,
  assertAccountErasureSubscriptionsDrained,
  captureAccountErasureNativeFenceProgress,
  createPulsarDrainAdminFromUrls,
  type PulsarDrainAdmin,
  resolveAccountErasureNativeDrainStreams,
} from "./pulsar-drain.ts";

const stream = {
  epoch: "epoch-1",
  topic: "persistent://public/default/sensor",
  partition: -1,
} as const;

const adminBase = "http://pulsar-admin.test";
const topicBase = "/admin/v2/persistent/public/default/sensor";
const lastMessageIdPath = `${topicBase}/lastMessageId`;
const internalStatsPath = `${topicBase}/internalStats`;
const MAX_ADMIN_RESPONSE_BYTES = 8 * 1024 * 1024;

function fenceMessage(delivery: {
  major: string;
  minor: string;
  batch: number;
}): AccountErasureNativeFence {
  return {
    transport: "pulsar",
    state: "message",
    ...stream,
    delivery,
  };
}

function createMockAdmin(
  overrides: Partial<{
    lastMessageId: unknown;
    internalStatsSequential: unknown[];
    internalStatsError: Error;
    topicPartitionsByTopic: Record<string, unknown>;
    onSignal?: (signal: AbortSignal) => void;
  }> = {},
): PulsarDrainAdmin {
  const statsQueue = [...(overrides.internalStatsSequential ?? [])];
  const note = (signal: AbortSignal) => {
    overrides.onSignal?.(signal);
  };
  return {
    async getLastMessageId(_topic, signal) {
      note(signal);
      if (overrides.lastMessageId !== undefined) return overrides.lastMessageId;
      throw new Error("lastMessageId unused");
    },
    async getInternalStats(_topic, signal) {
      note(signal);
      if (overrides.internalStatsError) throw overrides.internalStatsError;
      if (statsQueue.length > 0) return statsQueue.shift();
      throw new Error("internalStats unused");
    },
    async getTopicPartitions(topic, signal) {
      note(signal);
      const metadata = overrides.topicPartitionsByTopic?.[topic];
      if (metadata !== undefined) return metadata;
      throw new Error(`topic partitions unused for ${topic}`);
    },
  };
}

function drainAdmin(options: {
  internalStats?: unknown;
  internalStatsError?: Error;
}): PulsarDrainAdmin {
  return createMockAdmin({
    lastMessageId: { ledgerId: "1", entryId: "0", partitionIndex: -1, batchIndex: -1 },
    internalStatsSequential: options.internalStats === undefined ? [] : [options.internalStats],
    internalStatsError: options.internalStatsError,
  });
}

describe("createPulsarDrainAdminFromUrls + captureAccountErasureNativeFenceProgress", () => {
  const server = setupServer();
  beforeAll(() => {
    server.listen({ onUnhandledFrame: failOnUnhandledExternalRequest });
  });
  afterEach(() => {
    server.resetHandlers();
  });
  afterAll(() => {
    server.close();
  });

  it("preserves int64 ledger coordinates from JSON source text", async () => {
    server.use(
      http.get(`${adminBase}${lastMessageIdPath}`, () =>
        HttpResponse.text(
          '{"ledgerId":9223372036854775807,"entryId":-1,"partitionIndex":-1,"batchIndex":-1}',
          { headers: { "Content-Type": "application/json" } },
        ),
      ),
      http.get(`${adminBase}${internalStatsPath}`, () => HttpResponse.json({ ledgers: [] })),
    );
    const admin = createPulsarDrainAdminFromUrls({ adminUrl: adminBase });
    await expect(captureAccountErasureNativeFenceProgress(admin, stream)).resolves.toEqual({
      fence: { transport: "pulsar", state: "empty", ...stream },
    });
  });

  it("captures message fences from decimal source text", async () => {
    server.use(
      http.get(`${adminBase}${lastMessageIdPath}`, () =>
        HttpResponse.text(
          '{"ledgerId":55,"entryId":0,"partitionIndex":-1,"batchIndex":-1,"batchSize":0}',
          { headers: { "Content-Type": "application/json" } },
        ),
      ),
      http.get(`${adminBase}${internalStatsPath}`, () =>
        HttpResponse.json({ ledgers: [{ ledgerId: 55 }] }),
      ),
    );
    const admin = createPulsarDrainAdminFromUrls({ adminUrl: adminBase });
    await expect(captureAccountErasureNativeFenceProgress(admin, stream)).resolves.toEqual({
      fence: fenceMessage({ major: "55", minor: "0", batch: -1 }),
    });
  });

  it("fails closed on exponent numeric literals for ID keys", async () => {
    server.use(
      http.get(`${adminBase}${lastMessageIdPath}`, () =>
        HttpResponse.text('{"ledgerId":1e3,"entryId":0,"partitionIndex":-1,"batchIndex":-1}', {
          headers: { "Content-Type": "application/json" },
        }),
      ),
      http.get(`${adminBase}${internalStatsPath}`, () =>
        HttpResponse.json({ ledgers: [{ ledgerId: 1 }] }),
      ),
    );
    const admin = createPulsarDrainAdminFromUrls({ adminUrl: adminBase });
    await expect(captureAccountErasureNativeFenceProgress(admin, stream)).rejects.toThrow(
      /decimal int64 literal/i,
    );
  });

  it("fails closed when lastMessageId partition disagrees with the owned stream", async () => {
    server.use(
      http.get(`${adminBase}${lastMessageIdPath}`, () =>
        HttpResponse.text('{"ledgerId":1,"entryId":0,"partitionIndex":3,"batchIndex":-1}', {
          headers: { "Content-Type": "application/json" },
        }),
      ),
      http.get(`${adminBase}${internalStatsPath}`, () =>
        HttpResponse.json({ ledgers: [{ ledgerId: 1 }] }),
      ),
    );
    const admin = createPulsarDrainAdminFromUrls({ adminUrl: adminBase });
    await expect(captureAccountErasureNativeFenceProgress(admin, stream)).rejects.toThrow(
      /partition/i,
    );
  });

  it("fails closed when the admin lastMessageId call fails", async () => {
    server.use(
      http.get(`${adminBase}${lastMessageIdPath}`, () => new HttpResponse(null, { status: 503 })),
      http.get(`${adminBase}${internalStatsPath}`, () =>
        HttpResponse.json({ ledgers: [{ ledgerId: 1 }] }),
      ),
    );
    const admin = createPulsarDrainAdminFromUrls({ adminUrl: adminBase });
    await expect(captureAccountErasureNativeFenceProgress(admin, stream)).rejects.toThrow(/503/);
  });

  it("parses mark-delete through internalStats for public drain assertion", async () => {
    server.use(
      http.get(`${adminBase}${internalStatsPath}`, () =>
        HttpResponse.text(
          JSON.stringify({
            cursors: {
              "metric-stream-r2-archive": {
                markDeletePosition: "57:2",
                individuallyDeletedMessages: "[]",
                totalNonContiguousDeletedMessagesRange: 0,
                readPosition: "57:3",
              },
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const admin = createPulsarDrainAdminFromUrls({ adminUrl: adminBase });
    await expect(
      assertAccountErasureSubscriptionsDrained(
        admin,
        fenceMessage({ major: "57", minor: "2", batch: -1 }),
        ["metric-stream-r2-archive"],
      ),
    ).resolves.toBeUndefined();
  });

  it("aborts oversize chunked bodies without Content-Length before accumulating past 8MiB", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    server.use(
      http.get(`${adminBase}${lastMessageIdPath}`, () => {
        const streamBody = new ReadableStream<Uint8Array>({
          start(controller) {
            for (let index = 0; index < 9; index += 1) {
              controller.enqueue(chunk);
            }
            controller.close();
          },
        });
        return new HttpResponse(streamBody, {
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const admin = createPulsarDrainAdminFromUrls({ adminUrl: adminBase });
    await expect(captureAccountErasureNativeFenceProgress(admin, stream)).rejects.toThrow(
      new RegExp(`byte stream limit|${MAX_ADMIN_RESPONSE_BYTES}`),
    );
  });

  it("fails closed on invalid JSON after a bounded body read", async () => {
    server.use(
      http.get(`${adminBase}${lastMessageIdPath}`, () =>
        HttpResponse.text("{not-json", {
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const admin = createPulsarDrainAdminFromUrls({ adminUrl: adminBase });
    await expect(captureAccountErasureNativeFenceProgress(admin, stream)).rejects.toThrow();
  });

  it("aborts the underlying admin request when the owned capture signal aborts", async () => {
    const controller = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const seenSignals: AbortSignal[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const signal = init?.signal;
      if (signal) seenSignals.push(signal);
      controller.abort(
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      );
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException("The operation was aborted", "AbortError");
      }
      return fetch(input, init);
    });
    try {
      const admin = createPulsarDrainAdminFromUrls({ adminUrl: adminBase });
      await expect(captureAccountErasureNativeFenceProgress(admin, stream)).rejects.toThrow(
        /aborted|timeout|deadline|AbortError/i,
      );
      expect(timeoutSpy).toHaveBeenCalledWith(60_000);
      expect(seenSignals.length).toBeGreaterThan(0);
      expect(seenSignals.every((signal) => signal.aborted)).toBe(true);
    } finally {
      timeoutSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });
});

describe("captureAccountErasureNativeFenceProgress", () => {
  it("fails closed on signed int64 ledger coordinates outside the int64 range", async () => {
    await expect(
      captureAccountErasureNativeFenceProgress(
        createMockAdmin({
          lastMessageId: {
            ledgerId: "9223372036854775808",
            entryId: "0",
            partitionIndex: -1,
            batchIndex: -1,
          },
        }),
        stream,
      ),
    ).rejects.toThrow();
    await expect(
      captureAccountErasureNativeFenceProgress(
        createMockAdmin({
          lastMessageId: {
            ledgerId: "-9223372036854775809",
            entryId: "0",
            partitionIndex: -1,
            batchIndex: -1,
          },
        }),
        stream,
      ),
    ).rejects.toThrow();
  });

  it("fails closed on empty epoch/topic, non-int32 partition, or unanchored topic URIs", async () => {
    const admin = createMockAdmin({
      lastMessageId: { ledgerId: "1", entryId: "0", partitionIndex: -1, batchIndex: -1 },
    });
    await expect(
      captureAccountErasureNativeFenceProgress(admin, { ...stream, epoch: "" }),
    ).rejects.toThrow(/epoch and topic/);
    await expect(
      captureAccountErasureNativeFenceProgress(admin, { ...stream, topic: "" }),
    ).rejects.toThrow(/epoch and topic/);
    await expect(
      captureAccountErasureNativeFenceProgress(admin, { ...stream, partition: -2 }),
    ).rejects.toThrow(/partition must be an int32/);
    await expect(
      captureAccountErasureNativeFenceProgress(admin, { ...stream, partition: 2147483648 }),
    ).rejects.toThrow(/partition must be an int32/);
    await expect(
      captureAccountErasureNativeFenceProgress(admin, {
        ...stream,
        topic: "prefix persistent://public/default/sensor",
      }),
    ).rejects.toThrow(/concrete persistent Pulsar topic/);
  });

  it("passes the same owned AbortSignal to every admin call", async () => {
    const seen: AbortSignal[] = [];
    await captureAccountErasureNativeFenceProgress(
      createMockAdmin({
        lastMessageId: {
          ledgerId: "20",
          entryId: "3",
          partitionIndex: -1,
          batchIndex: -1,
        },
        internalStatsSequential: [
          { ledgers: [{ ledgerId: "10" }, { ledgerId: "20" }] },
          { ledgers: [{ ledgerId: "10" }, { ledgerId: "20" }] },
        ],
        onSignal: (signal) => {
          seen.push(signal);
        },
      }),
      stream,
    );
    expect(seen.length).toBe(1);
    expect(new Set(seen).size).toBe(1);
  });

  it("fails closed when monotonic capture elapsed exceeds the owned deadline", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(62_000);
    try {
      await expect(
        captureAccountErasureNativeFenceProgress(
          createMockAdmin({
            lastMessageId: {
              ledgerId: "1",
              entryId: "0",
              partitionIndex: -1,
              batchIndex: -1,
            },
            internalStatsSequential: [
              { ledgers: [{ ledgerId: "1" }] },
              { ledgers: [{ ledgerId: "1" }] },
            ],
          }),
          stream,
        ),
      ).rejects.toThrow(/deadline|aborted/i);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("resolveAccountErasureNativeDrainStreams", () => {
  const epoch = "epoch-1";

  it("maps partitions:0 to a single concrete stream at partition -1", async () => {
    const topic = "persistent://public/default/sensor";
    const streams = await resolveAccountErasureNativeDrainStreams(
      createMockAdmin({
        topicPartitionsByTopic: { [topic]: { partitions: 0, deleted: false } },
      }),
      {
        epoch,
        routes: [
          {
            topic,
            subscriptions: ["metric-stream-clickhouse-sink", "metric-stream-r2-archive"],
          },
        ],
      },
    );
    expect(streams).toEqual([
      {
        epoch,
        topic,
        partition: -1,
        subscriptions: ["metric-stream-clickhouse-sink", "metric-stream-r2-archive"],
      },
    ]);
  });

  it("maps partitions:N to concrete partition topics 0..N-1 without inventing subscriptions", async () => {
    const topic = "persistent://public/default/sensor";
    const streams = await resolveAccountErasureNativeDrainStreams(
      createMockAdmin({
        topicPartitionsByTopic: { [topic]: { partitions: 2, deleted: false } },
      }),
      {
        epoch,
        routes: [{ topic, subscriptions: ["metric-stream-live-clickhouse-sink"] }],
      },
    );
    expect(streams).toEqual([
      {
        epoch,
        topic: "persistent://public/default/sensor-partition-0",
        partition: 0,
        subscriptions: ["metric-stream-live-clickhouse-sink"],
      },
      {
        epoch,
        topic: "persistent://public/default/sensor-partition-1",
        partition: 1,
        subscriptions: ["metric-stream-live-clickhouse-sink"],
      },
    ]);
  });

  it("fails closed on missing epoch, empty subscriptions, or unresolved partition metadata", async () => {
    const topic = "persistent://public/default/sensor";
    await expect(
      resolveAccountErasureNativeDrainStreams(
        createMockAdmin({ topicPartitionsByTopic: { [topic]: { partitions: 0 } } }),
        { epoch: " ", routes: [{ topic, subscriptions: ["sink"] }] },
      ),
    ).rejects.toThrow(/TRANSPORT_EPOCH|epoch/i);
    await expect(
      resolveAccountErasureNativeDrainStreams(
        createMockAdmin({ topicPartitionsByTopic: { [topic]: { partitions: 0 } } }),
        { epoch, routes: [{ topic, subscriptions: [] }] },
      ),
    ).rejects.toThrow(/explicit subscriptions/i);
    await expect(
      resolveAccountErasureNativeDrainStreams(createMockAdmin({}), {
        epoch,
        routes: [{ topic, subscriptions: ["sink"] }],
      }),
    ).rejects.toThrow(/partitions unused/i);
  });

  it("composes caller routes from the central consumer-route resolver without inventing names", async () => {
    const resolved = resolveMetricStreamConsumerRoutes({
      METRIC_STREAM_LEGACY_TOPIC: "persistent://public/default/metric-stream-v1",
      METRIC_STREAM_LIVE_TOPIC: "persistent://public/default/metric-stream-live-v1",
      METRIC_STREAM_HISTORY_TOPIC: "persistent://public/default/metric-stream-history-v1",
    });
    const topicPartitionsByTopic = Object.fromEntries(
      resolved.map((route) => [route.topic, { partitions: 0, deleted: false }]),
    );
    const streams = await resolveAccountErasureNativeDrainStreams(
      createMockAdmin({ topicPartitionsByTopic }),
      {
        epoch,
        routes: resolved.map((route) => ({
          topic: route.topic,
          subscriptions: route.subscriptions,
        })),
      },
    );
    expect(streams).toHaveLength(3);
    expect(streams.map((stream) => stream.subscriptions)).toEqual([
      ["metric-stream-clickhouse-sink", "metric-stream-r2-archive"],
      ["metric-stream-live-clickhouse-sink", "metric-stream-live-r2-archive"],
      ["metric-stream-history-clickhouse-sink", "metric-stream-history-r2-archive"],
    ]);
  });
});

describe("assertAccountErasureSubscriptionsDrained", () => {
  const fence = fenceMessage({ major: "57", minor: "2", batch: -1 });

  it("rejects when mark-delete is behind the fence", async () => {
    await expect(
      assertAccountErasureSubscriptionsDrained(
        drainAdmin({
          internalStats: {
            cursors: {
              "metric-stream-r2-archive": {
                markDeletePosition: "57:1",
                individuallyDeletedMessages: "[]",
                totalNonContiguousDeletedMessagesRange: 0,
              },
            },
          },
        }),
        fence,
        ["metric-stream-r2-archive"],
      ),
    ).rejects.toThrow(/metric-stream-r2-archive/);
  });

  it("rejects gap ACKs after the fence even when later entries appear individually deleted", async () => {
    await expect(
      assertAccountErasureSubscriptionsDrained(
        drainAdmin({
          internalStats: {
            cursors: {
              "metric-stream-r2-archive": {
                markDeletePosition: "57:-1",
                individuallyDeletedMessages: "[(57:1..57:2]]",
                totalNonContiguousDeletedMessagesRange: 1,
              },
            },
          },
        }),
        fence,
        ["metric-stream-r2-archive"],
      ),
    ).rejects.toThrow(/metric-stream-r2-archive|contiguous|gap/i);
  });

  it("rejects when newer publishes cannot mask a mark-delete still behind the fence", async () => {
    await expect(
      assertAccountErasureSubscriptionsDrained(
        drainAdmin({
          internalStats: {
            lastConfirmedEntry: "57:9",
            cursors: {
              "metric-stream-r2-archive": {
                markDeletePosition: "57:1",
                individuallyDeletedMessages: "[(57:8..57:9]]",
                totalNonContiguousDeletedMessagesRange: 1,
              },
            },
          },
        }),
        fence,
        ["metric-stream-r2-archive"],
      ),
    ).rejects.toThrow(/metric-stream-r2-archive/);
  });

  it("passes only when mark-delete is contiguous through the fence entry", async () => {
    await expect(
      assertAccountErasureSubscriptionsDrained(
        drainAdmin({
          internalStats: {
            lastConfirmedEntry: "57:9",
            cursors: {
              "metric-stream-clickhouse-sink": {
                markDeletePosition: "57:2",
                individuallyDeletedMessages: "[]",
                totalNonContiguousDeletedMessagesRange: 0,
              },
              "metric-stream-r2-archive": {
                markDeletePosition: "57:5",
                individuallyDeletedMessages: "[(57:6..57:7]]",
                totalNonContiguousDeletedMessagesRange: 1,
              },
            },
          },
        }),
        fence,
        ["metric-stream-clickhouse-sink", "metric-stream-r2-archive"],
      ),
    ).resolves.toBeUndefined();
  });

  it("treats an empty fence as drained without requiring backlog absence alone", async () => {
    await expect(
      assertAccountErasureSubscriptionsDrained(
        drainAdmin({
          internalStats: {
            cursors: {
              "metric-stream-r2-archive": {
                markDeletePosition: "55:-1",
                individuallyDeletedMessages: "[]",
                totalNonContiguousDeletedMessagesRange: 0,
              },
            },
          },
        }),
        { transport: "pulsar", state: "empty", ...stream },
        ["metric-stream-r2-archive"],
      ),
    ).resolves.toBeUndefined();
  });

  it("fails closed when a durable subscription cursor is missing", async () => {
    await expect(
      assertAccountErasureSubscriptionsDrained(
        drainAdmin({ internalStats: { cursors: {} } }),
        fence,
        ["metric-stream-r2-archive"],
      ),
    ).rejects.toThrow(/metric-stream-r2-archive|subscription|cursor/i);
  });

  it("fails closed on unknown internal-stats cursor shapes", async () => {
    await expect(
      assertAccountErasureSubscriptionsDrained(
        drainAdmin({
          internalStats: {
            cursors: {
              "metric-stream-r2-archive": {
                markDeletePosition: "not-a-position",
                individuallyDeletedMessages: "[]",
              },
            },
          },
        }),
        fence,
        ["metric-stream-r2-archive"],
      ),
    ).rejects.toThrow();
  });

  it("fails closed when the admin internal-stats call fails", async () => {
    await expect(
      assertAccountErasureSubscriptionsDrained(
        drainAdmin({ internalStatsError: new Error("stats unavailable") }),
        fence,
        ["metric-stream-r2-archive"],
      ),
    ).rejects.toThrow("stats unavailable");
  });
});
