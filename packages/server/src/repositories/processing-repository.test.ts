import type { Database } from "dofek/db";
import type { ProcessingOperationWithEvents } from "dofek/processing/processing-event-store";
import type { DerivedProcessingStatus } from "dofek/processing/processing-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockDeriveProcessingState, mockListProcessingHistory, mockListScopedProcessingOperations } =
  vi.hoisted(() => ({
    mockDeriveProcessingState: vi.fn(),
    mockListProcessingHistory: vi.fn(),
    mockListScopedProcessingOperations: vi.fn(),
  }));

vi.mock("dofek/processing/processing-state", () => ({
  deriveProcessingState: mockDeriveProcessingState,
}));

vi.mock("dofek/processing/processing-event-store", () => ({
  listProcessingHistory: mockListProcessingHistory,
  listScopedProcessingOperations: mockListScopedProcessingOperations,
}));

import { ProcessingRepository } from "./processing-repository.ts";

const operationId = "10000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000002";
const now = new Date("2026-07-22T18:00:00.000Z");
const database: Database = Object.create(null);

function event(
  sequence: number,
  input: Partial<ProcessingOperationWithEvents["events"][number]>,
): ProcessingOperationWithEvents["events"][number] {
  return {
    id: `10000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
    sequence,
    operationId,
    stage: "ingest",
    status: "succeeded",
    datasetKey: "activity",
    outputPath: null,
    modelName: null,
    occurredAt: now,
    progressPercentage: null,
    sourceWatermark: null,
    servingWatermark: null,
    message: null,
    errorCode: null,
    errorMessage: null,
    metadataSchemaVersion: 1,
    metadata: null,
    idempotencyKey: `event-${sequence}`,
    ...input,
  };
}

function operation(
  input: Partial<ProcessingOperationWithEvents> = {},
): ProcessingOperationWithEvents {
  return {
    id: operationId,
    userId,
    providerId: "kaya-export",
    kind: "file_import",
    externalCorrelationKey: "import-1",
    datasetKeys: ["activity"],
    createdAt: now,
    outputManifest: { activity: ["relational", "metric_stream"] },
    events: [event(1, {})],
    ...input,
  };
}

describe("ProcessingRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockDeriveProcessingState.mockImplementation((input: { datasetKeys: readonly string[] }) => ({
      overallStatus: "ready",
      datasets: input.datasetKeys.map((datasetKey) => ({
        datasetKey,
        currentStage: "cache_refresh",
        status: "ready",
        progressPercentage: 100,
        lastAdvancedAt: now,
      })),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("scopes status to the authenticated user, provider, and datasets", async () => {
    mockListScopedProcessingOperations.mockResolvedValue([]);
    const repository = new ProcessingRepository(database, userId);

    const result = await repository.status({ providerId: "kaya-export", datasets: ["activity"] });

    expect(mockListScopedProcessingOperations).toHaveBeenCalledWith(database, {
      userId,
      providerId: "kaya-export",
      datasetKeys: ["activity"],
    });
    expect(result.scope).toEqual({ providerId: "kaya-export", datasets: ["activity"] });
    expect(result.generatedAt).toBe("2026-07-22T18:00:00.000Z");
  });

  it("selects the matching dataset contract for labels", async () => {
    mockListScopedProcessingOperations.mockResolvedValue([]);
    const repository = new ProcessingRepository(database, userId);

    const result = await repository.status({ datasets: ["nutrition"] });

    expect(result.datasets).toEqual([
      {
        key: "nutrition",
        label: "Nutrition",
        status: "ready",
        currentStage: null,
        progressPercentage: null,
        lastAdvancedAt: null,
        lastReadyAt: null,
      },
    ]);
    expect(result.scope).toEqual({ providerId: null, datasets: ["nutrition"] });
  });

  it("rejects a requested dataset without a registered contract", async () => {
    mockListScopedProcessingOperations.mockResolvedValue([]);
    const repository = new ProcessingRepository(database, userId);
    const scope = { datasets: ["activity"] } satisfies Parameters<
      ProcessingRepository["status"]
    >[0];
    Reflect.set(scope.datasets, 0, "missing");

    await expect(repository.status(scope)).rejects.toThrow(
      "Missing processing dataset contract for missing",
    );
  });

  it("maps the latest ingest event into the processing-state operation status", async () => {
    mockListScopedProcessingOperations.mockResolvedValue([
      operation({
        id: "10000000-0000-4000-8000-000000000011",
        events: [
          event(1, { stage: "ingest", status: "failed" }),
          event(3, { stage: "ingest", status: "running" }),
          event(4, { stage: "cdc", status: "failed" }),
        ],
      }),
      operation({
        id: "10000000-0000-4000-8000-000000000012",
        events: [event(1, { stage: "ingest", status: "queued" })],
      }),
      operation({
        id: "10000000-0000-4000-8000-000000000013",
        events: [event(1, { stage: "ingest", status: "succeeded" })],
      }),
      operation({
        id: "10000000-0000-4000-8000-000000000014",
        events: [event(1, { stage: "ingest", status: "failed" })],
      }),
      operation({
        id: "10000000-0000-4000-8000-000000000015",
        events: [event(1, { stage: "ingest", status: "cancelled" })],
      }),
      operation({
        id: "10000000-0000-4000-8000-000000000016",
        events: [event(1, { stage: "ingest", status: "skipped" })],
      }),
      operation({
        id: "10000000-0000-4000-8000-000000000017",
        events: [event(1, { stage: "cdc", status: "running" })],
      }),
    ]);
    const repository = new ProcessingRepository(database, userId);

    await repository.status({ datasets: ["activity"] });

    expect(mockDeriveProcessingState.mock.calls.map(([input]) => input.operationStatus)).toEqual([
      "running",
      "queued",
      "succeeded",
      "failed",
      "cancelled",
      "succeeded",
      undefined,
    ]);
    expect(mockDeriveProcessingState).toHaveBeenNthCalledWith(1, {
      datasetKeys: ["activity"],
      outputManifest: { activity: ["relational", "metric_stream"] },
      events: [
        {
          sequence: 1,
          stage: "ingest",
          status: "failed",
          datasetKey: "activity",
          outputPath: null,
          occurredAt: now,
          progressPercentage: null,
        },
        {
          sequence: 3,
          stage: "ingest",
          status: "running",
          datasetKey: "activity",
          outputPath: null,
          occurredAt: now,
          progressPercentage: null,
        },
        {
          sequence: 4,
          stage: "cdc",
          status: "failed",
          datasetKey: "activity",
          outputPath: null,
          occurredAt: now,
          progressPercentage: null,
        },
      ],
      operationStatus: "running",
      now,
      delayedAfterMs: 900_000,
    });
  });

  it("uses the latest operation for current state and an older ready operation for history", async () => {
    const readyAt = new Date("2026-07-22T17:00:00.000Z");
    mockListScopedProcessingOperations.mockResolvedValue([
      operation({ id: "10000000-0000-4000-8000-000000000021", events: [] }),
      operation({ id: "10000000-0000-4000-8000-000000000022", events: [] }),
    ]);
    mockDeriveProcessingState
      .mockReturnValueOnce({
        overallStatus: "active",
        datasets: [
          {
            datasetKey: "sleep",
            currentStage: "cache_refresh",
            status: "ready",
            progressPercentage: 100,
            lastAdvancedAt: now,
          },
          {
            datasetKey: "activity",
            currentStage: "cdc",
            status: "active",
            progressPercentage: 40,
            lastAdvancedAt: now,
          },
        ],
      })
      .mockReturnValueOnce({
        overallStatus: "ready",
        datasets: [
          {
            datasetKey: "sleep",
            currentStage: "cache_refresh",
            status: "ready",
            progressPercentage: 100,
            lastAdvancedAt: new Date("2026-07-22T16:00:00.000Z"),
          },
          {
            datasetKey: "activity",
            currentStage: "cache_refresh",
            status: "ready",
            progressPercentage: 100,
            lastAdvancedAt: readyAt,
          },
        ],
      });
    const repository = new ProcessingRepository(database, userId);

    const result = await repository.status({ datasets: ["activity"] });

    expect(result.datasets).toEqual([
      {
        key: "activity",
        label: "Activities",
        status: "active",
        currentStage: "cdc",
        progressPercentage: 40,
        lastAdvancedAt: "2026-07-22T18:00:00.000Z",
        lastReadyAt: "2026-07-22T17:00:00.000Z",
      },
    ]);
    expect(result.overallStatus).toBe("active");
  });

  it("ignores newer operations that do not include the requested dataset", async () => {
    mockListScopedProcessingOperations.mockResolvedValue([
      operation({
        id: "10000000-0000-4000-8000-000000000031",
        datasetKeys: ["sleep"],
        outputManifest: { sleep: ["relational"] },
        events: [],
      }),
      operation({ id: "10000000-0000-4000-8000-000000000032", events: [] }),
    ]);
    mockDeriveProcessingState
      .mockReturnValueOnce({
        overallStatus: "ready",
        datasets: [
          {
            datasetKey: "sleep",
            currentStage: "cache_refresh",
            status: "ready",
            progressPercentage: 100,
            lastAdvancedAt: now,
          },
        ],
      })
      .mockReturnValueOnce({
        overallStatus: "active",
        datasets: [
          {
            datasetKey: "activity",
            currentStage: "analytics",
            status: "active",
            progressPercentage: 75,
            lastAdvancedAt: null,
          },
        ],
      });
    const repository = new ProcessingRepository(database, userId);

    const result = await repository.status({ datasets: ["activity"] });

    expect(result.datasets[0]).toEqual({
      key: "activity",
      label: "Activities",
      status: "active",
      currentStage: "analytics",
      progressPercentage: 75,
      lastAdvancedAt: null,
      lastReadyAt: null,
    });
  });

  it("preserves a null ready timestamp when the ready event has no advancement time", async () => {
    mockListScopedProcessingOperations.mockResolvedValue([operation({ events: [] })]);
    mockDeriveProcessingState.mockReturnValue({
      overallStatus: "ready",
      datasets: [
        {
          datasetKey: "activity",
          currentStage: "cache_refresh",
          status: "ready",
          progressPercentage: 100,
          lastAdvancedAt: null,
        },
      ],
    });
    const repository = new ProcessingRepository(database, userId);

    const result = await repository.status({ datasets: ["activity"] });

    expect(result.datasets[0]?.lastAdvancedAt).toBeNull();
    expect(result.datasets[0]?.lastReadyAt).toBeNull();
  });

  it.each<DerivedProcessingStatus>([
    "failed",
    "blocked",
    "delayed",
    "partial",
    "active",
    "waiting",
    "cancelled",
    "ready",
  ])("aggregates a %s dataset status", async (status) => {
    mockListScopedProcessingOperations.mockResolvedValue([operation()]);
    mockDeriveProcessingState.mockReturnValue({
      overallStatus: status,
      datasets: [
        {
          datasetKey: "activity",
          currentStage: "ingest",
          status,
          progressPercentage: null,
          lastAdvancedAt: now,
        },
      ],
    });
    const repository = new ProcessingRepository(database, userId);

    const result = await repository.status({ datasets: ["activity"] });

    expect(result.overallStatus).toBe(status);
  });

  it("prioritizes cancellation over non-failure in-progress statuses", async () => {
    mockListScopedProcessingOperations.mockResolvedValue([
      operation({ datasetKeys: ["activity", "sleep"] }),
    ]);
    mockDeriveProcessingState.mockReturnValue({
      overallStatus: "cancelled",
      datasets: [
        {
          datasetKey: "activity",
          currentStage: "ingest",
          status: "cancelled",
          progressPercentage: null,
          lastAdvancedAt: now,
        },
        {
          datasetKey: "sleep",
          currentStage: "cdc",
          status: "active",
          progressPercentage: 50,
          lastAdvancedAt: now,
        },
      ],
    });
    const repository = new ProcessingRepository(database, userId);

    const result = await repository.status({ datasets: ["activity", "sleep"] });

    expect(result.overallStatus).toBe("cancelled");
  });

  it("turns the current provider analytics failure into a customer alert", async () => {
    mockListScopedProcessingOperations.mockResolvedValue([
      operation({
        providerId: "garmin",
        kind: "provider_sync",
        datasetKeys: ["providers"],
        outputManifest: { providers: ["relational"] },
        events: [
          event(1, {
            stage: "ingest",
            status: "succeeded",
            datasetKey: null,
          }),
          event(2, {
            stage: "analytics",
            status: "failed",
            datasetKey: "providers",
            errorCode: "upstream_skipped",
            errorMessage: "Some analytics calculations could not be completed.",
          }),
        ],
      }),
    ]);
    mockDeriveProcessingState.mockReturnValue({
      overallStatus: "failed",
      datasets: [
        {
          datasetKey: "providers",
          currentStage: "analytics",
          status: "failed",
          progressPercentage: null,
          lastAdvancedAt: now,
        },
      ],
    });
    const repository = new ProcessingRepository(database, userId);

    await expect(repository.alerts()).resolves.toEqual({
      generatedAt: "2026-07-22T18:00:00.000Z",
      alerts: [
        {
          id: `${operationId}:providers`,
          providerId: "garmin",
          providerLabel: "Garmin",
          datasetKey: "providers",
          occurredAt: "2026-07-22T18:00:00.000Z",
          title: "Garmin summary wasn’t updated",
          message:
            "Your Garmin data synced, but its totals and latest-sync information couldn’t be refreshed. Your previously synced data is still available.",
          action: "retry_sync",
          actionLabel: "Retry Garmin sync",
        },
      ],
    });
  });

  it("uses import-specific guidance for a failed file import", async () => {
    mockListScopedProcessingOperations.mockResolvedValue([
      operation({
        providerId: "garmin-dump",
        kind: "file_import",
        datasetKeys: ["activity"],
        events: [
          event(1, {
            stage: "ingest",
            status: "failed",
            datasetKey: "activity",
            errorCode: "file_import_failed",
            errorMessage: "The file could not be imported.",
          }),
        ],
      }),
    ]);
    mockDeriveProcessingState.mockReturnValue({
      overallStatus: "failed",
      datasets: [
        {
          datasetKey: "activity",
          currentStage: "ingest",
          status: "failed",
          progressPercentage: null,
          lastAdvancedAt: now,
        },
      ],
    });
    const repository = new ProcessingRepository(database, userId);

    await expect(repository.alerts()).resolves.toEqual({
      generatedAt: "2026-07-22T18:00:00.000Z",
      alerts: [
        expect.objectContaining({
          providerLabel: "Garmin Dump",
          title: "Garmin Dump file wasn’t imported",
          message:
            "Dofek couldn’t finish importing the Garmin Dump file. Check that you selected the correct file, then import it again.",
          action: "retry_import",
          actionLabel: "Import Garmin Dump again",
        }),
      ],
    });
  });

  it("retries a provider sync when the dataset failed without a matching failure event", async () => {
    mockListScopedProcessingOperations.mockResolvedValue([
      operation({
        providerId: "garmin",
        kind: "provider_sync",
        events: [event(1, { stage: "ingest", status: "succeeded" })],
      }),
    ]);
    mockDeriveProcessingState.mockReturnValue({
      overallStatus: "failed",
      datasets: [
        {
          datasetKey: "activity",
          currentStage: "analytics",
          status: "failed",
          progressPercentage: null,
          lastAdvancedAt: now,
        },
      ],
    });
    const repository = new ProcessingRepository(database, userId);

    await expect(repository.alerts()).resolves.toEqual({
      generatedAt: "2026-07-22T18:00:00.000Z",
      alerts: [
        expect.objectContaining({
          title: "Garmin activities wasn’t updated",
          action: "retry_sync",
        }),
      ],
    });
  });

  it("uses dataset-specific guidance when provider analytics fail", async () => {
    mockListScopedProcessingOperations.mockResolvedValue([
      operation({
        providerId: "garmin",
        kind: "provider_sync",
        events: [
          event(1, {
            stage: "analytics",
            status: "failed",
            datasetKey: "activity",
            errorCode: "analytics_failed",
          }),
        ],
      }),
    ]);
    mockDeriveProcessingState.mockReturnValue({
      overallStatus: "failed",
      datasets: [
        {
          datasetKey: "activity",
          currentStage: "analytics",
          status: "failed",
          progressPercentage: null,
          lastAdvancedAt: now,
        },
      ],
    });
    const repository = new ProcessingRepository(database, userId);

    await expect(repository.alerts()).resolves.toEqual({
      generatedAt: "2026-07-22T18:00:00.000Z",
      alerts: [
        expect.objectContaining({
          title: "Garmin activities wasn’t updated",
          message:
            "Your Garmin data synced, but Dofek couldn’t update activities. Your previously synced data is still available.",
          action: "retry_sync",
        }),
      ],
    });
  });

  it("directs failed provider ingestion to reconnect the named source", async () => {
    mockListScopedProcessingOperations.mockResolvedValue([
      operation({
        providerId: "whoop",
        kind: "provider_sync",
        events: [
          event(1, {
            stage: "ingest",
            status: "failed",
            datasetKey: "activity",
            errorCode: "request_failed",
          }),
        ],
      }),
    ]);
    mockDeriveProcessingState.mockReturnValue({
      overallStatus: "failed",
      datasets: [
        {
          datasetKey: "activity",
          currentStage: "ingest",
          status: "failed",
          progressPercentage: null,
          lastAdvancedAt: now,
        },
      ],
    });
    const repository = new ProcessingRepository(database, userId);

    await expect(repository.alerts()).resolves.toEqual({
      generatedAt: "2026-07-22T18:00:00.000Z",
      alerts: [
        expect.objectContaining({
          providerLabel: "WHOOP (Cloud)",
          title: "WHOOP (Cloud) couldn’t sync",
          action: "reconnect",
          actionLabel: "Reconnect WHOOP (Cloud)",
        }),
      ],
    });
  });

  it("directs a provider-level sync failure to reconnect even after ingestion", async () => {
    mockListScopedProcessingOperations.mockResolvedValue([
      operation({
        providerId: "whoop",
        kind: "provider_sync",
        events: [
          event(1, {
            stage: "analytics",
            status: "failed",
            datasetKey: "activity",
            errorCode: "provider_sync_failed",
          }),
        ],
      }),
    ]);
    mockDeriveProcessingState.mockReturnValue({
      overallStatus: "failed",
      datasets: [
        {
          datasetKey: "activity",
          currentStage: "analytics",
          status: "failed",
          progressPercentage: null,
          lastAdvancedAt: now,
        },
      ],
    });
    const repository = new ProcessingRepository(database, userId);

    await expect(repository.alerts()).resolves.toEqual({
      generatedAt: "2026-07-22T18:00:00.000Z",
      alerts: [
        expect.objectContaining({
          title: "WHOOP (Cloud) couldn’t sync",
          action: "reconnect",
        }),
      ],
    });
  });

  it("uses the latest matching failure when operation events cover several datasets", async () => {
    const latestFailureAt = new Date("2026-07-22T17:45:00.000Z");
    mockListScopedProcessingOperations.mockResolvedValue([
      operation({
        providerId: null,
        events: [
          event(1, {
            stage: "ingest",
            status: "failed",
            datasetKey: "activity",
            occurredAt: new Date("2026-07-22T17:00:00.000Z"),
          }),
          event(2, {
            stage: "analytics",
            status: "succeeded",
            datasetKey: "activity",
            occurredAt: new Date("2026-07-22T17:50:00.000Z"),
          }),
          event(3, {
            stage: "analytics",
            status: "failed",
            datasetKey: "sleep",
            occurredAt: new Date("2026-07-22T17:55:00.000Z"),
          }),
          event(4, {
            stage: "analytics",
            status: "failed",
            datasetKey: null,
            occurredAt: latestFailureAt,
          }),
        ],
      }),
    ]);
    mockDeriveProcessingState.mockReturnValue({
      overallStatus: "failed",
      datasets: [
        {
          datasetKey: "activity",
          currentStage: "analytics",
          status: "failed",
          progressPercentage: null,
          lastAdvancedAt: now,
        },
      ],
    });
    const repository = new ProcessingRepository(database, userId);

    await expect(repository.alerts()).resolves.toEqual({
      generatedAt: "2026-07-22T18:00:00.000Z",
      alerts: [
        {
          id: `${operationId}:activity`,
          providerId: null,
          providerLabel: null,
          datasetKey: "activity",
          occurredAt: latestFailureAt.toISOString(),
          title: "Activities wasn’t updated",
          message:
            "Dofek imported your file, but couldn’t update activities. Your previously imported data is still available.",
          action: "retry_import",
          actionLabel: "Import the file again",
        },
      ],
    });
  });

  it("uses generic import guidance and the operation time when no failure event is available", async () => {
    mockListScopedProcessingOperations.mockResolvedValue([
      operation({
        providerId: null,
        events: [event(1, { stage: "ingest", status: "succeeded" })],
      }),
    ]);
    mockDeriveProcessingState.mockReturnValue({
      overallStatus: "failed",
      datasets: [
        {
          datasetKey: "activity",
          currentStage: "ingest",
          status: "failed",
          progressPercentage: null,
          lastAdvancedAt: null,
        },
      ],
    });
    const repository = new ProcessingRepository(database, userId);

    await expect(repository.alerts()).resolves.toEqual({
      generatedAt: "2026-07-22T18:00:00.000Z",
      alerts: [
        expect.objectContaining({
          occurredAt: "2026-07-22T18:00:00.000Z",
          title: "Activities wasn’t updated",
          message:
            "Dofek imported your file, but couldn’t update activities. Your previously imported data is still available.",
          actionLabel: "Import the file again",
        }),
      ],
    });
  });

  it("falls back to support guidance for a failed recomputation", async () => {
    mockListScopedProcessingOperations.mockResolvedValue([
      operation({
        providerId: "garmin",
        kind: "recompute",
        events: [
          event(1, {
            stage: "analytics",
            status: "failed",
            datasetKey: "activity",
          }),
        ],
      }),
    ]);
    mockDeriveProcessingState.mockReturnValue({
      overallStatus: "failed",
      datasets: [
        {
          datasetKey: "activity",
          currentStage: "analytics",
          status: "failed",
          progressPercentage: null,
          lastAdvancedAt: now,
        },
      ],
    });
    const repository = new ProcessingRepository(database, userId);

    await expect(repository.alerts()).resolves.toEqual({
      generatedAt: "2026-07-22T18:00:00.000Z",
      alerts: [
        {
          id: `${operationId}:activity`,
          providerId: "garmin",
          providerLabel: "Garmin",
          datasetKey: "activity",
          occurredAt: "2026-07-22T18:00:00.000Z",
          title: "Activities wasn’t updated",
          message:
            "Dofek couldn’t update activities. Your existing data is still available. Contact support for help.",
          action: "contact_support",
          actionLabel: "Contact support",
        },
      ],
    });
  });

  it("omits a failed dataset alert when its operation is no longer available", async () => {
    const repository = new ProcessingRepository(database, userId);
    vi.spyOn(repository, "status").mockResolvedValue({
      generatedAt: "2026-07-22T18:00:00.000Z",
      scope: { providerId: null, datasets: ["activity"] },
      overallStatus: "failed",
      datasets: [
        {
          key: "activity",
          label: "Activities",
          status: "failed",
          currentStage: "analytics",
          progressPercentage: null,
          lastAdvancedAt: "2026-07-22T18:00:00.000Z",
          lastReadyAt: null,
        },
      ],
      operations: [],
    });

    await expect(repository.alerts()).resolves.toEqual({
      generatedAt: "2026-07-22T18:00:00.000Z",
      alerts: [],
    });
  });

  it("alerts when a dataset is blocked", async () => {
    mockListScopedProcessingOperations.mockResolvedValue([operation()]);
    mockDeriveProcessingState.mockReturnValue({
      overallStatus: "blocked",
      datasets: [
        {
          datasetKey: "activity",
          currentStage: "analytics",
          status: "blocked",
          progressPercentage: null,
          lastAdvancedAt: now,
        },
      ],
    });
    const repository = new ProcessingRepository(database, userId);

    await expect(repository.alerts()).resolves.toEqual({
      generatedAt: "2026-07-22T18:00:00.000Z",
      alerts: [expect.objectContaining({ datasetKey: "activity", action: "retry_import" })],
    });
  });

  it("does not alert for resolved or in-progress datasets", async () => {
    mockListScopedProcessingOperations.mockResolvedValue([operation()]);
    const repository = new ProcessingRepository(database, userId);

    await expect(repository.alerts()).resolves.toEqual({
      generatedAt: "2026-07-22T18:00:00.000Z",
      alerts: [],
    });
  });

  it("keeps model details private while preserving independent output paths", async () => {
    mockListScopedProcessingOperations.mockResolvedValue([
      operation({
        events: [
          event(1, {}),
          event(2, {
            stage: "canonical_commit",
            outputPath: "relational",
          }),
          event(3, {
            stage: "canonical_commit",
            outputPath: "metric_stream",
          }),
          event(4, {
            stage: "analytics",
            modelName: "activity_summary_rows",
          }),
        ],
      }),
    ]);
    const repository = new ProcessingRepository(database, userId);

    const result = await repository.status({ datasets: ["activity"] });

    expect(result.operations[0]?.timeline).toEqual([
      {
        sequence: 1,
        stage: "ingest",
        status: "succeeded",
        datasetKey: "activity",
        outputPath: null,
        occurredAt: "2026-07-22T18:00:00.000Z",
        progressPercentage: null,
        message: null,
        errorCode: null,
        errorMessage: null,
      },
      {
        sequence: 2,
        stage: "canonical_commit",
        status: "succeeded",
        datasetKey: "activity",
        outputPath: "relational",
        occurredAt: "2026-07-22T18:00:00.000Z",
        progressPercentage: null,
        message: null,
        errorCode: null,
        errorMessage: null,
      },
      {
        sequence: 3,
        stage: "canonical_commit",
        status: "succeeded",
        datasetKey: "activity",
        outputPath: "metric_stream",
        occurredAt: "2026-07-22T18:00:00.000Z",
        progressPercentage: null,
        message: null,
        errorCode: null,
        errorMessage: null,
      },
    ]);
    expect(result.operations[0]?.timeline).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ modelName: expect.any(String) })]),
    );
  });

  it("limits operation details and status to the requested datasets", async () => {
    mockListScopedProcessingOperations.mockResolvedValue([
      operation({
        datasetKeys: ["activity", "sleep"],
        outputManifest: { activity: ["relational"], sleep: ["relational"] },
        events: [
          event(1, { datasetKey: null }),
          event(2, { datasetKey: "activity", stage: "cdc" }),
          event(3, { datasetKey: "sleep", stage: "cdc", status: "failed" }),
        ],
      }),
    ]);
    mockDeriveProcessingState.mockReturnValue({
      overallStatus: "failed",
      datasets: [
        {
          datasetKey: "activity",
          currentStage: "analytics",
          status: "failed",
          progressPercentage: null,
          lastAdvancedAt: now,
        },
        {
          datasetKey: "sleep",
          currentStage: "cache_refresh",
          status: "ready",
          progressPercentage: 100,
          lastAdvancedAt: now,
        },
      ],
    });
    const repository = new ProcessingRepository(database, userId);

    const result = await repository.status({ datasets: ["activity"] });

    expect(result.operations[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        datasets: ["activity"],
        timeline: [
          expect.objectContaining({ datasetKey: null }),
          expect.objectContaining({ datasetKey: "activity" }),
        ],
      }),
    );
  });

  it("does not include a dataset failure outside the requested scope", async () => {
    mockListScopedProcessingOperations.mockResolvedValue([
      operation({
        datasetKeys: ["activity", "sleep"],
        outputManifest: { activity: ["relational"], sleep: ["relational"] },
      }),
    ]);
    mockDeriveProcessingState.mockReturnValue({
      overallStatus: "failed",
      datasets: [
        {
          datasetKey: "activity",
          currentStage: "cache_refresh",
          status: "ready",
          progressPercentage: 100,
          lastAdvancedAt: now,
        },
        {
          datasetKey: "sleep",
          currentStage: "analytics",
          status: "failed",
          progressPercentage: null,
          lastAdvancedAt: now,
        },
      ],
    });
    const repository = new ProcessingRepository(database, userId);

    const result = await repository.status({ datasets: ["activity"] });

    expect(result.operations[0]?.status).toBe("ready");
  });

  it("delegates history with the authenticated user and pagination", async () => {
    const page = { operations: [], nextCursor: null };
    mockListProcessingHistory.mockResolvedValue(page);
    const repository = new ProcessingRepository(database, userId);

    await expect(repository.history({ cursor: operationId, limit: 25 })).resolves.toBe(page);
    expect(mockListProcessingHistory).toHaveBeenCalledWith(database, {
      userId,
      cursor: operationId,
      limit: 25,
    });
  });
});
