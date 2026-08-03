import { describe, expect, it, vi } from "vitest";
import { makeMockSensorStore } from "../routers/test-helpers.ts";
import { SleepRepository } from "./sleep-repository.ts";

describe("SleepRepository", () => {
  function makeRepository({
    postgresRows = [],
    clickHouseRows = [],
  }: {
    postgresRows?: Record<string, unknown>[];
    clickHouseRows?: Record<string, unknown>[];
  } = {}) {
    const execute = vi.fn().mockResolvedValue(postgresRows);
    const sensorStore = makeMockSensorStore(
      clickHouseRows.map((row) => ({ staging_available: false, ...row })),
    );
    const repo = new SleepRepository(
      { execute },
      "user-1",
      "America/New_York",
      { kind: "full", paid: true, reason: "paid_grant" },
      sensorStore,
    );
    return { repo, execute, sensorStore };
  }

  describe("list", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository();
      expect(await repo.list(30, "2026-03-28")).toEqual([]);
    });

    it("returns parsed sleep rows from ClickHouse", async () => {
      const { repo, execute, sensorStore } = makeRepository({
        clickHouseRows: [
          {
            date: "2026-03-27",
            started_at: "2026-03-27T23:30:00",
            ended_at: "2026-03-28T06:30:00Z",
            duration_minutes: "420",
            deep_minutes: "90",
            rem_minutes: "110",
            light_minutes: "180",
            awake_minutes: "40",
            efficiency_pct: "91",
          },
        ],
      });
      const result = await repo.list(30, "2026-03-28");
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(
        expect.objectContaining({
          started_at: "2026-03-27T23:30:00",
          duration_minutes: 420,
          deep_minutes: 90,
          rem_minutes: 110,
          light_minutes: 180,
          awake_minutes: 40,
          efficiency_pct: 91,
        }),
      );
      expect(execute).not.toHaveBeenCalled();
      const queryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1] ?? "";
      expect(queryText).toContain("analytics.daily_sleep");
      expect(queryText).not.toContain("fitness.v_sleep");
    });

    it("handles nullable fields", async () => {
      const { repo } = makeRepository({
        clickHouseRows: [
          {
            date: "2026-03-27",
            started_at: "2026-03-27T23:30:00",
            ended_at: null,
            duration_minutes: null,
            deep_minutes: null,
            rem_minutes: null,
            light_minutes: null,
            awake_minutes: null,
            efficiency_pct: null,
          },
        ],
      });
      const result = await repo.list(30, "2026-03-28");
      expect(result[0]?.duration_minutes).toBeNull();
      expect(result[0]?.deep_minutes).toBeNull();
      expect(result[0]?.efficiency_pct).toBeNull();
    });

    it("does not use Postgres for deduped sleep rows", async () => {
      const { repo, execute, sensorStore } = makeRepository();
      await repo.list(30, "2026-03-28");
      expect(execute).not.toHaveBeenCalled();
      expect(sensorStore.query).toHaveBeenCalledOnce();
    });

    it("converts an exact inclusive range to the ClickHouse day window", async () => {
      const { repo, sensorStore } = makeRepository();

      await repo.listRange("2026-03-20", "2026-03-28");

      expect(vi.mocked(sensorStore.query).mock.calls[0]?.[2]).toMatchObject({
        days: 8,
        endDate: "2026-03-28",
      });
    });
  });

  describe("getStages", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository();
      expect(await repo.getStages("00000000-0000-0000-0000-000000000001")).toEqual([]);
    });

    it("returns parsed stage rows", async () => {
      const { repo } = makeRepository({
        postgresRows: [
          {
            stage: "deep",
            started_at: "2026-03-27T23:30:00Z",
            ended_at: "2026-03-28T00:15:00Z",
          },
          {
            stage: "rem",
            started_at: "2026-03-28T00:15:00Z",
            ended_at: "2026-03-28T01:00:00Z",
          },
        ],
      });
      const result = await repo.getStages("00000000-0000-0000-0000-000000000001");
      expect(result).toHaveLength(2);
      expect(result[0]?.stage).toBe("deep");
      expect(result[1]?.stage).toBe("rem");
    });

    it("calls execute once", async () => {
      const { repo, execute } = makeRepository();
      await repo.getStages("00000000-0000-0000-0000-000000000001");
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("getLatestStages", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository();
      expect(await repo.getLatestStages()).toEqual([]);
    });

    it("returns parsed stage rows", async () => {
      const { repo, execute, sensorStore } = makeRepository({
        postgresRows: [
          {
            stage: "light",
            started_at: "2026-03-27T23:30:00Z",
            ended_at: "2026-03-28T00:00:00Z",
          },
        ],
        clickHouseRows: [
          {
            date: "2026-03-27",
            started_at: "2026-03-27T23:30:00Z",
            ended_at: "2026-03-28T07:30:00Z",
            duration_minutes: 480,
            deep_minutes: 100,
            rem_minutes: 120,
            light_minutes: 200,
            awake_minutes: 60,
            efficiency_pct: 88,
          },
        ],
      });
      const result = await repo.getLatestStages();
      expect(result).toHaveLength(1);
      expect(result[0]?.stage).toBe("light");
      expect(sensorStore.query).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();
    });

    it("queries ClickHouse for the latest sleep window before reading raw stages", async () => {
      const { repo, execute, sensorStore } = makeRepository();
      await repo.getLatestStages();
      expect(execute).not.toHaveBeenCalled();
      const queryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1] ?? "";
      expect(queryText).toContain("analytics.daily_sleep");
      expect(queryText).not.toContain("fitness.v_sleep");
    });
  });

  describe("getLatest", () => {
    it("returns null when no data", async () => {
      const { repo } = makeRepository();
      expect(await repo.getLatest()).toBeNull();
    });

    it("returns the single latest sleep row from ClickHouse", async () => {
      const { repo, execute, sensorStore } = makeRepository({
        clickHouseRows: [
          {
            date: "2026-03-27",
            started_at: "2026-03-27T23:30:00Z",
            ended_at: "2026-03-28T07:30:00Z",
            duration_minutes: "480",
            deep_minutes: "100",
            rem_minutes: "120",
            light_minutes: "200",
            awake_minutes: "60",
            efficiency_pct: "88",
          },
        ],
      });
      const result = await repo.getLatest();
      expect(result).toEqual(
        expect.objectContaining({
          started_at: "2026-03-27T23:30:00Z",
          duration_minutes: 480,
          deep_minutes: 100,
          rem_minutes: 120,
          light_minutes: 200,
          awake_minutes: 60,
          efficiency_pct: 88,
        }),
      );
      expect(execute).not.toHaveBeenCalled();
      const queryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1] ?? "";
      expect(queryText).toContain("analytics.daily_sleep");
      expect(queryText).not.toContain("fitness.v_sleep");
    });

    it("does not use Postgres for latest deduped sleep", async () => {
      const { repo, execute, sensorStore } = makeRepository();
      await repo.getLatest();
      expect(execute).not.toHaveBeenCalled();
      expect(sensorStore.query).toHaveBeenCalledOnce();
    });

    it("returns first row (rows[0]) not second row when multiple rows exist", async () => {
      const { repo } = makeRepository({
        clickHouseRows: [
          {
            date: "2026-03-28",
            started_at: "2026-03-28T00:00:00Z",
            ended_at: "2026-03-28T08:20:00Z",
            duration_minutes: "500",
            deep_minutes: "110",
            rem_minutes: "130",
            light_minutes: "210",
            awake_minutes: "50",
            efficiency_pct: "92",
          },
          {
            date: "2026-03-27",
            started_at: "2026-03-27T00:00:00Z",
            ended_at: "2026-03-27T06:40:00Z",
            duration_minutes: "400",
            deep_minutes: "80",
            rem_minutes: "100",
            light_minutes: "180",
            awake_minutes: "40",
            efficiency_pct: "85",
          },
        ],
      });
      const result = await repo.getLatest();
      expect(result?.duration_minutes).toBe(500);
      expect(result?.duration_minutes).not.toBe(400);
    });
  });
});
