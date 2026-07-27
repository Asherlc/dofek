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
      userId: string | null;
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

vi.mock("@dofek/format/format", () => ({
  formatDateYmdInTimeZone: () => "2026-07-03",
}));

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: vi.fn(
      async (
        db: { execute: (query: unknown) => Promise<unknown[]> },
        _schema: unknown,
        query: unknown,
      ) => db.execute(query),
    ),
  };
});

import { personalExperimentsRouter } from "./personal-experiments.ts";

const createCaller = createTestCallerFactory(personalExperimentsRouter);

const experimentId = "11111111-1111-4111-8111-111111111111";

const sampleRow = {
  id: experimentId,
  user_id: "user-1",
  hypothesis: "Does earlier bedtime improve HRV?",
  intervention: "Lights out by 10pm",
  outcome_metric_id: "hrv",
  lag_days: 1,
  baseline_days: 7,
  intervention_days: 14,
  start_date: "2026-07-01",
  status: "active",
  stopped_at: null,
  created_at: "2026-07-01T10:00:00Z",
};

function makeCaller(rows: Record<string, unknown>[] = []) {
  return createCaller({
    db: { execute: vi.fn().mockResolvedValue(rows) },
    userId: "user-1",
    timezone: "UTC",
  });
}

describe("personalExperimentsRouter", () => {
  beforeEach(() => {
    mockInvalidateUserQueryDomains.mockClear();
  });

  it("uses long cache for metrics and short caches for experiment reads", () => {
    const policies = mockCachedProtectedQuery.mock.calls.map((call) => call[0]);
    expect(policies).toEqual([{ maxAge: 3_600_000 }, { maxAge: 120_000 }, { maxAge: 120_000 }]);
  });

  it("lists catalog metrics for experiment setup forms", async () => {
    const caller = makeCaller();
    const metrics = await caller.metrics();
    expect(metrics.some((metric) => metric.id === "hrv")).toBe(true);
    expect(metrics.find((metric) => metric.id === "hrv")?.label).toBe("Heart Rate Variability");
  });

  it("creates an experiment and invalidates the personalExperiments cache domain", async () => {
    const caller = makeCaller([sampleRow]);
    const result = await caller.create({
      hypothesis: "Does earlier bedtime improve HRV?",
      intervention: "Lights out by 10pm",
      outcomeMetricId: "hrv",
      lagDays: 1,
      baselineDays: 7,
      interventionDays: 14,
      startDate: "2026-07-01",
    });

    expect(result.outcomeMetricLabel).toBe("Heart Rate Variability");
    expect(result.phase).toBe("baseline");
    expect(mockInvalidateUserQueryDomains).toHaveBeenCalledWith("user-1", ["personalExperiments"]);
  });

  it("rejects unknown outcome metric ids", async () => {
    const caller = makeCaller();
    await expect(
      caller.create({
        hypothesis: "Test",
        intervention: "Do something",
        outcomeMetricId: "not_a_real_metric",
        startDate: "2026-07-01",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("returns NOT_FOUND when stopping a missing experiment", async () => {
    const caller = makeCaller([]);
    await expect(caller.stop({ id: experimentId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("stops an active experiment and invalidates cache", async () => {
    const caller = makeCaller([
      {
        ...sampleRow,
        status: "stopped",
        stopped_at: "2026-07-03",
      },
    ]);
    const result = await caller.stop({ id: experimentId });
    expect(result.status).toBe("stopped");
    expect(result.phase).toBe("stopped");
    expect(mockInvalidateUserQueryDomains).toHaveBeenCalledWith("user-1", ["personalExperiments"]);
  });

  it("lists enriched experiments", async () => {
    const caller = makeCaller([sampleRow]);
    const result = await caller.list();
    expect(result).toHaveLength(1);
    expect(result[0]?.schedule.scheduleSummary).toContain("baseline");
  });

  it("gets a single experiment or throws NOT_FOUND", async () => {
    const foundCaller = makeCaller([sampleRow]);
    const found = await foundCaller.get({ id: experimentId });
    expect(found.id).toBe(experimentId);

    const missingCaller = makeCaller([]);
    await expect(missingCaller.get({ id: experimentId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
