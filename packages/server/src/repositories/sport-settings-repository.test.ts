import { describe, expect, it, vi } from "vitest";
import {
  SportSettingsRepository,
  type SportSettingsRow,
  type UpsertSportSettings,
} from "./sport-settings-repository.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ss-1",
    user_id: "user-1",
    sport: "cycling",
    ftp: "250",
    threshold_hr: "170",
    threshold_pace_per_km: null,
    power_zone_pcts: [0.55, 0.75, 0.9, 1.05, 1.2],
    hr_zone_pcts: null,
    pace_zone_pcts: null,
    effective_from: "2025-01-01",
    notes: null,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeRepository(rows: Record<string, unknown>[] = []) {
  const execute = vi.fn().mockResolvedValue(rows);
  const repository = new SportSettingsRepository({ execute }, "user-1");
  return { repository, execute };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SportSettingsRepository", () => {
  describe("list", () => {
    it("returns empty array when no settings exist", async () => {
      const { repository } = makeRepository([]);
      expect(await repository.list()).toEqual([]);
    });

    it("returns domain-mapped rows", async () => {
      const { repository } = makeRepository([makeDbRow()]);
      const result = await repository.list();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<SportSettingsRow>({
        id: "ss-1",
        userId: "user-1",
        sport: "cycling",
        ftp: 250,
        thresholdHr: 170,
        thresholdPacePerKm: null,
        powerZonePcts: [0.55, 0.75, 0.9, 1.05, 1.2],
        hrZonePcts: null,
        paceZonePcts: null,
        effectiveFrom: "2025-01-01",
        notes: null,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      });
    });

    it("calls execute once", async () => {
      const { repository, execute } = makeRepository([]);
      await repository.list();
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("getBySport", () => {
    it("returns null when no matching setting exists", async () => {
      const { repository } = makeRepository([]);
      expect(await repository.getBySport("running")).toBeNull();
    });

    it("returns the matching setting", async () => {
      const { repository } = makeRepository([makeDbRow({ sport: "running" })]);
      const result = await repository.getBySport("running", "2025-06-01");

      expect(result).not.toBeNull();
      expect(result?.sport).toBe("running");
    });

    it("defaults asOfDate to today when not provided", async () => {
      const { repository, execute } = makeRepository([]);
      await repository.getBySport("cycling");
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("history", () => {
    it("returns empty array when no history exists", async () => {
      const { repository } = makeRepository([]);
      expect(await repository.history("cycling")).toEqual([]);
    });

    it("returns multiple historical settings", async () => {
      const { repository } = makeRepository([
        makeDbRow({ effective_from: "2025-06-01", ftp: "280" }),
        makeDbRow({ id: "ss-2", effective_from: "2025-01-01", ftp: "250" }),
      ]);
      const result = await repository.history("cycling");

      expect(result).toHaveLength(2);
      expect(result[0]?.ftp).toBe(280);
      expect(result[1]?.ftp).toBe(250);
    });
  });

  describe("upsert", () => {
    it("returns the upserted row", async () => {
      const { repository } = makeRepository([makeDbRow()]);
      const settings: UpsertSportSettings = {
        sport: "cycling",
        ftp: 250,
        thresholdHr: 170,
        effectiveFrom: "2025-01-01",
      };
      const result = await repository.upsert(settings);

      expect(result.sport).toBe("cycling");
      expect(result.ftp).toBe(250);
    });

    it("serializes JSON zone percentages", async () => {
      const { repository, execute } = makeRepository([
        makeDbRow({
          power_zone_pcts: [0.55, 0.75, 0.9, 1.05, 1.2],
          hr_zone_pcts: [0.6, 0.7, 0.8, 0.9],
        }),
      ]);
      const settings: UpsertSportSettings = {
        sport: "cycling",
        powerZonePcts: [0.55, 0.75, 0.9, 1.05, 1.2],
        hrZonePcts: [0.6, 0.7, 0.8, 0.9],
      };
      const result = await repository.upsert(settings);

      expect(execute).toHaveBeenCalledTimes(1);
      expect(result.powerZonePcts).toEqual([0.55, 0.75, 0.9, 1.05, 1.2]);
      expect(result.hrZonePcts).toEqual([0.6, 0.7, 0.8, 0.9]);
    });

    it("handles null zone percentages", async () => {
      const { repository } = makeRepository([
        makeDbRow({ power_zone_pcts: null, hr_zone_pcts: null, pace_zone_pcts: null }),
      ]);
      const settings: UpsertSportSettings = { sport: "cycling" };
      const result = await repository.upsert(settings);

      expect(result.powerZonePcts).toBeNull();
      expect(result.hrZonePcts).toBeNull();
      expect(result.paceZonePcts).toBeNull();
    });

    it("defaults effectiveFrom to today when not provided", async () => {
      const { repository, execute } = makeRepository([makeDbRow()]);
      await repository.upsert({ sport: "cycling", ftp: 260 });
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("delete", () => {
    it("returns success", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const repository = new SportSettingsRepository({ execute }, "user-1");
      const result = await repository.delete("ss-1");

      expect(result).toEqual({ success: true });
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });
});
