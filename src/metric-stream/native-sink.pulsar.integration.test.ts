import { randomUUID } from "node:crypto";
import Pulsar, { type Message, type MessageId } from "pulsar-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAnalyticsStreamState } from "../analytics/analytics-work-store.ts";
import { applyMetricStreamEventsToClickHouse } from "./clickhouse-sink.ts";
import {
  METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE,
  METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE,
  METRIC_STREAM_TABLE,
} from "./clickhouse-table.ts";
import { MetricStreamConsumerReadiness } from "./consumer-readiness.ts";
import {
  createMetricStreamBatchCompletedEvent,
  createMetricStreamDeletedEvent,
  createMetricStreamEvent,
  type MetricStreamRedpandaEvent,
} from "./events.ts";
import { runPulsarMetricStreamConsumer } from "./pulsar-consumer.ts";
import { createMetricStreamAnalyticsTestContext } from "./test-helpers.ts";
import { metricStreamPosition } from "./transport-position.ts";

describe("finite native broker to grouped sink", () => {
  let fixture: Awaited<ReturnType<typeof createMetricStreamAnalyticsTestContext>>;
  let serviceUrl: string;
  let adminUrl: string;
  beforeAll(async () => {
    const service = process.env.PULSAR_TEST_SERVICE_URL;
    const admin = process.env.PULSAR_TEST_ADMIN_URL;
    if (!service || !admin)
      throw new Error("PULSAR_TEST_SERVICE_URL and PULSAR_TEST_ADMIN_URL are required");
    serviceUrl = service;
    adminUrl = admin;
    fixture = await createMetricStreamAnalyticsTestContext();
  });
  afterAll(async () => {
    await fixture?.cleanup();
  });

  async function topicCase(
    events: readonly MetricStreamRedpandaEvent[],
    verify: (input: {
      positions: ReturnType<typeof metricStreamPosition>[];
      consume(input: {
        afterHandled(index: number): Promise<void>;
        beforeAck?(index: number): Promise<void>;
      }): Promise<number>;
      stream: typeof fixture.stream;
    }) => Promise<void>,
  ) {
    const name = `native-sink-${randomUUID()}`;
    const stream = {
      ...fixture.stream,
      topic: `persistent://public/default/${name}`,
      epoch: randomUUID(),
    };
    const subscription = `sink-${randomUUID()}`;
    const client = new Pulsar.Client({ serviceUrl });
    const bytes = events.map((event) => Buffer.from(JSON.stringify(event)));
    try {
      const producer = await client.createProducer({ topic: stream.topic, batchingEnabled: false });
      const ids: MessageId[] = [];
      try {
        for (const data of bytes) ids.push(await producer.send({ data }));
      } finally {
        await producer.close();
      }
      const positions = ids.map((id) => metricStreamPosition(stream, id));
      await verify({
        positions,
        stream,
        consume: async ({ afterHandled, beforeAck }) => {
          const controller = new AbortController();
          let acknowledged = 0;
          const adapter = {
            async subscribe(config: Parameters<Pulsar.Client["subscribe"]>[0]) {
              const consumer = await client.subscribe(config);
              return {
                batchReceive: () => consumer.batchReceive(),
                isConnected: () => consumer.isConnected(),
                close: () => consumer.close(),
                async acknowledge(message: Message) {
                  const index = ids.findIndex((id) =>
                    id.serialize().equals(message.getMessageId().serialize()),
                  );
                  expect(index).toBeGreaterThanOrEqual(0);
                  await beforeAck?.(index);
                  const result = await consumer.acknowledge(message);
                  acknowledged++;
                  if (index === events.length - 1) controller.abort();
                  return result;
                },
              };
            },
          };
          await runPulsarMetricStreamConsumer({
            client: adapter,
            readiness: new MetricStreamConsumerReadiness(),
            ...stream,
            subscription,
            receiverQueueSize: 20,
            nativeBatchMessages: 1,
            nativeBatchBytes: 8 * 1024 * 1024,
            maxGroupMessages: 1,
            maxGroupBytes: 8 * 1024 * 1024,
            loadPendingGroup: async () =>
              (await loadAnalyticsStreamState(fixture.database, stream))?.pendingGroup ?? null,
            signal: controller.signal,
            handleEvents: async (received, context) => {
              expect(received).toHaveLength(1);
              const position = context.positions[0];
              if (position?.transport !== "pulsar") throw new Error("Missing native position");
              const index = positions.findIndex(
                (expected) => expected.serializedMessageId === position.serializedMessageId,
              );
              expect(index).toBeGreaterThanOrEqual(0);
              expect(context.deliveries[0]?.data).toEqual(bytes[index]);
              expect(position).toEqual(positions[index]);
              await applyMetricStreamEventsToClickHouse(
                fixture.client,
                received,
                context,
                fixture.database,
              );
              await afterHandled(index);
            },
          });
          return acknowledged;
        },
      });
    } finally {
      try {
        await client.close();
      } finally {
        const removed = await fetch(
          `${adminUrl}/admin/v2/persistent/public/default/${name}?force=true`,
          { method: "DELETE" },
        );
        expect(removed.status).toBe(204);
      }
    }
  }

  it("replays a committed row before its first ACK and then commits and ACKs its native marker", async () => {
    const row = createMetricStreamEvent(
      {
        id: randomUUID(),
        userId: randomUUID(),
        providerId: "native-replay-fixture",
        sourceType: "sensor",
        channel: "heart_rate",
        recordedAt: "2026-11-05T00:00:00.123456Z",
        scalar: 73,
        metadata: { fixture: "finite-native" },
      },
      "100",
    );
    const marker = createMetricStreamBatchCompletedEvent(
      {
        userId: "10000000-0000-4000-8000-000000000001",
        operationId: randomUUID(),
        batchId: randomUUID(),
        datasetKeys: ["metric_stream"],
      },
      1,
    );
    const physicalCount = async () => {
      const result = await fixture.client.query({
        query: `SELECT count() AS count FROM ${METRIC_STREAM_TABLE} WHERE id={id:UUID}`,
        query_params: { id: row.id },
        format: "JSONEachRow",
      });
      return result.json();
    };
    await topicCase([row, marker], async ({ positions, stream, consume }) => {
      const first = positions[0],
        last = positions[1];
      if (!first || !last) throw new Error("Missing producer positions");
      const failure = new Error("Fixture stops immediately before first native ACK");
      let firstHandled = 0;
      await expect(
        consume({
          afterHandled: async (index) => {
            expect(index).toBe(0);
            firstHandled++;
            const raw = await fixture.client.query({
              query: `SELECT scalar,metadata,is_deleted FROM ${METRIC_STREAM_TABLE} FINAL WHERE id={id:UUID}`,
              query_params: { id: row.id },
              format: "JSONEachRow",
            });
            expect(await raw.json()).toEqual([
              { scalar: 73, metadata: JSON.stringify(row.metadata), is_deleted: 0 },
            ]);
            expect(await loadAnalyticsStreamState(fixture.database, stream)).toMatchObject({
              processed: first,
              pending: null,
            });
          },
          beforeAck: async () => {
            throw failure;
          },
        }),
      ).rejects.toBe(failure);
      expect(firstHandled).toBe(1);
      const count = await physicalCount();
      expect(count).toEqual([{ count: 1 }]);
      const handled: number[] = [];
      expect(
        await consume({
          afterHandled: async (index) => {
            handled.push(index);
            expect(await physicalCount()).toEqual(count);
          },
        }),
      ).toBe(2);
      expect(handled).toEqual([0, 1]);
      const evidence = await fixture.client.query({
        query: `SELECT marker_offset,marker_transport,marker_epoch,marker_message_id FROM ${METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE} FINAL WHERE operation_id={operation:UUID} AND batch_id={batch:String}`,
        query_params: { operation: marker.operationId, batch: marker.batchId },
        format: "JSONEachRow",
      });
      expect(await evidence.json()).toEqual([
        {
          marker_offset: null,
          marker_transport: "pulsar",
          marker_epoch: stream.epoch,
          marker_message_id: last.serializedMessageId,
        },
      ]);
      expect(await loadAnalyticsStreamState(fixture.database, stream)).toMatchObject({
        processed: last,
        pending: null,
      });
    });
  });

  it("applies and ACKs a native delete control before its replacement", async () => {
    const source = {
      id: randomUUID(),
      userId: randomUUID(),
      providerId: "native-control-fixture",
      externalId: "sample",
      sourceType: "sensor",
      channel: "heart_rate",
      recordedAt: "2026-11-05T00:00:00.123456Z",
    };
    const initial = createMetricStreamEvent({ ...source, scalar: 70 }, "100");
    const deletion = createMetricStreamDeletedEvent(
      { userId: source.userId, providerId: source.providerId, externalId: source.externalId },
      "101",
    );
    const replacement = createMetricStreamEvent({ ...source, scalar: 75 }, "101");
    await topicCase([initial, deletion, replacement], async ({ positions, stream, consume }) => {
      const handled: number[] = [];
      expect(
        await consume({
          afterHandled: async (index) => {
            handled.push(index);
            const raw = await fixture.client.query({
              query: `SELECT scalar,is_deleted,toString(version) AS version FROM ${METRIC_STREAM_TABLE} FINAL WHERE id={id:UUID}`,
              query_params: { id: source.id },
              format: "JSONEachRow",
            });
            expect(await raw.json()).toEqual([
              [
                { scalar: 70, is_deleted: 0, version: "201" },
                { scalar: 70, is_deleted: 1, version: "202" },
                { scalar: 75, is_deleted: 0, version: "203" },
              ][index],
            ]);
            if (index === 1) {
              const ack = await fixture.client.query({
                query: `SELECT count() AS count FROM ${METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE} WHERE event_id={event:UUID}`,
                query_params: { event: deletion.eventId },
                format: "JSONEachRow",
              });
              expect(await ack.json()).toEqual([{ count: 1 }]);
            }
          },
        }),
      ).toBe(3);
      expect(handled).toEqual([0, 1, 2]);
      expect(await loadAnalyticsStreamState(fixture.database, stream)).toMatchObject({
        processed: positions[2],
        pending: null,
      });
    });
  });
});
