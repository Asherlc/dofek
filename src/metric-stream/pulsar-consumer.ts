import type { Client, Consumer } from "pulsar-client";
import { captureException } from "../lib/error-reporting.ts";
import type { MetricStreamConsumerBatchContext } from "./consumer-context.ts";
import { type MetricStreamRedpandaEvent, metricStreamRedpandaEventSchema } from "./events.ts";
import { metricStreamPosition } from "./transport-position.ts";

export interface PulsarMetricStreamBatchContext extends MetricStreamConsumerBatchContext {
  deliveries: readonly {
    data: Buffer;
    key: string;
    properties: Readonly<Record<string, string>>;
  }[];
}

interface PulsarMetricStreamOptions {
  client: {
    subscribe(
      config: Parameters<Client["subscribe"]>[0],
    ): Promise<Pick<Consumer, "receive" | "acknowledge" | "isConnected" | "close">>;
  };
  topic: string;
  partition: number;
  epoch: string;
  subscription: string;
  receiverQueueSize: number;
  signal: AbortSignal;
  handleEvents(
    events: MetricStreamRedpandaEvent[],
    context: PulsarMetricStreamBatchContext,
  ): Promise<void>;
}

/** One concrete partition, one in-flight delivery, and an individually acknowledged durable handler. */
export async function runPulsarMetricStreamConsumer(
  options: PulsarMetricStreamOptions,
): Promise<void> {
  if (!Number.isSafeInteger(options.receiverQueueSize) || options.receiverQueueSize <= 0)
    throw new Error("Pulsar receive queue size must be a positive safe integer");
  if (!options.epoch || !options.topic || !options.subscription)
    throw new Error("Pulsar epoch, concrete topic and subscription are required");
  if (
    !Number.isInteger(options.partition) ||
    options.partition < -1 ||
    options.partition > 2147483647
  )
    throw new Error(
      "Pulsar partition must be an int32 partition or -1 for a topic without partitions",
    );
  if (options.signal.aborted) return;

  let consumer: Awaited<ReturnType<PulsarMetricStreamOptions["client"]["subscribe"]>>;
  try {
    consumer = await options.client.subscribe({
      topic: options.topic,
      subscription: options.subscription,
      subscriptionType: "Exclusive",
      subscriptionInitialPosition: "Earliest",
      receiverQueueSize: options.receiverQueueSize,
      batchIndexAckEnabled: true,
    });
  } catch (error) {
    captureException(error, {
      tags: { metricStreamConsumer: "pulsar", metricStreamFailure: "subscribe" },
    });
    throw error;
  }

  const stopped = Symbol("Pulsar intake stopped");
  let resolveStop!: (value: typeof stopped) => void;
  const stopRequest = new Promise<typeof stopped>((resolve) => {
    resolveStop = resolve;
  });
  let closeRequest: Promise<unknown> | undefined;
  let closeFailure: unknown;
  let closeFailed = false;
  const close = () =>
    (closeRequest ??= consumer.close().catch((error: unknown) => {
      closeFailed = true;
      closeFailure = error;
      captureException(error, {
        tags: { metricStreamConsumer: "pulsar", metricStreamFailure: "close" },
      });
    }));
  const stop = () => {
    resolveStop(stopped);
    void close();
  };
  options.signal.addEventListener("abort", stop, { once: true });
  if (options.signal.aborted) stop();
  const assertActive = async () => {
    if (options.signal.aborted) throw stopped;
    if (!consumer.isConnected())
      throw new Error("Pulsar consumer ownership is no longer connected");
  };
  let failed = false;
  let failure: unknown;
  try {
    while (!options.signal.aborted) {
      await assertActive();
      const pending = consumer.receive();
      const message = await Promise.race([stopRequest, pending]);
      if (message === stopped) {
        await close();
        // Closing cancels the outstanding native receive. Consume its settlement
        // before returning; it can no longer dispatch a handler or ACK.
        if (!closeFailed) await Promise.allSettled([pending]);
        break;
      }
      await assertActive();
      if (message.getTopicName() !== options.topic)
        throw new Error("Pulsar delivery topic differs from the owned concrete partition");
      const position = metricStreamPosition(
        { epoch: options.epoch, topic: options.topic, partition: options.partition },
        message.getMessageId(),
      );
      const data = Buffer.from(message.getData());
      const event = metricStreamRedpandaEventSchema.parse(JSON.parse(data.toString("utf8")));
      const properties = Object.fromEntries(Object.entries(message.getProperties()));
      await options.handleEvents([event], {
        topic: options.topic,
        partition: options.partition,
        positions: [position],
        deliveries: [{ data, key: message.getPartitionKey(), properties }],
        assertActive,
      });
      await assertActive();
      await consumer.acknowledge(message);
    }
  } catch (error) {
    if (error !== stopped) {
      failed = true;
      failure = error;
      captureException(error, {
        tags: { metricStreamConsumer: "pulsar", metricStreamFailure: "intake" },
      });
    }
  } finally {
    options.signal.removeEventListener("abort", stop);
    await close();
  }
  if (failed && closeFailed)
    throw new AggregateError([failure, closeFailure], "Pulsar intake and close failed");
  if (failed) throw failure;
  if (closeFailed) throw closeFailure;
}
