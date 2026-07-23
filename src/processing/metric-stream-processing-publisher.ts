import { createHash } from "node:crypto";
import {
  createMetricStreamDeletePartitionKey,
  createMetricStreamEvent,
  type MetricStreamDeleteScopeInput,
  type MetricStreamProcessingContext,
  type MetricStreamRowInput,
} from "../metric-stream/events.ts";
import type {
  MetricStreamEventPublisher,
  MetricStreamPublishOptions,
  MetricStreamReplacementPublishResult,
} from "../metric-stream/redpanda-producer.ts";
import { getDefaultMetricStreamEventPublisher } from "../metric-stream/redpanda-producer.ts";
import type { ProcessingDatasetKey } from "./dataset-contracts.ts";

export interface MetricStreamPublishedBatch {
  operationId: string;
  batchId: string;
  datasetKeys: ProcessingDatasetKey[];
  expectedEventCount: number;
}

export interface MetricStreamProcessingPublisherOptions {
  operationId: string;
  datasetKeys: readonly ProcessingDatasetKey[];
  recordPublishedBatch(batch: MetricStreamPublishedBatch): Promise<void>;
}

function metricStreamBatchId(
  operationId: string,
  operationRevision: string,
  partitionKey: string,
  rows: readonly MetricStreamRowInput[],
): string {
  const eventIds = rows.map((row) => createMetricStreamEvent(row, operationRevision).id);
  return createHash("sha256")
    .update("dofek.metric-stream.processing-batch.v1\0")
    .update(operationId)
    .update("\0")
    .update(operationRevision)
    .update("\0")
    .update(partitionKey)
    .update("\0")
    .update(eventIds.join("\0"))
    .digest("hex");
}

export class MetricStreamProcessingPublisher implements MetricStreamEventPublisher {
  readonly #delegate: MetricStreamEventPublisher;
  readonly #operationId: string;
  readonly #datasetKeys: ProcessingDatasetKey[];
  readonly #recordPublishedBatch: (batch: MetricStreamPublishedBatch) => Promise<void>;
  #recordedBatchCount = 0;
  #publishedBatchCount = 0;

  constructor(
    delegate: MetricStreamEventPublisher,
    options: MetricStreamProcessingPublisherOptions,
  ) {
    if (options.datasetKeys.length === 0) {
      throw new Error("Metric-stream processing publisher requires at least one dataset");
    }
    this.#delegate = delegate;
    this.#operationId = options.operationId;
    this.#datasetKeys = [...options.datasetKeys];
    this.#recordPublishedBatch = options.recordPublishedBatch;
  }

  #processingContext(batchId: string): MetricStreamProcessingContext {
    return {
      operationId: this.#operationId,
      batchId,
      datasetKeys: this.#datasetKeys,
    };
  }

  async #record(batchId: string, expectedEventCount: number): Promise<void> {
    await this.#recordPublishedBatch({
      operationId: this.#operationId,
      batchId,
      datasetKeys: this.#datasetKeys,
      expectedEventCount,
    });
    this.#recordedBatchCount += 1;
  }

  get hasPublishedBatches(): boolean {
    return this.#publishedBatchCount > 0;
  }

  get hasUnpublishedBatchIntents(): boolean {
    return this.#recordedBatchCount > this.#publishedBatchCount;
  }

  async publishRows(rows: readonly MetricStreamRowInput[], options: MetricStreamPublishOptions) {
    if (options.processing) {
      throw new Error("Metric-stream processing context is already assigned");
    }
    if (rows.length === 0) {
      return this.#delegate.publishRows(rows, options);
    }
    const batchId = metricStreamBatchId(
      this.#operationId,
      options.operationRevision,
      options.partitionKey ?? "rows",
      rows,
    );
    await this.#record(batchId, rows.length);
    const events = await this.#delegate.publishRows(rows, {
      ...options,
      processing: this.#processingContext(batchId),
    });
    this.#publishedBatchCount += 1;
    return events;
  }

  async replaceRows(
    scope: MetricStreamDeleteScopeInput,
    rows: readonly MetricStreamRowInput[],
    operationRevision: string,
  ): Promise<MetricStreamReplacementPublishResult> {
    if (!this.#delegate.replaceRows) {
      throw new Error("Metric stream publisher does not support scoped replacement");
    }
    const batchId = metricStreamBatchId(
      this.#operationId,
      operationRevision,
      createMetricStreamDeletePartitionKey(scope),
      rows,
    );
    await this.#record(batchId, rows.length + 1);
    const result = await this.#delegate.replaceRows(
      scope,
      rows,
      operationRevision,
      this.#processingContext(batchId),
    );
    this.#publishedBatchCount += 1;
    return result;
  }
}

export function createLazyDefaultMetricStreamEventPublisher(): MetricStreamEventPublisher {
  let delegatePromise: Promise<MetricStreamEventPublisher> | undefined;
  const delegate = () => {
    delegatePromise ??= getDefaultMetricStreamEventPublisher();
    return delegatePromise;
  };
  return {
    publishRows: async (rows, options) => (await delegate()).publishRows(rows, options),
    replaceRows: async (scope, rows, operationRevision, processing) => {
      const publisher = await delegate();
      if (!publisher.replaceRows) {
        throw new Error("Metric stream publisher does not support scoped replacement");
      }
      return publisher.replaceRows(scope, rows, operationRevision, processing);
    },
  };
}
