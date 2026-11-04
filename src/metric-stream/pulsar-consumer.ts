import type { Client, Consumer, Message } from "pulsar-client";
import {
  type AnalyticsDeliveryGroup,
  describeAnalyticsDeliveryGroup,
} from "../analytics/analytics-delivery-group.ts";
import { metricStreamPositionIdentity } from "../analytics/journal-position.ts";
import { captureException } from "../lib/error-reporting.ts";
import type { MetricStreamConsumerBatchContext } from "./consumer-context.ts";
import { type MetricStreamRedpandaEvent, metricStreamRedpandaEventSchema } from "./events.ts";
import {
  compareMetricStreamPositions,
  metricStreamPosition,
  type PulsarMetricStreamPosition,
} from "./transport-position.ts";

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
    ): Promise<Pick<Consumer, "batchReceive" | "acknowledge" | "isConnected" | "close">>;
  };
  topic: string;
  partition: number;
  epoch: string;
  subscription: string;
  receiverQueueSize: number;
  nativeBatchMessages: number;
  nativeBatchBytes: number;
  maxGroupMessages: number;
  maxGroupBytes: number;
  loadPendingGroup(): Promise<AnalyticsDeliveryGroup | null>;
  signal: AbortSignal;
  handleEvents(
    events: MetricStreamRedpandaEvent[],
    context: PulsarMetricStreamBatchContext,
  ): Promise<void>;
}

interface ReceivedDelivery {
  message: Message;
  event: MetricStreamRedpandaEvent;
  position: PulsarMetricStreamPosition;
  wire: PulsarMetricStreamBatchContext["deliveries"][number];
  bytes: number;
}

