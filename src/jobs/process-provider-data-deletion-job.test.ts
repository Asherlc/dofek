import { randomUUID } from "node:crypto";
import { DelayedError } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetricStreamProviderGenerationDeletedEvent } from "../metric-stream/events.ts";
import type {
  ProviderDeletionAcknowledgement,
  ProviderDeletionSourceKey,
} from "../metric-stream/provider-generation-deletion.ts";
import {
  type ProviderDataDeletionDependencies,
  type ProviderDataDeletionJob,
  processProviderDataDeletionJob,
} from "./process-provider-data-deletion-job.ts";
import type { ProviderDataDeletionJobData } from "./queues.ts";

const captureException = vi.hoisted(() => vi.fn());
const invalidateAllUserQueries = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../lib/error-reporting.ts", () => ({ captureException }));
vi.mock("dofek/lib/cache", () => ({ invalidateAllUserQueries }));
afterEach(() => {
  vi.clearAllMocks();
});

function fixture() {
  let stored: ProviderDataDeletionJobData = {
    type: "provider-data-deletion",
    eventId: randomUUID(),
    userId: randomUUID(),
    providerId: "garmin",
    generation: 2,
  };
  const acknowledgements = new Map<string, ProviderDeletionAcknowledgement>();
  const published: MetricStreamProviderGenerationDeletedEvent[] = [];
  const persist = (data: ProviderDataDeletionJobData) => {
    stored = structuredClone(data);
  };
  const job = {
    data: structuredClone(stored),
    assertActive: vi.fn(async () => undefined),
    updateData: vi.fn(async (data: ProviderDataDeletionJobData) => {
      persist(data);
    }),
    updateProgress: vi.fn(
      async (_progress: Parameters<ProviderDataDeletionJob["updateProgress"]>[0]) => undefined,
    ),
    deferUntilReceipt: vi.fn(async (): Promise<never> => {
      throw new DelayedError();
    }),
  };
  const dependencies = {
    accountErasureAllowsWork: vi.fn(async (_kind: string) => true),
    publishProviderGenerationDeletion: vi.fn(
      async (command: MetricStreamProviderGenerationDeletedEvent) => {
        expect(stored.pendingCommand?.command).toEqual(command);
        published.push(structuredClone(command));
      },
    ),
    readCommandAcknowledgement: vi.fn(
      async (command: MetricStreamProviderGenerationDeletedEvent) =>
        acknowledgements.get(command.commandId) ?? null,
    ),
    readSourcePage: vi.fn<ProviderDataDeletionDependencies["readSourcePage"]>(async () => []),
    deleteProviderArtifacts: vi.fn(async (_user: string, _provider: string) => undefined),
    enqueueAnalyticsRefresh: vi.fn(
      async (_user: string, _provider: string, _event: string) => undefined,
    ),
    markCompleted: vi.fn(async (_event: string) => undefined),
  };
  const acknowledge = (effectCount: bigint) => {
    const command = job.data.pendingCommand?.command;
    if (!command) throw new Error("No saved command to acknowledge");
    acknowledgements.set(command.commandId, {
      effectCount,
      position: {
        transport: "kafka",
        epoch: "unit-log",
        topic: "unit-topic",
        partition: 0,
        offset: String(acknowledgements.size),
      },
    });
    return command;
  };
  return {
    job,
    dependencies,
    published,
    acknowledgements,
    acknowledge,
    persist,
    reload: () => {
      job.data = structuredClone(stored);
    },
    stored: () => structuredClone(stored),
  };
}

async function deferred(value: ReturnType<typeof fixture>) {
  await expect(
    processProviderDataDeletionJob(value.job, value.dependencies),
  ).rejects.toBeInstanceOf(DelayedError);
}
async function terminalState(value: ReturnType<typeof fixture>) {
  await deferred(value);
  value.acknowledge(0n);
  await deferred(value);
  value.acknowledge(0n);
}

