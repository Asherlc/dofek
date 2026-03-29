import { describe, expect, it, vi } from "vitest";
import { SleepRepository } from "./sleep-repository.ts";

describe("SleepRepository", () => {
  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const repo = new SleepRepository({ execute }, "user-1", "America/New_York");
    return { repo, execute };
  }

  describe("list", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      expect(await repo.list(30, "2026-03-28")).toEqual([]);
    });

    it("returns parsed sleep rows", async () => {
      const { repo } = makeRepository([
        {
          started_at: "2026-03-27T23:30:00",
          duration_minutes: "420",
          deep_minutes: "90",
          rem_minutes: "110",
          light_minutes: "180",
          awake_minutes: "40",
          efficiency_pct: "91",
        },
      ]);
      const result = await repo.list(30, "2026-03-28");
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        started_at: "2026-03-27T23:30:00",
        duration_minutes: 420,
        deep_minutes: 90,
        rem_minutes: 110,
        light_minutes: 180,
        awake_minutes: 40,
        efficiency_pct: 91,
      });
    });

    it("handles nullable fields", async () => {
      const { repo } = makeRepository([
        {
          started_at: "2026-03-27T23:30:00",
          duration_minutes: null,
          deep_minutes: null,
          rem_minutes: null,
          light_minutes: null,
          awake_minutes: null,
          efficiency_pct: null,
        },
      ]);
      const result = await repo.list(30, "2026-03-28");
      expect(result[0]?.duration_minutes).toBeNull();
      expect(result[0]?.deep_minutes).toBeNull();
      expect(result[0]?.efficiency_pct).toBeNull();
    });

    it("calls execute once", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.list(30, "2026-03-28");
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("getStages", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      expect(await repo.getStages("00000000-0000-0000-0000-000000000001")).toEqual([]);
    });

    it("returns parsed stage rows", async () => {
      const { repo } = makeRepository([
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
      ]);
      const result = await repo.getStages("00000000-0000-0000-0000-000000000001");
      expect(result).toHaveLength(2);
      expect(result[0]?.stage).toBe("deep");
      expect(result[1]?.stage).toBe("rem");
    });

    it("calls execute once", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getStages("00000000-0000-0000-0000-000000000001");
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("getLatestStages", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      expect(await repo.getLatestStages()).toEqual([]);
    });

    it("returns parsed stage rows", async () => {
      const { repo } = makeRepository([
        {
          stage: "light",
          started_at: "2026-03-27T23:30:00Z",
          ended_at: "2026-03-28T00:00:00Z",
        },
      ]);
      const result = await repo.getLatestStages();
      expect(result).toHaveLength(1);
      expect(result[0]?.stage).toBe("light");
    });

    it("calls execute once", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getLatestStages();
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("getLatest", () => {
    it("returns null when no data", async () => {
      const { repo } = makeRepository([]);
      expect(await repo.getLatest()).toBeNull();
    });

    it("returns the single latest sleep row", async () => {
      const { repo } = makeRepository([
        {
          started_at: "2026-03-27T23:30:00Z",
          duration_minutes: "480",
          deep_minutes: "100",
          rem_minutes: "120",
          light_minutes: "200",
          awake_minutes: "60",
          efficiency_pct: "88",
        },
      ]);
      const result = await repo.getLatest();
      expect(result).toEqual({
        started_at: "2026-03-27T23:30:00Z",
        duration_minutes: 480,
        deep_minutes: 100,
        rem_minutes: 120,
        light_minutes: 200,
        awake_minutes: 60,
        efficiency_pct: 88,
      });
    });

    it("calls execute once", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getLatest();
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("returns first row (rows[0]) not second row when multiple rows exist", async () => {
      const { repo } = makeRepository([
        {
          started_at: "2026-03-28T00:00:00Z",
          duration_minutes: "500",
          deep_minutes: "110",
          rem_minutes: "130",
          light_minutes: "210",
          awake_minutes: "50",
          efficiency_pct: "92",
        },
        {
          started_at: "2026-03-27T00:00:00Z",
          duration_minutes: "400",
          deep_minutes: "80",
          rem_minutes: "100",
          light_minutes: "180",
          awake_minutes: "40",
          efficiency_pct: "85",
        },
      ]);
      const result = await repo.getLatest();
      expect(result?.duration_minutes).toBe(500);
      expect(result?.duration_minutes).not.toBe(400);
    });
  });
});
