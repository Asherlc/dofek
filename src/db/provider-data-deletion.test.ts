import { describe, expect, it, vi } from "vitest";
import {
  createProviderDataDeletionRequest,
  getProviderDataGeneration,
  listPendingProviderDataDeletionRequests,
} from "./provider-data-deletion.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const eventId = "10000000-0000-4000-8000-000000000001";

describe("provider data deletion persistence", () => {
  it("uses generation zero until a deletion advances the fencing token", async () => {
    const execute = vi.fn().mockResolvedValue([]);

    await expect(getProviderDataGeneration({ execute }, userId, "garmin")).resolves.toBe(0);
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
});
