import { randomUUID } from "node:crypto";
import Pulsar from "pulsar-client";
import { expect, it } from "vitest";
import { runPulsarMetricStreamConsumer } from "./pulsar-consumer.ts";
import { metricStreamPosition } from "./transport-position.ts";

it("acknowledgesHandledDeliveriesAndRedeliversOnlyUnacknowledgedNativeBatchMembers", async () => {
  const serviceUrl = process.env.PULSAR_TEST_SERVICE_URL;
  const adminUrl = process.env.PULSAR_TEST_ADMIN_URL;
  if (!serviceUrl || !adminUrl)
    throw new Error("PULSAR_TEST_SERVICE_URL and PULSAR_TEST_ADMIN_URL are required");
  const name = `bounded-consumer-${randomUUID()}`;
  const topic = `persistent://public/default/${name}`;
  const client = new Pulsar.Client({ serviceUrl });
  const bytes = [0, 1, 2].map((index) =>
    Buffer.from(
      JSON.stringify({
        version: 2,
        operationRevision: String(index + 1),
        id: randomUUID(),
        userId: randomUUID(),
        providerId: "fixture",
        sourceType: "sensor",
        channel: "heart_rate",
        recordedAt: "2026-01-01T00:00:00.123456Z",
        scalar: 100 + index,
      }),
    ),
  );
  const subscription = `sink-${randomUUID()}`;
  let removedStatus = 0;
  try {
    const producer = await client.createProducer({
      topic,
      batchingEnabled: true,
      batchingMaxMessages: 3,
    });
    const ids = await Promise.all(
      bytes.map((data, index) =>
        producer.send({
          data,
          partitionKey: `sample-${index}`,
          properties: { source: `native-${index}` },
        }),
      ),
    );
    await producer.close();
    const nativePositions = ids.map((id) =>
      metricStreamPosition({ epoch: "fixture", topic, partition: -1 }, id),
    );
    const firstPosition = nativePositions[0];
    if (!firstPosition) throw new Error("Producer returned no native positions");
    expect(nativePositions.map((position) => position.delivery)).toEqual(
      [0, 1, 2].map((batch) => ({ ...firstPosition.delivery, batch })),
    );
    const options = {
      client,
      topic,
      partition: -1,
      epoch: randomUUID(),
      subscription,
      receiverQueueSize: 3,
      signal: new AbortController().signal,
    };
    const first: string[] = [];
    const failure = new Error("Fixture stops before the second durable commit");
    await expect(
      runPulsarMetricStreamConsumer({
        ...options,
        handleEvents: async (_events, context) => {
          const delivery = context.deliveries[0];
          const position = context.positions[0];
          if (!delivery || !position || position.transport !== "pulsar")
            throw new Error("Missing native delivery");
          const index = first.length;
          expect(delivery.data).toEqual(bytes[index]);
          expect(delivery.key).toBe(`sample-${index}`);
          expect(delivery.properties).toEqual({ source: `native-${index}` });
          expect(position.serializedMessageId).toBe(ids[index]?.serialize().toString("base64"));
          first.push(position.serializedMessageId);
          if (index === 1) throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(first).toEqual(ids.slice(0, 2).map((id) => id.serialize().toString("base64")));

    const second: string[] = [];
    const stopAfterRead = new Error("Fixture stops before the final durable commit");
    await expect(
      runPulsarMetricStreamConsumer({
        ...options,
        handleEvents: async (_events, context) => {
          const delivery = context.deliveries[0];
          const position = context.positions[0];
          if (!delivery || !position || position.transport !== "pulsar")
            throw new Error("Missing redelivery");
          const index = second.length + 1;
          expect(delivery.data).toEqual(bytes[index]);
          expect(position.serializedMessageId).toBe(ids[index]?.serialize().toString("base64"));
          second.push(position.serializedMessageId);
          if (index === 2) throw stopAfterRead;
        },
      }),
    ).rejects.toBe(stopAfterRead);
    expect(second).toEqual(ids.slice(1).map((id) => id.serialize().toString("base64")));

    const final = await client.subscribe({
      topic,
      subscription,
      subscriptionType: "Exclusive",
      batchIndexAckEnabled: true,
    });
    try {
      const remaining = await final.receive(10_000);
      expect(remaining.getMessageId().serialize()).toEqual(ids[2]?.serialize());
      expect(remaining.getData()).toEqual(bytes[2]);
      await final.acknowledge(remaining);
    } finally {
      await final.close();
    }
  } finally {
    await client.close();
    const removed = await fetch(
      `${adminUrl}/admin/v2/persistent/public/default/${name}?force=true`,
      { method: "DELETE" },
    );
    removedStatus = removed.status;
  }
  expect(removedStatus).toBe(204);
});
