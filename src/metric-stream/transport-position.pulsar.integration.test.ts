import { randomUUID } from "node:crypto";
import Pulsar from "pulsar-client";
import { expect, it } from "vitest";
import { compareMetricStreamPositions, metricStreamPosition } from "./transport-position.ts";

it("ordersBatchedMessagesAcrossRealLedgerRolloverAndRoundTripsNativeMessages", async () => {
  const serviceUrl = process.env.PULSAR_TEST_SERVICE_URL;
  const adminUrl = process.env.PULSAR_TEST_ADMIN_URL;
  if (!serviceUrl || !adminUrl) {
    throw new Error(
      "PULSAR_TEST_SERVICE_URL and PULSAR_TEST_ADMIN_URL are required for native position qualification",
    );
  }
  const name = `bounded-order-${randomUUID()}`;
  const topic = `persistent://public/default/${name}`;
  const stream = { epoch: randomUUID(), topic, partition: -1 };
  const client = new Client({ serviceUrl });
  try {
    const firstProducer = await client.createProducer({
      topic,
      batchingEnabled: true,
      batchingMaxMessages: 3,
    });
    const firstIds = await Promise.all(
      [0, 1, 2].map((value) => firstProducer.send({ data: Buffer.from(String(value)) })),
    );
    await firstProducer.close();
    const unload = await fetch(`${adminUrl}/admin/v2/persistent/public/default/${name}/unload`, {
      method: "PUT",
    });
    if (!unload.ok)
      throw new Error(`Isolated topic unload failed: ${unload.status} ${await unload.text()}`);
    const secondProducer = await client.createProducer({
      topic,
      batchingEnabled: true,
      batchingMaxMessages: 3,
    });
    const secondIds = await Promise.all(
      [3, 4, 5].map((value) => secondProducer.send({ data: Buffer.from(String(value)) })),
    );
    await secondProducer.close();
    const positions = [...firstIds, ...secondIds].map((id) => metricStreamPosition(stream, id));
    const first = positions[0];
    const afterRollover = positions[3];
    if (!first || !afterRollover) throw new Error("Native producer omitted message IDs");
    expect(BigInt(afterRollover.delivery.major)).toBeGreaterThan(BigInt(first.delivery.major));
    expect(positions.slice(0, 3).map((position) => position.delivery.batch)).toEqual([0, 1, 2]);
    for (let index = 1; index < positions.length; index++) {
      const previous = positions[index - 1];
      const current = positions[index];
      if (!previous || !current) throw new Error("Native position missing");
      expect(compareMetricStreamPositions(previous, current)).toBe(-1);
    }
    const reader = await client.createReader({ topic, startMessageId: MessageId.earliest() });
    try {
      for (const [index, original] of [...firstIds, ...secondIds].entries()) {
        const message = await reader.readNext(10_000);
        const position = metricStreamPosition(stream, message.getMessageId());
        expect(message.getData().toString()).toBe(String(index));
        expect(position.serializedMessageId).toBe(original.serialize().toString("base64"));
        expect(
          MessageId.deserialize(Buffer.from(position.serializedMessageId, "base64")).serialize(),
        ).toEqual(message.getMessageId().serialize());
        expect(position).toEqual(positions[index]);
      }
    } finally {
      await reader.close();
    }
  } finally {
    await client.close();
  }
});

const { Client, MessageId } = Pulsar;
