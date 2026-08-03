import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

const { mockCachedProtectedQuery, mockInvalidateUserQueryDomains } = vi.hoisted(() => ({
  mockCachedProtectedQuery: vi.fn(),
  mockInvalidateUserQueryDomains: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("dofek/lib/cache", () => ({
  invalidateUserQueryDomains: mockInvalidateUserQueryDomains,
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string;
      timezone: string;
    }>()
    .create();
  mockCachedProtectedQuery.mockImplementation(() => trpc.procedure);
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: mockCachedProtectedQuery,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

import { subjectiveRouter } from "./subjective.ts";

const createCaller = createTestCallerFactory(subjectiveRouter);

function makeCaller(responses: unknown[][] = []) {
  const execute = vi.fn();
  for (const response of responses) execute.mockResolvedValueOnce(response);
  execute.mockResolvedValue([]);
  const db = { execute, transaction: vi.fn() };
  db.transaction.mockImplementation(async (callback) => callback(db));
  return { caller: createCaller({ db, userId: "user-1", timezone: "UTC" }), execute };
}

const checkInRow = {
  id: "30000000-0000-4000-8000-000000002247",
  date: "2026-08-02",
  created_at: "2026-08-02T08:00:00Z",
  updated_at: "2026-08-02T08:00:00Z",
};

describe("subjectiveRouter", () => {
  beforeEach(() => {
    mockCachedProtectedQuery.mockClear();
    mockInvalidateUserQueryDomains.mockClear();
  });

  it("returns explicit not-logged state for a date without a check-in", async () => {
    const { caller } = makeCaller([[]]);
    await expect(caller.checkIn({ date: "2026-08-02" })).resolves.toEqual({
      date: "2026-08-02",
      logged: false,
      symptoms: [],
    });
  });

  it("persists an all-clear check-in and invalidates only subjective caches", async () => {
    const { caller } = makeCaller([[checkInRow], [], [checkInRow], []]);
    await expect(caller.saveCheckIn({ date: "2026-08-02", symptoms: [] })).resolves.toEqual({
      date: "2026-08-02",
      logged: true,
      symptoms: [],
    });
    expect(mockInvalidateUserQueryDomains).toHaveBeenCalledWith("user-1", ["subjective"]);
  });

  it("rejects invalid symptom scores before touching the database", async () => {
    const { caller, execute } = makeCaller();
    await expect(
      caller.saveCheckIn({
        date: "2026-08-02",
        symptoms: [{ bodyRegionId: "left_hand", kind: "soreness", score: 0 }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an injury resolution date before its onset date", async () => {
    const { caller, execute } = makeCaller();

    await expect(
      caller.createInjury({
        kind: "injury",
        bodyRegionId: "left_hand",
        onsetDate: "2026-08-02",
        resolvedDate: "2026-08-01",
        severity: 4,
        description: "Finger pain",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "An injury resolution date must not be before its onset date",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects invalid calendar dates before touching the database", async () => {
    const { caller, execute } = makeCaller();
    await expect(caller.checkIn({ date: "2026-02-30" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects reversed timeline windows with an actionable error", async () => {
    const { caller, execute } = makeCaller();
    await expect(
      caller.timeline({ startDate: "2026-08-03", endDate: "2026-08-02" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "The subjective timeline start date must not be after its end date",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND when updating another user's injury", async () => {
    const { caller } = makeCaller([[]]);
    await expect(
      caller.updateInjury({
        id: "50000000-0000-4000-8000-000000002247",
        severity: 3,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects an update whose effective resolution date precedes the stored onset", async () => {
    const injury = {
      id: "50000000-0000-4000-8000-000000002247",
      kind: "niggle",
      body_region_id: "left_hand",
      onset_date: "2026-08-02",
      resolved_date: null,
      severity: 3,
      description: "Hand soreness",
      created_at: "2026-08-02T08:00:00.000Z",
      updated_at: "2026-08-02T08:00:00.000Z",
    };
    const { caller, execute } = makeCaller([[injury]]);

    await expect(
      caller.updateInjury({ id: injury.id, resolvedDate: "2026-08-01" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "An injury resolution date must not be before its onset date",
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("updates an injury and invalidates subjective caches", async () => {
    const injury = {
      id: "50000000-0000-4000-8000-000000002247",
      kind: "niggle",
      body_region_id: "left_hand",
      onset_date: "2026-08-02",
      resolved_date: null,
      severity: 3,
      description: "Updated hand soreness",
      created_at: "2026-08-02T08:00:00.000Z",
      updated_at: "2026-08-02T08:00:00.000Z",
    };
    const { caller } = makeCaller([[injury], [injury]]);

    await expect(
      caller.updateInjury({
        id: injury.id,
        severity: 3,
        description: "Updated hand soreness",
      }),
    ).resolves.toEqual(injury);
    expect(mockInvalidateUserQueryDomains).toHaveBeenCalledWith("user-1", ["subjective"]);
  });

  it("deletes an injury and invalidates subjective caches", async () => {
    const { caller } = makeCaller([[{ id: "50000000-0000-4000-8000-000000002247" }]]);

    await expect(
      caller.deleteInjury({ id: "50000000-0000-4000-8000-000000002247" }),
    ).resolves.toEqual({ success: true });
    expect(mockInvalidateUserQueryDomains).toHaveBeenCalledWith("user-1", ["subjective"]);
  });

  it("accepts nullable injury severity", async () => {
    const injury = {
      id: "50000000-0000-4000-8000-000000002247",
      kind: "niggle",
      body_region_id: "left_hand",
      onset_date: "2026-08-02",
      resolved_date: null,
      severity: null,
      description: "Hand soreness",
      created_at: "2026-08-02T08:00:00.000Z",
      updated_at: "2026-08-02T08:00:00.000Z",
    };
    const { caller } = makeCaller([[injury]]);

    await expect(
      caller.createInjury({
        kind: "niggle",
        bodyRegionId: "left_hand",
        onsetDate: "2026-08-02",
        resolvedDate: null,
        severity: null,
        description: "Hand soreness",
      }),
    ).resolves.toEqual(injury);
    expect(mockInvalidateUserQueryDomains).toHaveBeenCalledWith("user-1", ["subjective"]);
  });

  it("allows a same-day timeline window", async () => {
    const { caller, execute } = makeCaller([[], []]);

    await expect(
      caller.timeline({ startDate: "2026-08-02", endDate: "2026-08-02" }),
    ).resolves.toEqual({ checkIns: [], injuries: [] });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
