import * as Sentry from "@sentry/node";
import type { Admin, Consumer } from "kafkajs";
import { decodeKafkaRemoteRecord } from "./kafka-remote-record.ts";
import type { KafkaRemoteSegment } from "./kafka-remote-storage.ts";
import type { AccountErasureRouteHighWatermark } from "./redpanda-drain.ts";

const topic = "__remote_log_metadata";

/** Reads a captured cut of all native partitions; no persisted receipt or extra topic. */
export class KafkaRemoteHistory {
  readonly #admin: Pick<Admin, "fetchTopicOffsets">;
  readonly #createConsumer: () => Consumer;
  constructor(admin: Pick<Admin, "fetchTopicOffsets">, createConsumer: () => Consumer) {
    this.#admin = admin;
    this.#createConsumer = createConsumer;
  }

  async assertDeleted(
    boundaries: readonly AccountErasureRouteHighWatermark[],
  ): Promise<Map<string, KafkaRemoteSegment>> {
    const controller = new AbortController();
    const deadline = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
        once: true,
      });
    });
    const timeout = setTimeout(() => {
      const error = new Error("Kafka native metadata history read timed out");
      Sentry.captureException(error);
      controller.abort(error);
    }, 30_000);
    let consumer: Consumer | undefined;
    try {
      const cuts = await Promise.race([this.#admin.fetchTopicOffsets(topic), deadline]);
      const positions = new Map<number, { next: bigint; end: bigint }>();
      for (const cut of cuts) {
        if (
          cut.low !== "0" ||
          !/^\d+$/.test(cut.high) ||
          cut.partition < 0 ||
          positions.has(cut.partition)
        )
          throw new Error("Incomplete Kafka native metadata history");
        positions.set(cut.partition, { next: 0n, end: BigInt(cut.high) });
      }
      if (!positions.size) throw new Error("Missing Kafka native metadata partitions");
      const done = () => [...positions.values()].every((cut) => cut.next === cut.end);
      const states = new Map<string, KafkaRemoteSegment & { state: number }>();
      if (done()) return states;
      const reader = this.#createConsumer();
      consumer = reader;
      let resolveCompletion!: () => void;
      let rejectCompletion!: (error: unknown) => void;
      const completion = new Promise<void>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
      const fail = (error: unknown) => {
        Sentry.captureException(error);
        rejectCompletion(error);
      };
      let bytes = 0;
      reader.on(reader.events.CRASH, ({ payload }) => fail(payload.error));
      const read = async () => {
        await reader.connect();
        controller.signal.throwIfAborted();
        await reader.subscribe({ topic, fromBeginning: true });
        controller.signal.throwIfAborted();
        await reader.run({
          autoCommit: false,
          eachBatchAutoResolve: false,
          eachBatch: async ({ batch, heartbeat, resolveOffset }) => {
            try {
              const cut = positions.get(batch.partition);
              if (batch.topic !== topic || !cut)
                throw new Error("Unknown Kafka native metadata partition");
              for (const message of batch.messages) {
                const position = BigInt(message.offset);
                if (position < cut.next || position >= cut.end) continue;
                if (position !== cut.next || message.key !== null || !message.value)
                  throw new Error("Incomplete Kafka native metadata history or tombstone");
                bytes += message.value.length;
                if (bytes > 64 * 1024 * 1024 || states.size > 100_000)
                  throw new Error(
                    "Kafka native metadata history exceeds worker memory qualification",
                  );
                const record = decodeKafkaRemoteRecord(message.value);
                const boundary = boundaries.find(
                  (entry) =>
                    entry.topic === record.topic &&
                    entry.topicId === record.topicId &&
                    entry.partition === record.partition,
                );
                if (!boundary) throw new Error("Unknown Kafka native metadata generation");
                const previous = states.get(record.segmentId);
                if (record.startOffset !== undefined) {
                  if (previous) throw new Error("Duplicate Kafka native segment admission");
                  states.set(record.segmentId, {
                    topic: record.topic,
                    topicId: record.topicId,
                    startOffset: record.startOffset,
                    state: record.state,
                  });
                } else {
                  if (
                    !previous ||
                    previous.topic !== record.topic ||
                    previous.topicId !== record.topicId ||
                    record.state < previous.state ||
                    (record.state === 3 && previous.state < 2)
                  )
                    throw new Error("Incomplete Kafka native segment lifecycle history");
                  previous.state = record.state;
                }
                cut.next++;
                resolveOffset(message.offset);
              }
              await heartbeat();
              if (done()) resolveCompletion();
            } catch (error) {
              fail(error);
            }
          },
        });
        await completion;
      };
      await Promise.race([read(), completion, deadline]);
      for (const segment of states.values()) {
        const boundary = boundaries.find(
          (entry) => entry.topic === segment.topic && entry.topicId === segment.topicId,
        );
        if (
          !boundary ||
          (BigInt(segment.startOffset) < BigInt(boundary.offset) && segment.state !== 3)
        )
          throw new Error("Kafka native copy/delete is unfinished before erasure boundary");
      }
      return states;
    } finally {
      try {
        if (consumer) await Promise.race([consumer.disconnect(), deadline]);
      } finally {
        clearTimeout(timeout);
      }
    }
  }
}
