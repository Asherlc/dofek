import { describe, expect, it, vi } from "vitest";
import {
  createProviderDataDeletionRequest,
  getProviderDataGenerations,
  listPendingProviderDataDeletionRequests,
  markProviderDataDeletionCompleted,
  markProviderDataDeletionFailed,
} from "./provider-data-deletion.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const eventId = "10000000-0000-4000-8000-000000000001";
const operationRevision = "1000000000000000";

async function findProviderDataDeletionRequestWithFreshSchema(execute: CallableVitestMock) {
  vi.resetModules();
  const { findProviderDataDeletionRequest } = await import("./provider-data-deletion.ts");
  return findProviderDataDeletionRequest({ execute }, userId, "garmin", eventId);
}

describe("provider data deletion persistence", () => {
  it("uses generation zero until a deletion advances the fencing token", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        generation: "0",
        operation_revision: operationRevision,
        provider_id: "garmin",
        user_id: userId,
      },
    ]);

    await expect(
      getProviderDataGenerations({ execute }, [{ providerId: "garmin", userId }]),
    ).resolves.toEqual({
      generations: [{ generation: 0, providerId: "garmin", userId }],
      operationRevision,
    });
  });

  it("allocates a revision for an empty replacement batch", async () => {
    const execute = vi.fn().mockResolvedValue([{ operation_revision: operationRevision }]);

    await expect(getProviderDataGenerations({ execute }, [])).resolves.toEqual({
      generations: [],
      operationRevision,
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("fails when an empty replacement batch cannot allocate a revision", async () => {
    const execute = vi.fn().mockResolvedValue([]);

    await expect(getProviderDataGenerations({ execute }, [])).rejects.toThrow(
      "Metric stream operation revision was not allocated",
    );
  });

  it("fails when requested provider scopes return no generation rows", async () => {
    const execute = vi.fn().mockResolvedValue([]);

    await expect(
      getProviderDataGenerations({ execute }, [{ providerId: "garmin", userId }]),
    ).rejects.toThrow("Metric stream operation revision was not allocated");
  });

  it("rejects malformed provider generation rows", async () => {
    const execute = vi.fn().mockResolvedValue([{}]);

    await expect(
      getProviderDataGenerations({ execute }, [{ providerId: "garmin", userId }]),
    ).rejects.toThrow();
  });

  it("creates an outbox request with the newly active generation", async () => {
    const execute = vi
      .fn()
      .mockResolvedValue([
        { event_id: eventId, generation: "3", provider_id: "garmin", user_id: userId },
      ]);

    await expect(
      createProviderDataDeletionRequest({ execute }, userId, "garmin", eventId),
    ).resolves.toEqual({ eventId, generation: 3, providerId: "garmin", userId });
  });

  it("fails when creating an outbox request returns no row", async () => {
    const execute = vi.fn().mockResolvedValue([]);

    await expect(
      createProviderDataDeletionRequest({ execute }, userId, "garmin", eventId),
    ).rejects.toThrow("Failed to create provider data deletion outbox request");
  });

  it("rejects malformed outbox request rows", async () => {
    const execute = vi.fn().mockResolvedValue([{}]);

    await expect(
      createProviderDataDeletionRequest({ execute }, userId, "garmin", eventId),
    ).rejects.toThrow();
  });

  it("returns pending outbox requests in dispatch order", async () => {
    const execute = vi
      .fn()
      .mockResolvedValue([
        { event_id: eventId, generation: "3", provider_id: "garmin", user_id: userId },
      ]);

    await expect(listPendingProviderDataDeletionRequests({ execute }, 25)).resolves.toEqual([
      { eventId, generation: 3, providerId: "garmin", userId },
    ]);
  });

  it("finds a user-scoped deletion request with its lifecycle status", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        event_id: eventId,
        failure_reason: null,
        generation: "3",
        provider_id: "garmin",
        status: "dispatched",
        user_id: userId,
      },
    ]);

    await expect(findProviderDataDeletionRequestWithFreshSchema(execute)).resolves.toEqual({
      eventId,
      failureReason: null,
      generation: 3,
      providerId: "garmin",
      status: "dispatched",
      userId,
    });
  });

  it("rejects deletion request rows without a lifecycle status", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        event_id: eventId,
        generation: "3",
        provider_id: "garmin",
        user_id: userId,
      },
    ]);

    await expect(findProviderDataDeletionRequestWithFreshSchema(execute)).rejects.toThrow();
  });

  it("rejects deletion request rows with an unsupported lifecycle status", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        event_id: eventId,
        generation: "3",
        provider_id: "garmin",
        status: "cancelled",
        user_id: userId,
      },
    ]);

    await expect(findProviderDataDeletionRequestWithFreshSchema(execute)).rejects.toThrow();
  });

  it("finds a failed deletion request with its durable failure reason", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        event_id: eventId,
        failure_reason: "ClickHouse rejected the deletion",
        generation: "3",
        provider_id: "garmin",
        status: "failed",
        user_id: userId,
      },
    ]);

    await expect(findProviderDataDeletionRequestWithFreshSchema(execute)).resolves.toEqual({
      eventId,
      failureReason: "ClickHouse rejected the deletion",
      generation: 3,
      providerId: "garmin",
      status: "failed",
      userId,
    });
  });

  it("returns null when a user-scoped deletion request does not exist", async () => {
    const execute = vi.fn().mockResolvedValue([]);

    await expect(findProviderDataDeletionRequestWithFreshSchema(execute)).resolves.toBeNull();
  });

  it("marks an outbox request completed", async () => {
    const execute = vi.fn().mockResolvedValue([]);

    await markProviderDataDeletionCompleted({ execute }, eventId);

    expect(execute).toHaveBeenCalledOnce();
  });

  it("marks an outbox request failed with its reason", async () => {
    const execute = vi.fn().mockResolvedValue([]);

    await markProviderDataDeletionFailed({ execute }, eventId, "ClickHouse unavailable");

    expect(execute).toHaveBeenCalledOnce();
  });
});
