import type {
  MetricStreamDeletedEventV3,
  MetricStreamDeleteScopeInput,
  MetricStreamEventV2,
  MetricStreamProcessingContext,
  MetricStreamProviderGenerationDeletedEvent,
  MetricStreamRowInput,
} from "./events.ts";

export interface MetricStreamEventPublisher {
  publishRows(
    rows: readonly MetricStreamRowInput[],
    options: MetricStreamPublishOptions,
  ): Promise<MetricStreamEventV2[]>;
  replaceRows?(
    scope: MetricStreamDeleteScopeInput,
    rows: readonly MetricStreamRowInput[],
    operationRevision: string,
    processing?: MetricStreamProcessingContext,
  ): Promise<MetricStreamReplacementPublishResult>;
}

export interface ProviderGenerationDeletionPublisher {
  publishProviderGenerationDeletion(
    command: MetricStreamProviderGenerationDeletedEvent,
  ): Promise<void>;
}

export interface MetricStreamPublishOptions {
  operationRevision: string;
  partitionKey?: string;
  processing?: MetricStreamProcessingContext;
}

export interface MetricStreamReplacementPublishResult {
  deleted: MetricStreamDeletedEventV3;
  rows: MetricStreamEventV2[];
}
