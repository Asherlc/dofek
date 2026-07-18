import { describe, expect, it, vi } from "vitest";
import { dispatchProviderDataDeletionOutbox } from "./provider-data-deletion-outbox.ts";

describe("dispatchProviderDataDeletionOutbox", () => {
  it("enqueues pending requests before marking them dispatched", async () => {
    const eventId = "30000000-0000-4000-8000-000000000003";
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        {
          event_id: eventId,
          generation: "2",
          provider_id: "garmin",
          user_id: "00000000-0000-4000-8000-000000000004",
        },
      ])
      .mockResolvedValueOnce([]);
    const add = vi.fn(async () => undefined);

    await expect(dispatchProviderDataDeletionOutbox({ execute }, { add }, 100)).resolves.toBe(1);

    expect(add).toHaveBeenCalledWith(
      "provider-data-deletion",
      expect.objectContaining({ eventId, generation: 2 }),
      expect.objectContaining({ jobId: eventId }),
    );
    expect(add.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[1] ?? 0);
  });
});
