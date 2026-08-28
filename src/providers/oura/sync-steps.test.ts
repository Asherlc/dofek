import { afterEach, describe, expect, it, vi } from "vitest";

const syncLogMocks = vi.hoisted<{
  outcomes: Array<{ result: number; degradations?: unknown[] }>;
  withSyncLog: ReturnType<typeof vi.fn>;
}>(() => ({
  outcomes: [],
  withSyncLog: vi.fn(
    async (
      _db: unknown,
      _providerId: string,
      _dataType: string,
      callback: () => Promise<{ result: number; degradations?: unknown[] }>,
    ) => {
      const outcome = await callback();
      syncLogMocks.outcomes.push(outcome);
      return outcome.result;
    },
  ),
}));

vi.mock("../../db/sync-log.ts", () => ({
  withSyncLog: syncLogMocks.withSyncLog,
}));

import { OuraApiError, OuraClient } from "./client.ts";
import { syncCardiovascularAge, syncDailyResilience, syncDailyStress } from "./sync-steps.ts";

function context(client: OuraClient) {
  return {
    db: Object.create(null),
    providerId: "oura",
    client,
    sinceDate: "2026-06-01",
    todayDate: "2026-06-30",
    errors: [],
  };
}

describe("Oura optional sync steps", () => {
  afterEach(() => {
    vi.clearAllMocks();
    syncLogMocks.outcomes.length = 0;
  });

  it("records missing daily-stress scope as a degradation without failing the sync", async () => {
    const client = new OuraClient("token", vi.fn());
    const getDailyStress = vi
      .spyOn(client, "getDailyStress")
      .mockRejectedValue(new OuraApiError(401, "/daily_stress", "missing scope"));
    const syncContext = context(client);

    const result = await syncDailyStress(syncContext);

    expect(result).toBe(0);
    expect(syncContext.errors).toEqual([]);
    expect(getDailyStress).toHaveBeenCalledWith("2026-06-01", "2026-06-30", undefined);
    expect(syncLogMocks.outcomes).toEqual([
      expect.objectContaining({
        degradations: [
          expect.objectContaining({
            kind: "optional_endpoint_unavailable",
            providerId: "oura",
            stepName: "daily_stress",
          }),
        ],
      }),
    ]);
  });

  it("records missing daily-resilience scope as a degradation without failing the sync", async () => {
    const client = new OuraClient("token", vi.fn());
    vi.spyOn(client, "getDailyResilience").mockRejectedValue(
      new OuraApiError(401, "/daily_resilience", "missing scope"),
    );
    const syncContext = context(client);

    const result = await syncDailyResilience(syncContext);

    expect(result).toBe(0);
    expect(syncContext.errors).toEqual([]);
    expect(syncLogMocks.outcomes[0]).toMatchObject({
      degradations: [expect.objectContaining({ stepName: "daily_resilience" })],
    });
  });

  it("records missing cardiovascular-age scope as a degradation without failing the sync", async () => {
    const client = new OuraClient("token", vi.fn());
    vi.spyOn(client, "getDailyCardiovascularAge").mockRejectedValue(
      new OuraApiError(401, "/daily_cardiovascular_age", "missing scope"),
    );
    const syncContext = context(client);

    const result = await syncCardiovascularAge(syncContext);

    expect(result).toBe(0);
    expect(syncContext.errors).toEqual([]);
    expect(syncLogMocks.outcomes[0]).toMatchObject({
      degradations: [expect.objectContaining({ stepName: "cardiovascular_age" })],
    });
  });

  it("surfaces non-permission daily-stress failures", async () => {
    const client = new OuraClient("token", vi.fn());
    vi.spyOn(client, "getDailyStress").mockRejectedValue(
      new OuraApiError(500, "/daily_stress", "unavailable"),
    );
    const syncContext = context(client);

    const result = await syncDailyStress(syncContext);

    expect(result).toBe(0);
    expect(syncContext.errors).toEqual([
      expect.objectContaining({
        message: "daily_stress: API error 500 on /daily_stress: unavailable",
      }),
    ]);
    expect(syncLogMocks.outcomes).toEqual([]);
  });
});
