import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFormatDateYmdInTimeZone, mockListMetricOutcomes } = vi.hoisted(() => ({
  mockFormatDateYmdInTimeZone: vi.fn(() => "2026-07-03"),
  mockListMetricOutcomes: vi.fn(),
}));

vi.mock("@dofek/format/format", () => ({
  formatDateYmdInTimeZone: mockFormatDateYmdInTimeZone,
}));

vi.mock("./correlation-repository.ts", () => ({
  CorrelationRepository: class {
    listMetricOutcomes = mockListMetricOutcomes;
  },
}));

import { PersonalExperimentsRepository } from "./personal-experiments-repository.ts";

function makeRepository(rows: Record<string, unknown>[] = []) {
  const execute = vi.fn().mockResolvedValue(rows);
  const repo = new PersonalExperimentsRepository({ execute }, "user-1", "America/Los_Angeles");
  return { repo, execute };
}

function makeRepositoryWithResponses(...responses: Record<string, unknown>[][]) {
  const execute = vi.fn();
  for (const response of responses) execute.mockResolvedValueOnce(response);
  const repo = new PersonalExperimentsRepository({ execute }, "user-1", "America/Los_Angeles");
  return { repo, execute };
}

const sampleRow = {
  id: "exp-1",
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

const sampleCheckInRow = {
  id: "check-in-1",
  personal_experiment_id: "exp-1",
  date: "2026-07-08",
  adherence: "partial",
  confounder: "Late flight",
  note: "Fell asleep after midnight",
  created_at: "2026-07-08T10:00:00Z",
};

describe("PersonalExperimentsRepository", () => {
  beforeEach(() => {
    mockFormatDateYmdInTimeZone.mockReturnValue("2026-07-03");
    mockListMetricOutcomes.mockReset();
  });

  describe("list", () => {
    it("returns an empty array when no experiments exist", async () => {
      const { repo } = makeRepository([]);
      expect(await repo.list()).toEqual([]);
    });

    it("enriches stored rows with metric labels and schedule phase", async () => {
      const { repo } = makeRepository([sampleRow]);
      const result = await repo.list();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: "exp-1",
        hypothesis: "Does earlier bedtime improve HRV?",
        intervention: "Lights out by 10pm",
        outcomeMetricId: "hrv",
        outcomeMetricLabel: "Heart Rate Variability",
        lagDays: 1,
        phase: "baseline",
        phaseLabel: "Baseline",
        schedule: expect.objectContaining({
          baselineStartDate: "2026-07-01",
          baselineEndDate: "2026-07-07",
          interventionStartDate: "2026-07-08",
          interventionEndDate: "2026-07-21",
        }),
      });
    });
  });

  describe("get", () => {
    it("returns null when the experiment is missing", async () => {
      const { repo } = makeRepository([]);
      expect(await repo.get("missing")).toBeNull();
    });

    it("returns the enriched experiment when present", async () => {
      const { repo } = makeRepository([sampleRow]);
      const result = await repo.get("exp-1");
      expect(result?.outcomeMetricLabel).toBe("Heart Rate Variability");
      expect(result?.phase).toBe("baseline");
    });
  });

  describe("create", () => {
    it("returns the enriched created experiment", async () => {
      const { repo } = makeRepository([{ ...sampleRow, user_id: "user-1" }]);
      const result = await repo.create({
        hypothesis: "Does earlier bedtime improve HRV?",
        intervention: "Lights out by 10pm",
        outcomeMetricId: "hrv",
        lagDays: 1,
        baselineDays: 7,
        interventionDays: 14,
        startDate: "2026-07-01",
      });

      expect(result.id).toBe("exp-1");
      expect(result.status).toBe("active");
      expect(result.outcomeMetricLabel).toBe("Heart Rate Variability");
    });
  });

  describe("stop", () => {
    it("returns null when no active experiment matches", async () => {
      const { repo } = makeRepository([]);
      expect(await repo.stop("exp-1")).toBeNull();
    });

    it("marks the experiment stopped using the user timezone date", async () => {
      mockFormatDateYmdInTimeZone.mockReturnValue("2026-07-05");
      const { repo, execute } = makeRepository([
        {
          ...sampleRow,
          user_id: "user-1",
          status: "stopped",
          stopped_at: "2026-07-05",
        },
      ]);

      const result = await repo.stop("exp-1");

      expect(result).toMatchObject({
        status: "stopped",
        stoppedAt: "2026-07-05",
        phase: "stopped",
        phaseLabel: "Stopped",
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(mockFormatDateYmdInTimeZone).toHaveBeenCalledWith(
        expect.any(Date),
        "America/Los_Angeles",
      );
    });
  });

  describe("upsertCheckIn", () => {
    it("replaces the one raw daily check-in for the experiment", async () => {
      const { repo, execute } = makeRepository([sampleCheckInRow]);

      const result = await repo.upsertCheckIn("exp-1", {
        date: "2026-07-08",
        adherence: "partial",
        confounder: "Late flight",
        note: "Fell asleep after midnight",
      });

      expect(result).toEqual({
        id: "check-in-1",
        date: "2026-07-08",
        adherence: "partial",
        confounder: "Late flight",
        note: "Fell asleep after midnight",
        createdAt: "2026-07-08T10:00:00.000Z",
      });
      expect(execute).toHaveBeenCalledOnce();
    });
  });

  describe("analyze", () => {
    it("derives lagged outcome evidence from canonical metric values without persisting it", async () => {
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
      const { repo } = makeRepositoryWithResponses(
        [{ ...sampleRow, baseline_days: 5, intervention_days: 7, start_date: "2026-07-01" }],
        [
          { ...sampleCheckInRow, date: "2026-07-08", adherence: "adherent" },
          { ...sampleCheckInRow, id: "check-in-2", date: "2026-07-09", adherence: "partial" },
          { ...sampleCheckInRow, id: "check-in-3", date: "2026-07-10", adherence: "adherent" },
          { ...sampleCheckInRow, id: "check-in-4", date: "2026-07-11", adherence: "partial" },
          { ...sampleCheckInRow, id: "check-in-5", date: "2026-07-12", adherence: "adherent" },
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
      );

      const result = await repo.analyze("exp-1", { query: vi.fn() });

      expect(result).toMatchObject({
        outcomeMetricId: "hrv",
        analysis: {
          availability: "available",
          effect: { baselineMean: 14, interventionMean: 22, differenceInMeans: 8 },
        },
        annotations: [
          {
            id: "event-1",
            label: "Late flight",
            startedAt: "2026-07-09",
            notes: "Arrived after midnight",
          },
        ],
      });
      expect(mockListMetricOutcomes).toHaveBeenCalledWith("hrv", 12, "2026-07-13");
    });
  });
});
