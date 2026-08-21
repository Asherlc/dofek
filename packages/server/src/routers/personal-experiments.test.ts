import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

const { mockCachedProtectedQuery, mockInvalidateUserQueryDomains, mockListMetricOutcomes } =
  vi.hoisted(() => ({
    mockCachedProtectedQuery: vi.fn(),
    mockInvalidateUserQueryDomains: vi.fn().mockResolvedValue(undefined),
    mockListMetricOutcomes: vi.fn(),
  }));

vi.mock("dofek/lib/cache", () => ({
  invalidateUserQueryDomains: mockInvalidateUserQueryDomains,
}));

vi.mock("../repositories/correlation-repository.ts", () => ({
  CorrelationRepository: class {
    listMetricOutcomes = mockListMetricOutcomes;
  },
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      sensorStore: {
        query: (schema: unknown, query: string, params: unknown) => Promise<unknown[]>;
      };
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

function makeCaller(rows: Record<string, unknown>[] | Record<string, unknown>[][] = []) {
  const execute = vi.fn();
  if (Array.isArray(rows[0])) {
    for (const response of rows) execute.mockResolvedValueOnce(response);
  } else {
    execute.mockResolvedValue(rows);
  }
  return createCaller({
    db: { execute },
    sensorStore: { query: vi.fn() },
    userId: "user-1",
    timezone: "UTC",
  });
}

describe("personalExperimentsRouter", () => {
  beforeEach(() => {
    mockInvalidateUserQueryDomains.mockClear();
    mockListMetricOutcomes.mockReset();
  });

  it("uses long cache for metrics and short caches for experiment reads", () => {
    const policies = mockCachedProtectedQuery.mock.calls.map((call) => call[0]);
    expect(policies).toEqual([
      { maxAge: 3_600_000 },
      { maxAge: 120_000 },
      { maxAge: 120_000 },
      { maxAge: 120_000 },
    ]);
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

  it("records a daily check-in and invalidates the experiment cache domain", async () => {
    const caller = makeCaller([
      {
        id: "check-in-1",
        personal_experiment_id: experimentId,
        date: "2026-07-08",
        adherence: "adherent",
        confounder: null,
        note: "Lights out at 10pm",
        created_at: "2026-07-08T10:00:00Z",
      },
    ]);

    const result = await caller.checkIn({
      id: experimentId,
      date: "2026-07-08",
      adherence: "adherent",
      confounder: null,
      note: "Lights out at 10pm",
    });

    expect(result).toMatchObject({ date: "2026-07-08", adherence: "adherent" });
    expect(mockInvalidateUserQueryDomains).toHaveBeenCalledWith("user-1", ["personalExperiments"]);
  });

  it("returns NOT_FOUND when recording a check-in for a missing experiment", async () => {
    const caller = makeCaller([]);

    await expect(
      caller.checkIn({
        id: experimentId,
        date: "2026-07-08",
        adherence: "adherent",
        confounder: null,
        note: null,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
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

  it("returns NOT_FOUND when analyzing a missing experiment", async () => {
    const caller = makeCaller([]);

    await expect(caller.analysis({ id: experimentId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("returns server-derived canonical outcome evidence for an experiment", async () => {
    mockListMetricOutcomes.mockResolvedValue([
      { date: "2026-07-02", value: 10, sourceProviderIds: ["oura"] },
      { date: "2026-07-03", value: 12, sourceProviderIds: ["oura"] },
      { date: "2026-07-04", value: 14, sourceProviderIds: ["oura"] },
      { date: "2026-07-05", value: 16, sourceProviderIds: ["oura"] },
      { date: "2026-07-06", value: 18, sourceProviderIds: ["oura"] },
      { date: "2026-07-09", value: 20, sourceProviderIds: ["oura"] },
      { date: "2026-07-10", value: 21, sourceProviderIds: ["oura"] },
      { date: "2026-07-11", value: 22, sourceProviderIds: ["oura"] },
      { date: "2026-07-12", value: 23, sourceProviderIds: ["oura"] },
      { date: "2026-07-13", value: 24, sourceProviderIds: ["oura"] },
    ]);
    const caller = makeCaller([
      [{ ...sampleRow, baseline_days: 5, intervention_days: 7 }],
      [
        {
          id: "check-in-1",
          personal_experiment_id: experimentId,
          date: "2026-07-08",
          adherence: "adherent",
          confounder: null,
          note: null,
          created_at: "2026-07-08T10:00:00Z",
        },
        {
          id: "check-in-2",
          personal_experiment_id: experimentId,
          date: "2026-07-09",
          adherence: "partial",
          confounder: "Late flight",
          note: null,
          created_at: "2026-07-09T10:00:00Z",
        },
        {
          id: "check-in-3",
          personal_experiment_id: experimentId,
          date: "2026-07-10",
          adherence: "adherent",
          confounder: null,
          note: null,
          created_at: "2026-07-10T10:00:00Z",
        },
        {
          id: "check-in-4",
          personal_experiment_id: experimentId,
          date: "2026-07-11",
          adherence: "partial",
          confounder: null,
          note: null,
          created_at: "2026-07-11T10:00:00Z",
        },
        {
          id: "check-in-5",
          personal_experiment_id: experimentId,
          date: "2026-07-12",
          adherence: "adherent",
          confounder: null,
          note: null,
          created_at: "2026-07-12T10:00:00Z",
        },
      ],
      [
        {
          id: "event-1",
          label: "Late flight",
          started_at: "2026-07-09",
          ended_at: null,
          category: "lifestyle",
          ongoing: false,
          notes: "Arrived after midnight",
          created_at: "2026-07-09T10:00:00Z",
        },
      ],
    ]);

    const result = await caller.analysis({ id: experimentId });

    expect(result).toMatchObject({
      outcomeMetricId: "hrv",
      analysis: {
        availability: "available",
        effect: { differenceInMeans: 8, baselineSampleCount: 5, interventionSampleCount: 5 },
      },
      annotations: [{ id: "event-1", label: "Late flight" }],
    });
    expect(result.analysis.observations).toHaveLength(12);
  });
});
