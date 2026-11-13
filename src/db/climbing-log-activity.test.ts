import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTransactionalTestDatabase } from "../providers/test-helpers.ts";

const mocks = vi.hoisted(() => {
  const knownRows: Array<{ id: string }> = [];
  return { upsert: vi.fn(), execute: vi.fn().mockResolvedValue([]), knownRows };
});

vi.mock("./provider-activity-sync.ts", () => ({ upsertProviderActivity: mocks.upsert }));

import { persistClimbingLogActivityObservation } from "./climbing-log-activity.ts";

const userId = "00000000-0000-0000-0000-000000000001";
const source = {
  externalId: "kilter:log:one",
  sourceName: "Kilter Board",
  activityObservation: { recordedAt: "2026-11-10T01:48:51.544Z", gymExternalId: "gym-one" },
};

function makeDatabase() {
  return makeTransactionalTestDatabase({
    select: vi.fn().mockReturnValue({
      from: () => ({ where: () => Promise.resolve(mocks.knownRows) }),
    }),
    insert: vi.fn(),
    delete: vi.fn(),
    execute: mocks.execute,
  });
}

describe("persistClimbingLogActivityObservation", () => {
  beforeEach(() => {
    mocks.upsert.mockReset();
    mocks.execute.mockClear();
    mocks.knownRows.length = 0;
  });

  it("keeps the supplied activity when the source has no observation", async () => {
    const result = await persistClimbingLogActivityObservation(makeDatabase(), {
      userId,
      providerId: "kilter",
      source: { externalId: source.externalId },
      activityId: "selected-activity",
    });

    expect(result).toEqual({ activityId: "selected-activity", observed: false });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("reports the upserted point as observed and leaves the home zone to the ingest context", async () => {
    mocks.upsert.mockResolvedValue({ id: "point-activity" });

    const result = await persistClimbingLogActivityObservation(makeDatabase(), {
      userId,
      providerId: "kilter",
      source,
      activityId: null,
    });

    expect(result).toEqual({ activityId: "point-activity", observed: true });
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId, providerId: "kilter", externalId: source.externalId }),
      expect.anything(),
    );
    expect(mocks.upsert.mock.calls[0]?.[1]).not.toHaveProperty("homeTimezone");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("retires the standalone point without observing it when the user attached another activity", async () => {
    mocks.knownRows.push({ id: "standalone-point" });

    const result = await persistClimbingLogActivityObservation(makeDatabase(), {
      userId,
      providerId: "kilter",
      source,
      activityId: "recorded-workout",
    });

    expect(result).toEqual({ activityId: "recorded-workout", observed: false });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("fails when the activity upsert returns no row", async () => {
    mocks.upsert.mockResolvedValue(undefined);

    await expect(
      persistClimbingLogActivityObservation(makeDatabase(), {
        userId,
        providerId: "kilter",
        source,
        activityId: null,
      }),
    ).rejects.toThrow("Climbing log activity insert returned no row.");
  });
});
