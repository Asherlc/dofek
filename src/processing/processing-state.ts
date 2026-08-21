import type { ProcessingOutputPath } from "./dataset-contracts.ts";

export const PROCESSING_STAGES = [
  "ingest",
  "canonical_commit",
  "cdc",
  "analytics",
  "cache_refresh",
] as const;

export type ProcessingStage = (typeof PROCESSING_STAGES)[number];
export const PROCESSING_EVENT_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
] as const;

export type ProcessingEventStatus = (typeof PROCESSING_EVENT_STATUSES)[number];
export type ProcessingOperationStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export const DERIVED_PROCESSING_STATUSES = [
  "ready",
  "waiting",
  "active",
  "partial",
  "delayed",
  "blocked",
  "failed",
  "cancelled",
] as const;

export type DerivedProcessingStatus = (typeof DERIVED_PROCESSING_STATUSES)[number];

export interface ProcessingStageEvent {
  sequence: number;
  stage: ProcessingStage;
  status: ProcessingEventStatus;
  datasetKey: string | null;
  outputPath: ProcessingOutputPath | null;
  occurredAt: Date;
  progressPercentage: number | null;
}

export interface DerivedDatasetState {
  datasetKey: string;
  currentStage: ProcessingStage;
  status: Exclude<DerivedProcessingStatus, "partial">;
  progressPercentage: number | null;
  lastAdvancedAt: Date | null;
}

export interface DerivedProcessingState {
  overallStatus: DerivedProcessingStatus;
  datasets: DerivedDatasetState[];
}

interface DeriveProcessingStateInput {
  datasetKeys: readonly string[];
  outputManifest: Readonly<Record<string, readonly ProcessingOutputPath[]>>;
  events: readonly ProcessingStageEvent[];
  operationStatus?: ProcessingOperationStatus;
  now: Date;
  delayedAfterMs: number;
}

function latestFacts(
  datasetKey: string,
  events: readonly ProcessingStageEvent[],
): ProcessingStageEvent[] {
  const facts = new Map<string, ProcessingStageEvent>();
  for (const event of events) {
    if (event.datasetKey !== null && event.datasetKey !== datasetKey) continue;
    const key = `${event.stage}:${event.outputPath ?? "dataset"}`;
    const current = facts.get(key);
    if (!current || event.sequence > current.sequence) facts.set(key, event);
  }
  return [...facts.values()];
}

function latestFactForStage(
  facts: readonly ProcessingStageEvent[],
  stage: ProcessingStage,
  outputPath: ProcessingOutputPath | null,
): ProcessingStageEvent | undefined {
  return facts.find((fact) => fact.stage === stage && fact.outputPath === outputPath);
}

function latestBySequence(
  facts: readonly ProcessingStageEvent[],
): ProcessingStageEvent | undefined {
  return [...facts].sort((left, right) => right.sequence - left.sequence)[0];
}

function deriveDatasetState(
  datasetKey: string,
  outputPaths: readonly ProcessingOutputPath[],
  events: readonly ProcessingStageEvent[],
  operationStatus: ProcessingOperationStatus | undefined,
  now: Date,
  delayedAfterMs: number,
): DerivedDatasetState {
  const facts = latestFacts(datasetKey, events);
  const failedFact = facts
    .filter((fact) => fact.status === "failed")
    .sort((left, right) => right.sequence - left.sequence)[0];
  if (failedFact) {
    return {
      datasetKey,
      currentStage: failedFact.stage,
      status: "failed",
      progressPercentage: failedFact.progressPercentage,
      lastAdvancedAt: failedFact.occurredAt,
    };
  }

  const cancelledFact = facts
    .filter((fact) => fact.status === "cancelled")
    .sort((left, right) => right.sequence - left.sequence)[0];
  if (operationStatus === "cancelled" || cancelledFact) {
    return {
      datasetKey,
      currentStage: cancelledFact?.stage ?? PROCESSING_STAGES[0],
      status: "cancelled",
      progressPercentage: cancelledFact?.progressPercentage ?? null,
      lastAdvancedAt: cancelledFact?.occurredAt ?? null,
    };
  }

  for (const stage of PROCESSING_STAGES) {
    if ((stage === "canonical_commit" || stage === "cdc") && outputPaths.length === 0) {
      continue;
    }

    const stageFacts =
      stage === "canonical_commit" || stage === "cdc"
        ? outputPaths.map((outputPath) => latestFactForStage(facts, stage, outputPath))
        : [latestFactForStage(facts, stage, null)];
    if (stageFacts.every((fact) => fact?.status === "succeeded" || fact?.status === "skipped")) {
      continue;
    }

    const fact = latestBySequence(
      stageFacts.filter((stageFact): stageFact is ProcessingStageEvent => stageFact !== undefined),
    );

    if (fact?.status === "running" || fact?.status === "queued") {
      const delayed = now.getTime() - fact.occurredAt.getTime() > delayedAfterMs;
      return {
        datasetKey,
        currentStage: stage,
        status: delayed ? "delayed" : "active",
        progressPercentage: fact.progressPercentage,
        lastAdvancedAt: fact.occurredAt,
      };
    }

    const latestFact = latestBySequence(facts);
    const delayed =
      latestFact !== undefined && now.getTime() - latestFact.occurredAt.getTime() > delayedAfterMs;
    const operationIsTerminal = operationStatus === "succeeded" || operationStatus === "failed";
    return {
      datasetKey,
      currentStage: stage,
      status: operationIsTerminal && delayed ? "blocked" : "waiting",
      progressPercentage: null,
      lastAdvancedAt: latestFact?.occurredAt ?? null,
    };
  }

  const latestFact = latestBySequence(facts);
  return {
    datasetKey,
    currentStage: "cache_refresh",
    status: "ready",
    progressPercentage: 100,
    lastAdvancedAt: latestFact?.occurredAt ?? null,
  };
}

function overallStatus(datasets: readonly DerivedDatasetState[]): DerivedProcessingStatus {
  const statuses = new Set(datasets.map((dataset) => dataset.status));
  if (statuses.has("failed")) return "failed";
  if (statuses.has("blocked")) return "blocked";
  if (statuses.has("cancelled")) return "cancelled";
  if (statuses.has("delayed")) return "delayed";
  if (statuses.has("ready") && statuses.size > 1) return "partial";
  if (statuses.has("active")) return "active";
  if (statuses.has("waiting")) return "waiting";
  return "ready";
}

export function deriveProcessingState({
  datasetKeys,
  outputManifest,
  events,
  operationStatus,
  now,
  delayedAfterMs,
}: DeriveProcessingStateInput): DerivedProcessingState {
  const datasets = datasetKeys.map((datasetKey) =>
    deriveDatasetState(
      datasetKey,
      outputManifest[datasetKey] ?? [],
      events,
      operationStatus,
      now,
      delayedAfterMs,
    ),
  );
  return { overallStatus: overallStatus(datasets), datasets };
}
