import { describe, expect, it, vi } from "vitest";
import {
  createProviderDataDeletionRequest,
  getProviderDataGenerations,
  listPendingProviderDataDeletionRequests,
  markProviderDataDeletionCompleted,
} from "./provider-data-deletion.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const eventId = "10000000-0000-4000-8000-000000000001";

async function findProviderDataDeletionRequestWithFreshSchema(execute: ReturnType<typeof vi.fn>) {
  vi.resetModules();
  const { findProviderDataDeletionRequest } = await import("./provider-data-deletion.ts");
  return findProviderDataDeletionRequest({ execute }, userId, "garmin", eventId);
}

describe("provider data deletion persistence", () => {
  it("uses generation zero until a deletion advances the fencing token", async () => {
    const execute = vi
      .fn()
      .mockResolvedValue([{ generation: "0", provider_id: "garmin", user_id: userId }]);

    await expect(
      getProviderDataGenerations({ execute }, [{ providerId: "garmin", userId }]),
    ).resolves.toEqual([{ generation: 0, providerId: "garmin", userId }]);
  });

  it("does not query generations for an empty scope batch", async () => {
    const execute = vi.fn();

    await expect(getProviderDataGenerations({ execute }, [])).resolves.toEqual([]);
    expect(execute).not.toHaveBeenCalled();
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
        generation: "3",
        provider_id: "garmin",
        status: "dispatched",
        user_id: userId,
      },
    ]);

    await expect(findProviderDataDeletionRequestWithFreshSchema(execute)).resolves.toEqual({
      eventId,
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
        status: "failed",
        user_id: userId,
      },
    ]);

    await expect(findProviderDataDeletionRequestWithFreshSchema(execute)).rejects.toThrow();
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
});
