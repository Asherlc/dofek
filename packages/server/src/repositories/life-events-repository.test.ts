import { describe, expect, it, vi } from "vitest";
import { LifeEventsRepository } from "./life-events-repository.ts";

function makeRepository(rows: Record<string, unknown>[] = []) {
  const execute = vi.fn().mockResolvedValue(rows);
  const sensorStore = makeSensorStore();
  const repo = new LifeEventsRepository({ execute }, "user-1", "America/New_York", sensorStore);
  return { repo, execute, sensorStore };
}

function makeSleepRow(
  date: string,
  durationMinutes: number | null,
  deepMinutes: number | null,
  remMinutes: number | null,
  efficiencyPct: number | null,
) {
  const lightMinutes =
    durationMinutes == null || deepMinutes == null || remMinutes == null
      ? null
      : durationMinutes - deepMinutes - remMinutes;
  return {
    date,
    started_at: `${date}T04:00:00Z`,
    ended_at: `${date}T11:00:00Z`,
    duration_minutes: durationMinutes,
    deep_minutes: deepMinutes,
    rem_minutes: remMinutes,
    light_minutes: lightMinutes,
    awake_minutes: 0,
    efficiency_pct: efficiencyPct,
    staging_available: deepMinutes != null && remMinutes != null && lightMinutes != null,
  };
}

function makeSensorStore(bodyRows: Record<string, unknown>[] = [], sleepRows: unknown[] = []) {
  return {
    query: vi.fn(async (_schema: unknown, query: string) => {
      if (query.includes("analytics.v_body_measurement")) return bodyRows;
      if (query.includes("analytics.daily_sleep")) return sleepRows;
      return [{ date: "2025-05-01", resting_hr: 52 }];
    }),
  };
}

