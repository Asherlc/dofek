import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFormatDateYmdInTimeZone } = vi.hoisted(() => ({
  mockFormatDateYmdInTimeZone: vi.fn(() => "2026-07-03"),
}));

vi.mock("@dofek/format/format", () => ({
  formatDateYmdInTimeZone: mockFormatDateYmdInTimeZone,
}));

import { PersonalExperimentsRepository } from "./personal-experiments-repository.ts";

function makeRepository(rows: Record<string, unknown>[] = []) {
  const execute = vi.fn().mockResolvedValue(rows);
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

describe("PersonalExperimentsRepository", () => {
  beforeEach(() => {
    mockFormatDateYmdInTimeZone.mockReturnValue("2026-07-03");
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
});