/** One concrete partition, finite native batches and one durable application group in flight. */
export async function runPulsarMetricStreamConsumer(
  options: PulsarMetricStreamOptions,
): Promise<void> {
  if (options.receiverQueueSize !== 20) throw new Error("Pulsar receive queue size must be 20");
  if (
    !Number.isSafeInteger(options.nativeBatchMessages) ||
    options.nativeBatchMessages < 1 ||
    options.nativeBatchMessages > 20
  )
    throw new Error("Pulsar native batch count must be between 1 and 20");
  if (
    !Number.isSafeInteger(options.maxGroupMessages) ||
    options.maxGroupMessages < 1 ||
    options.maxGroupMessages > 500
  )
    throw new Error("Pulsar application group count must be between 1 and 500");
  for (const bytes of [options.nativeBatchBytes, options.maxGroupBytes])
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 8 * 1024 * 1024)
      throw new Error("Pulsar native and application byte limits must be between 1 and 8MiB");
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
      batchReceivePolicy: {
        maxNumMessages: options.nativeBatchMessages,
        maxNumBytes: options.nativeBatchBytes,
        timeoutMs: 100,
      },
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
  const buffered: ReceivedDelivery[] = [];
  let retainedBytes = 0;
  let previousReceived: PulsarMetricStreamPosition | null = null;
  const pendingConfigurationError = () =>
    new Error(
      "Pending Pulsar group exceeds the configured bounds; restore its original configuration before replay",
    );
  function validatePending(group: AnalyticsDeliveryGroup) {
    if (
      !Number.isSafeInteger(group.memberCount) ||
      group.memberCount < 1 ||
      group.memberCount > options.maxGroupMessages
    )
      throw pendingConfigurationError();
    if (
      group.stream.transport !== "pulsar" ||
      group.stream.epoch !== options.epoch ||
      group.stream.topic !== options.topic ||
      group.stream.partition !== options.partition ||
      group.first.transport !== "pulsar" ||
      group.last.transport !== "pulsar" ||
      compareMetricStreamPositions(group.first, {
        ...group.first,
        epoch: group.stream.epoch,
        topic: group.stream.topic,
        partition: group.stream.partition,
      }) !== 0 ||
      compareMetricStreamPositions(group.first, group.last) > 0 ||
      !/^[a-f0-9]{64}$/.test(group.positionsDigest)
    )
      throw new Error("Pending Pulsar group has an invalid owned stream or range");
  }
  async function receiveBatch(pendingGroup: AnalyticsDeliveryGroup | null) {
    await assertActive();
    const pending = consumer.batchReceive();
    const messages = await Promise.race([stopRequest, pending]);
    if (messages === stopped) {
      await close();
      if (!closeFailed) await Promise.allSettled([pending]);
      throw stopped;
    }
    await assertActive();
    if (messages.length > options.nativeBatchMessages)
      throw new Error("Pulsar native batch exceeds its configured message bound");
    for (const message of messages) {
      if (message.getTopicName() !== options.topic)
        throw new Error("Pulsar delivery topic differs from the owned concrete partition");
      const position = metricStreamPosition(
        { epoch: options.epoch, topic: options.topic, partition: options.partition },
        message.getMessageId(),
      );
      if (previousReceived && compareMetricStreamPositions(previousReceived, position) >= 0)
        throw new Error("Pulsar received messages violate strict native ordering");
      previousReceived = position;
      const data = message.getData();
      const key = message.getPartitionKey();
      const properties = Object.fromEntries(Object.entries(message.getProperties()));
      const bytes =
        data.length +
        Buffer.byteLength(key) +
        Buffer.byteLength(position.serializedMessageId) +
        Object.entries(properties).reduce(
          (total, [name, value]) => total + Buffer.byteLength(name) + Buffer.byteLength(value),
          0,
        );
      if (bytes > options.maxGroupBytes) {
        if (pendingGroup) throw pendingConfigurationError();
        throw new Error("Pulsar delivery exceeds its configured application byte bound");
      }
      retainedBytes += bytes;
      if (retainedBytes > options.maxGroupBytes + options.nativeBatchBytes)
        throw new Error(
          "Pulsar retained wire envelopes exceed the application and native batch byte bounds",
        );
      const event = metricStreamRedpandaEventSchema.parse(JSON.parse(data.toString("utf8")));
      buffered.push({ message, event, position, wire: { data, key, properties }, bytes });
    }
    return messages.length;
  }
  let failed = false;
  let failure: unknown;
  try {
    while (!options.signal.aborted) {
      await assertActive();
      const pendingGroup = await options.loadPendingGroup();
      if (pendingGroup) validatePending(pendingGroup);
      const group: ReceivedDelivery[] = [];
      const sources = new Set<string>();
      let bytes = 0;
      let exactPending = false;
      while (group.length < options.maxGroupMessages) {
        if (!buffered.length && !(await receiveBatch(pendingGroup))) {
          if (pendingGroup && (exactPending || !group.length))
            throw new Error(
              "Pending Pulsar group is incomplete after the native collection timeout",
            );
          break;
        }
        const next = buffered[0];
        if (!next) throw new Error("Pulsar batch returned no buffered delivery");
        if (pendingGroup) {
          const relativeToFirst = compareMetricStreamPositions(next.position, pendingGroup.first);
          if (!group.length) {
            if (relativeToFirst > 0)
              throw new Error("Pending Pulsar group is missing its original first member");
            exactPending = relativeToFirst === 0;
            if (
              exactPending &&
              metricStreamPositionIdentity(next.position) !==
                metricStreamPositionIdentity(pendingGroup.first)
            )
              throw new Error("Pending Pulsar group first native identity changed");
          } else if (!exactPending && relativeToFirst >= 0) break;
          if (exactPending && compareMetricStreamPositions(next.position, pendingGroup.last) > 0)
            throw new Error("Pending Pulsar group exceeded its original native range");
        }
        const source = "id" in next.event ? next.event.id.toLowerCase() : null;
        const control = "eventType" in next.event;
        const boundary = group.length > 0 && (control || (source !== null && sources.has(source)));
        if (boundary || bytes + next.bytes > options.maxGroupBytes) {
          if (exactPending) throw pendingConfigurationError();
          break;
        }
        buffered.shift();
        group.push(next);
        bytes += next.bytes;
        if (source) sources.add(source);
        if (control && exactPending && pendingGroup?.memberCount !== 1)
          throw new Error("Pending Pulsar group contains a control boundary");
        if (control || (exactPending && group.length === pendingGroup?.memberCount)) break;
      }
      if (!group.length) continue;
      if (exactPending && pendingGroup) {
        const actual = describeAnalyticsDeliveryGroup(
          group.map(({ position }) => position),
          options.maxGroupMessages,
        );
        if (
          actual.memberCount !== pendingGroup.memberCount ||
          actual.positionsDigest !== pendingGroup.positionsDigest ||
          compareMetricStreamPositions(actual.last, pendingGroup.last) !== 0 ||
          metricStreamPositionIdentity(actual.last) !==
            metricStreamPositionIdentity(pendingGroup.last)
        )
          throw new Error("Pending Pulsar group original membership or digest changed");
      }
      await assertActive();
      await options.handleEvents(
        group.map(({ event }) => event),
        {
          topic: options.topic,
          partition: options.partition,
          positions: group.map(({ position }) => position),
          deliveries: group.map(({ wire }) => wire),
          assertActive,
        },
      );
      for (const { message } of group) {
        await assertActive();
        await consumer.acknowledge(message);
      }
      retainedBytes -= bytes;
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