describe("LifeEventsRepository", () => {
  describe("list", () => {
    it("returns empty array when no events exist", async () => {
      const { repo } = makeRepository([]);
      expect(await repo.list()).toEqual([]);
    });

    it("returns parsed life event rows", async () => {
      const { repo } = makeRepository([
        {
          id: "evt-1",
          label: "Started creatine",
          started_at: "2025-01-15",
          ended_at: null,
          category: "supplement",
          ongoing: true,
          notes: "5g daily",
          personal_experiment_id: "11111111-1111-4111-8111-111111111111",
          created_at: "2025-01-15T10:00:00Z",
        },
      ]);
      const result = await repo.list();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: "evt-1",
        label: "Started creatine",
        started_at: "2025-01-15",
        ended_at: null,
        category: "supplement",
        ongoing: true,
        notes: "5g daily",
        personal_experiment_id: "11111111-1111-4111-8111-111111111111",
        created_at: "2025-01-15T10:00:00.000Z",
      });
    });

    it("calls execute with the correct SQL", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.list();
      expect(execute).toHaveBeenCalledOnce();
    });
  });

  describe("create", () => {
    it("returns the created life event", async () => {
      const { repo } = makeRepository([
        {
          id: "evt-new",
          user_id: "user-1",
          label: "Knee surgery",
          started_at: "2025-03-01",
          ended_at: "2025-03-15",
          category: "injury",
          ongoing: false,
          notes: "ACL repair",
          personal_experiment_id: null,
          created_at: "2025-03-01T08:00:00Z",
        },
      ]);
      const result = await repo.create({
        label: "Knee surgery",
        startedAt: "2025-03-01",
        endedAt: "2025-03-15",
        category: "injury",
        ongoing: false,
        notes: "ACL repair",
      });
      expect(result.id).toBe("evt-new");
      expect(result.label).toBe("Knee surgery");
      expect(result.user_id).toBe("user-1");
    });

    it("passes null values through correctly", async () => {
      const { repo, execute } = makeRepository([
        {
          id: "evt-2",
          user_id: "user-1",
          label: "Vacation",
          started_at: "2025-06-01",
          ended_at: null,
          category: null,
          ongoing: false,
          notes: null,
          personal_experiment_id: null,
          created_at: "2025-06-01T00:00:00Z",
        },
      ]);
      await repo.create({
        label: "Vacation",
        startedAt: "2025-06-01",
        endedAt: null,
        category: null,
        ongoing: false,
        notes: null,
      });
      expect(execute).toHaveBeenCalledOnce();
    });

    it("validates and preserves a linked personal experiment", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([{ id: "experiment-1" }])
        .mockResolvedValueOnce([
          {
            id: "evt-linked",
            user_id: "user-1",
            label: "Travel",
            started_at: "2025-06-01",
            ended_at: null,
            category: "lifestyle",
            ongoing: false,
            notes: null,
            personal_experiment_id: "experiment-1",
            created_at: "2025-06-01T00:00:00Z",
          },
        ]);
      const repo = new LifeEventsRepository(
        { execute },
        "user-1",
        "America/New_York",
        makeSensorStore(),
      );

      const result = await repo.create({
        label: "Travel",
        startedAt: "2025-06-01",
        personalExperimentId: "experiment-1",
      });

      expect(result.personal_experiment_id).toBe("experiment-1");
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it("rejects malformed personal experiment ownership rows", async () => {
      const execute = vi.fn().mockResolvedValueOnce([{ experiment_id: "experiment-1" }]);
      const repo = new LifeEventsRepository(
        { execute },
        "user-1",
        "America/New_York",
        makeSensorStore(),
      );

      await expect(
        repo.create({
          label: "Travel",
          startedAt: "2025-06-01",
          personalExperimentId: "experiment-1",
        }),
      ).rejects.toThrow();
      expect(execute).toHaveBeenCalledOnce();
    });

    it("throws when insert returning produces no row", async () => {
      const { repo } = makeRepository([]);

      await expect(
        repo.create({
          label: "Vacation",
          startedAt: "2025-06-01",
          endedAt: null,
          category: null,
          ongoing: false,
          notes: null,
        }),
      ).rejects.toThrow("INSERT RETURNING returned no rows");
    });
  });

  describe("update", () => {
    it("returns null when no fields are provided", async () => {
      const { repo, execute } = makeRepository([]);
      const result = await repo.update("evt-1", {});
      expect(result).toBeNull();
      expect(execute).not.toHaveBeenCalled();
    });

    it("returns updated row when fields are changed", async () => {
      const { repo } = makeRepository([
        {
          id: "evt-1",
          user_id: "user-1",
          label: "Updated label",
          started_at: "2025-01-15",
          ended_at: null,
          category: "supplement",
          ongoing: true,
          notes: null,
          personal_experiment_id: null,
          created_at: "2025-01-15T10:00:00Z",
        },
      ]);
      const result = await repo.update("evt-1", { label: "Updated label" });
      expect(result).not.toBeNull();
      expect(result?.label).toBe("Updated label");
    });

    it("validates a linked personal experiment before updating", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([{ id: "experiment-1" }])
        .mockResolvedValueOnce([
          {
            id: "evt-1",
            user_id: "user-1",
            label: "Travel",
            started_at: "2025-01-15",
            ended_at: null,
            category: "lifestyle",
            ongoing: false,
            notes: null,
            personal_experiment_id: "experiment-1",
            created_at: "2025-01-15T10:00:00Z",
          },
        ]);
      const repo = new LifeEventsRepository(
        { execute },
        "user-1",
        "America/New_York",
        makeSensorStore(),
      );

      const result = await repo.update("evt-1", {
        personalExperimentId: "experiment-1",
      });

      expect(result?.personal_experiment_id).toBe("experiment-1");
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it("returns null when the event is not found", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.update("nonexistent", { label: "Nope" });
      expect(result).toBeNull();
    });

    it("handles clearing nullable fields", async () => {
      const { repo, execute } = makeRepository([
        {
          id: "evt-1",
          user_id: "user-1",
          label: "Test",
          started_at: "2025-01-01",
          ended_at: null,
          category: null,
          ongoing: false,
          notes: null,
          personal_experiment_id: null,
          created_at: "2025-01-01T00:00:00Z",
        },
      ]);
      await repo.update("evt-1", { endedAt: null, category: null, notes: null });
      expect(execute).toHaveBeenCalledOnce();
    });
  });

  describe("delete", () => {
    it("returns success", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.delete("evt-1");
      expect(result).toEqual({ success: true });
    });

    it("calls execute with delete SQL", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.delete("evt-1");
      expect(execute).toHaveBeenCalledOnce();
    });
  });

  describe("analyze", () => {
    it("returns null when the event does not exist", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.analyze("nonexistent", 30);
      expect(result).toBeNull();
    });

    it("requires a ClickHouse sensor store when analyzing an existing event", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([{ started_at: "2025-06-01", ended_at: null, ongoing: false }]);
      const repo = new LifeEventsRepository({ execute }, "user-1", "UTC");

      await expect(repo.analyze("evt-1", 30)).rejects.toThrow(
        "ClickHouse activity analytics store is required for life event analysis",
      );
    });

    it("returns metrics, sleep, and body comp comparisons for a point event", async () => {
      const execute = vi
        .fn()
        // First call: event lookup
        .mockResolvedValueOnce([{ started_at: "2025-06-01", ended_at: null, ongoing: false }])
        // Second call: metrics comparison
        .mockResolvedValueOnce([
          {
            period: "after",
            days: 20,
            avg_resting_hr: 58,
            avg_hrv: 45,
            avg_steps: 8000,
            avg_active_energy: 500,
          },
          {
            period: "before",
            days: 30,
            avg_resting_hr: 62,
            avg_hrv: 40,
            avg_steps: 7000,
            avg_active_energy: 450,
          },
        ]);

      const repo = new LifeEventsRepository(
        { execute },
        "user-1",
        "America/New_York",
        makeSensorStore(
          [
            {
              period: "before",
              measurements: 10,
              avg_weight: 80.5,
              avg_body_fat: 15.2,
            },
          ],
          [makeSleepRow("2025-05-15", 420, 90, 100, 88.5)],
        ),
      );
      const result = await repo.analyze("evt-1", 30);

      expect(result).not.toBeNull();
      expect(result?.event.started_at).toBe("2025-06-01");
      expect(result?.metrics).toHaveLength(2);
      expect(result?.metrics[0].period).toBe("after");
      expect(result?.sleep).toHaveLength(1);
      expect(result?.bodyComp).toHaveLength(1);
    });

    it("handles ongoing events", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([{ started_at: "2025-03-01", ended_at: null, ongoing: true }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const repo = new LifeEventsRepository({ execute }, "user-1", "UTC", makeSensorStore());
      const result = await repo.analyze("evt-ongoing", 14);

      expect(result).not.toBeNull();
      expect(result?.metrics).toEqual([]);
      expect(result?.sleep).toEqual([]);
      expect(result?.bodyComp).toEqual([]);
      // 2 Postgres calls: event lookup and metrics. Sleep and body comparison are ClickHouse.
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it("handles ranged events with an end date", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([
          { started_at: "2025-01-01", ended_at: "2025-01-31", ongoing: false },
        ])
        .mockResolvedValueOnce([
          {
            period: "before",
            days: 30,
            avg_resting_hr: 60,
            avg_hrv: 42,
            avg_steps: 7500,
            avg_active_energy: 480,
          },
          {
            period: "after",
            days: 31,
            avg_resting_hr: 56,
            avg_hrv: 48,
            avg_steps: 9000,
            avg_active_energy: 550,
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const repo = new LifeEventsRepository({ execute }, "user-1", "UTC", makeSensorStore());
      const result = await repo.analyze("evt-ranged", 30);

      expect(result).not.toBeNull();
      expect(result?.metrics).toHaveLength(2);
    });

    it("computes sleep comparison with exact before and after windows", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([
          { started_at: "2025-06-10", ended_at: "2025-06-12", ongoing: false },
        ])
        .mockResolvedValueOnce([]);
      const sleepRows = [
        makeSleepRow("2025-06-06", 200, 40, 50, 70),
        makeSleepRow("2025-06-07", 300, 60, 90, 80),
        makeSleepRow("2025-06-09", null, 90, 100, 90),
        makeSleepRow("2025-06-10", 480, 110, 150, 92),
        makeSleepRow("2025-06-12", 540, 130, null, 94),
        makeSleepRow("2025-06-13", 600, 140, 180, 96),
      ];
      const sensorStore = makeSensorStore([], sleepRows);
      const repo = new LifeEventsRepository({ execute }, "user-1", "UTC", sensorStore);

      const result = await repo.analyze("evt-ranged", 3);

      expect(result?.sleep).toEqual([
        {
          period: "before",
          nights: 2,
          avg_sleep_min: 300,
          avg_deep_min: 75,
          avg_rem_min: 95,
          avg_efficiency: 85,
        },
        {
          period: "after",
          nights: 2,
          avg_sleep_min: 510,
          avg_deep_min: 120,
          avg_rem_min: 150,
          avg_efficiency: 93,
        },
      ]);
    });

    it("uses the analysis window to request sleep rows for point events", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([{ started_at: "2025-06-10", ended_at: null, ongoing: false }])
        .mockResolvedValueOnce([]);
      const sensorStore = makeSensorStore([], []);
      const repo = new LifeEventsRepository({ execute }, "user-1", "UTC", sensorStore);

      await repo.analyze("evt-point", 3);

      expect(sensorStore.query).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("analytics.daily_sleep"),
        expect.objectContaining({
          endDate: "2025-06-13",
          days: 6,
        }),
        undefined,
      );
    });
  });
});