describe("provider deletion durable command driver", () => {
  it("saves and publishes a stable fence-only command before deferring for its ACK", async () => {
    const value = fixture();
    await deferred(value);
    expect(value.published).toEqual([
      expect.objectContaining({ sourceIds: [], complete: false, previousCommandId: null }),
    ]);
    expect(value.dependencies.readSourcePage).not.toHaveBeenCalled();
    expect(value.dependencies.markCompleted).not.toHaveBeenCalled();
  });
  it("reuses the saved command after save succeeds but its response is lost before publication", async () => {
    const value = fixture();
    value.job.updateData.mockImplementationOnce(async (data) => {
      value.persist(data);
      throw new Error("save response lost");
    });
    await expect(processProviderDataDeletionJob(value.job, value.dependencies)).rejects.toThrow(
      "save response lost",
    );
    const saved = value.stored().pendingCommand?.command;
    expect(saved).toBeDefined();
    expect(value.published).toEqual([]);
    value.reload();
    await deferred(value);
    expect(value.published).toEqual([saved]);
  });
  it("reuses identical content after publication response loss and before ACK", async () => {
    const value = fixture();
    value.dependencies.publishProviderGenerationDeletion.mockImplementationOnce(async (command) => {
      value.published.push(structuredClone(command));
      throw new Error("publish response lost");
    });
    await expect(processProviderDataDeletionJob(value.job, value.dependencies)).rejects.toThrow(
      "publish response lost",
    );
    const first = value.published[0];
    value.reload();
    await deferred(value);
    expect(value.published).toEqual([first, first]);
    expect(value.dependencies.readSourcePage).not.toHaveBeenCalled();
  });
  it("observes the fence ACK before enumerating even an empty provider", async () => {
    const value = fixture();
    await deferred(value);
    const fence = value.acknowledge(0n);
    await deferred(value);
    expect(value.published[1]).toMatchObject({
      complete: true,
      sourceIds: [],
      previousCommandId: fence.commandId,
    });
    expect(value.dependencies.markCompleted).not.toHaveBeenCalled();
    value.acknowledge(0n);
    await processProviderDataDeletionJob(value.job, value.dependencies);
    expect(value.dependencies.deleteProviderArtifacts).toHaveBeenCalledWith(
      value.job.data.userId,
      "garmin",
    );
    expect(value.dependencies.enqueueAnalyticsRefresh).toHaveBeenCalledWith(
      value.job.data.userId,
      "garmin",
      value.job.data.eventId,
    );
    expect(invalidateAllUserQueries).toHaveBeenCalledWith(value.job.data.userId);
    expect(value.dependencies.markCompleted).toHaveBeenCalledWith(value.job.data.eventId);
    expect(value.dependencies.deleteProviderArtifacts.mock.invocationCallOrder[0]).toBeLessThan(
      value.dependencies.enqueueAnalyticsRefresh.mock.invocationCallOrder[0] ?? 0,
    );
    expect(value.dependencies.enqueueAnalyticsRefresh.mock.invocationCallOrder[0]).toBeLessThan(
      value.dependencies.markCompleted.mock.invocationCallOrder[0] ?? 0,
    );
  });
  it("keeps a page identity and cursor stable across ACK-before-checkpoint failure", async () => {
    const value = fixture();
    const source = { generation: 0, id: randomUUID() };
    value.dependencies.readSourcePage.mockResolvedValueOnce([source]).mockResolvedValue([]);
    await deferred(value);
    value.acknowledge(0n);
    await deferred(value);
    const page = value.acknowledge(1n);
    value.job.updateData.mockRejectedValueOnce(new Error("checkpoint save failed"));
    await expect(processProviderDataDeletionJob(value.job, value.dependencies)).rejects.toThrow(
      "checkpoint save failed",
    );
    value.reload();
    expect(value.job.data.pendingCommand?.command).toEqual(page);
    await deferred(value);
    expect(value.job.data.checkpoint).toMatchObject({
      batches: 1,
      examinedRows: 1,
      deletedRows: 1,
      lastGeneration: 0,
      lastId: source.id,
    });
    expect(value.published.filter((command) => command.commandId === page.commandId)).toHaveLength(
      1,
    );
    expect(value.published.at(-1)?.previousCommandId).toBe(page.commandId);
  });
  it("processes more than1000 sources in bounded delayed steps of the same durable job", async () => {
    const value = fixture();
    const sources: ProviderDeletionSourceKey[] = Array.from({ length: 1001 }, (_, index) => ({
      generation: index < 1000 ? 0 : 1,
      id: randomUUID(),
    }));
    value.dependencies.readSourcePage
      .mockResolvedValueOnce(sources.slice(0, 1000))
      .mockResolvedValueOnce(sources.slice(1000))
      .mockResolvedValue([]);
    await deferred(value);
    value.acknowledge(0n);
    await deferred(value);
    value.acknowledge(1000n);
    await deferred(value);
    value.acknowledge(1n);
    await deferred(value);
    value.acknowledge(0n);
    await processProviderDataDeletionJob(value.job, value.dependencies);
    expect(value.published.map((command) => command.sourceIds.length)).toEqual([0, 1000, 1, 0]);
    expect(value.job.data.checkpoint).toMatchObject({
      batches: 2,
      examinedRows: 1001,
      deletedRows: 1001,
      lastGeneration: 1,
      lastId: sources[1000]?.id,
    });
    expect(value.job.deferUntilReceipt).toHaveBeenCalledTimes(4);
    expect(value.dependencies.markCompleted).toHaveBeenCalledOnce();
  });
  it("fails on missing committed ACK rather than resetting the chain", async () => {
    const value = fixture();
    await deferred(value);
    const fence = value.acknowledge(0n);
    await deferred(value);
    value.job.data = { ...value.job.data, pendingCommand: undefined };
    value.acknowledgements.delete(fence.commandId);
    await expect(processProviderDataDeletionJob(value.job, value.dependencies)).rejects.toThrow(
      "operator recovery",
    );
    expect(value.dependencies.markCompleted).not.toHaveBeenCalled();
  });
  it("keeps pending evidence when receipt verification fails", async () => {
    const value = fixture();
    await deferred(value);
    const pending = value.stored().pendingCommand;
    value.dependencies.readCommandAcknowledgement.mockRejectedValueOnce(
      new Error("receipt unavailable"),
    );
    await expect(processProviderDataDeletionJob(value.job, value.dependencies)).rejects.toThrow(
      "receipt unavailable",
    );
    expect(value.stored().pendingCommand).toEqual(pending);
    expect(value.dependencies.enqueueAnalyticsRefresh).not.toHaveBeenCalled();
  });
  it("retains pending state when account erasure blocks publication", async () => {
    const value = fixture();
    value.dependencies.accountErasureAllowsWork.mockImplementation(
      async (kind) => kind !== "provider deletion command publication",
    );
    await processProviderDataDeletionJob(value.job, value.dependencies);
    expect(value.stored().pendingCommand?.command).toMatchObject({
      sourceIds: [],
      previousCommandId: null,
    });
    expect(value.published).toEqual([]);
    expect(value.dependencies.markCompleted).not.toHaveBeenCalled();
  });
  it("stops artifacts and completion when account erasure takes ownership", async () => {
    const value = fixture();
    await terminalState(value);
    value.dependencies.accountErasureAllowsWork.mockImplementation(
      async (kind) => kind !== "provider artifact deletion",
    );
    await processProviderDataDeletionJob(value.job, value.dependencies);
    expect(value.dependencies.deleteProviderArtifacts).not.toHaveBeenCalled();
    expect(value.dependencies.markCompleted).not.toHaveBeenCalled();
  });
  it("preserves terminal source proof when retained artifact cleanup fails", async () => {
    const value = fixture();
    await terminalState(value);
    value.dependencies.deleteProviderArtifacts.mockRejectedValueOnce(
      new Error("artifact cleanup failed"),
    );
    await expect(processProviderDataDeletionJob(value.job, value.dependencies)).rejects.toThrow(
      "artifact cleanup failed",
    );
    expect(value.job.data.lastCommittedCommand?.complete).toBe(true);
    expect(value.dependencies.enqueueAnalyticsRefresh).not.toHaveBeenCalled();
    expect(value.dependencies.markCompleted).not.toHaveBeenCalled();
  });
  it("reports progress failures while preserving completed source and artifact work", async () => {
    const value = fixture();
    await terminalState(value);
    value.job.updateProgress.mockRejectedValue(new Error("progress unavailable"));
    await processProviderDataDeletionJob(value.job, value.dependencies);
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "progress unavailable" }),
      expect.any(Object),
    );
    expect(value.dependencies.markCompleted).toHaveBeenCalledOnce();
  });
  it("fails closed on lost active ownership after publication", async () => {
    const value = fixture();
    value.dependencies.publishProviderGenerationDeletion.mockImplementation(async (command) => {
      value.published.push(command);
      value.job.assertActive.mockRejectedValue(new Error("job lock lost"));
    });
    await expect(processProviderDataDeletionJob(value.job, value.dependencies)).rejects.toThrow(
      "job lock lost",
    );
    expect(value.stored().pendingCommand?.command).toEqual(value.published[0]);
    expect(value.job.deferUntilReceipt).not.toHaveBeenCalled();
    expect(value.dependencies.markCompleted).not.toHaveBeenCalled();
  });
  it("rejects pre-protocol cursor state without altering its original deletion identity", async () => {
    const value = fixture();
    const eventId = value.job.data.eventId;
    value.job.data = {
      ...value.job.data,
      checkpoint: { batches: 1, deletedRows: 1000, lastGeneration: 0, lastId: randomUUID() },
    };
    await expect(processProviderDataDeletionJob(value.job, value.dependencies)).rejects.toThrow(
      "operator redrive",
    );
    expect(value.job.data.eventId).toBe(eventId);
    expect(value.published).toEqual([]);
  });
});
