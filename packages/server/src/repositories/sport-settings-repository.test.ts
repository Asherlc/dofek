import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    threshold_hr: "170",
    threshold_pace_per_km: null,
    ftp: null,
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

function statementParams(execute: ReturnType<typeof vi.fn>): unknown[] {
  const statement = execute.mock.calls[0]?.[0];
  if (!statement) throw new Error("Expected a captured PostgreSQL statement");
  return new PgDialect().sqlToQuery(statement).params;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SportSettingsRepository", () => {
  afterEach(() => vi.useRealTimers());

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
        thresholdHr: 170,
        thresholdPacePerKm: null,
        ftp: null,
        powerZonePcts: [0.55, 0.75, 0.9, 1.05, 1.2],
        hrZonePcts: null,
        paceZonePcts: null,
        effectiveFrom: "2025-01-01",
        notes: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      });
    });

    it("maps all settings fields after an upsert", async () => {
      const row = makeDbRow({
        threshold_hr: "172",
        threshold_pace_per_km: "260",
        ftp: "255",
        power_zone_pcts: [0.5, 0.7, 0.9],
        hr_zone_pcts: [0.6, 0.8, 1],
        pace_zone_pcts: [0.8, 1, 1.2],
        notes: "tested settings",
        effective_from: "2025-05-01",
        created_at: "2025-05-01T00:00:00Z",
        updated_at: "2025-05-01T00:00:00Z",
      });
      const { repository } = makeRepository([row]);

      await expect(
        repository.upsert({ sport: "cycling", effectiveFrom: "2025-05-01" }),
      ).resolves.toMatchObject({
        id: "ss-1",
        userId: "user-1",
        sport: "cycling",
        thresholdHr: 172,
        thresholdPacePerKm: 260,
        ftp: 255,
        powerZonePcts: [0.5, 0.7, 0.9],
        hrZonePcts: [0.6, 0.8, 1],
        paceZonePcts: [0.8, 1, 1.2],
        effectiveFrom: "2025-05-01",
        notes: "tested settings",
        createdAt: "2025-05-01T00:00:00.000Z",
        updatedAt: "2025-05-01T00:00:00.000Z",
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
        makeDbRow({ effective_from: "2025-06-01", threshold_hr: "180" }),
        makeDbRow({ id: "ss-2", effective_from: "2025-01-01", threshold_hr: "170" }),
      ]);
      const result = await repository.history("cycling");

      expect(result).toHaveLength(2);
      expect(result[0]?.thresholdHr).toBe(180);
      expect(result[1]?.thresholdHr).toBe(170);
    });
  });

  describe("upsert", () => {
    it("returns the upserted row", async () => {
      const { repository } = makeRepository([makeDbRow()]);
      const settings: UpsertSportSettings = {
        sport: "cycling",
        thresholdHr: 170,
        effectiveFrom: "2025-01-01",
      };
      const result = await repository.upsert(settings);

      expect(result.sport).toBe("cycling");
      expect(result.thresholdHr).toBe(170);
    });

    it("binds optional-field presence separately from null and supplied values", async () => {
      const omitted = makeRepository([makeDbRow()]);
      await omitted.repository.upsert({ sport: "cycling", effectiveFrom: "2025-02-01" });
      const omittedParams = statementParams(omitted.execute);
      expect(omittedParams.filter((value) => value === false)).toHaveLength(14);
      expect(omittedParams).not.toContain(undefined);

      const cleared = makeRepository([makeDbRow()]);
      await cleared.repository.upsert({
        sport: "cycling",
        thresholdHr: null,
        thresholdPacePerKm: null,
        ftp: null,
        powerZonePcts: null,
        hrZonePcts: null,
        paceZonePcts: null,
        notes: null,
        effectiveFrom: "2025-02-01",
      });
      const clearedParams = statementParams(cleared.execute);
      expect(clearedParams.filter((value) => value === true)).toHaveLength(14);
      expect(clearedParams.filter((value) => value === null)).toHaveLength(4);
      expect(clearedParams).not.toContain("null");
      expect(clearedParams).not.toContain(undefined);

      const supplied = makeRepository([makeDbRow()]);
      await supplied.repository.upsert({
        sport: "cycling",
        thresholdHr: 172,
        thresholdPacePerKm: 280,
        ftp: 260,
        powerZonePcts: [0.55, 0.75, 0.95],
        hrZonePcts: [0.6, 0.8, 1],
        paceZonePcts: [0.8, 1, 1.2],
        notes: "explicit values",
        effectiveFrom: "2025-02-01",
      });
      const suppliedParams = statementParams(supplied.execute);
      expect(suppliedParams.filter((value) => value === true)).toHaveLength(14);
      expect(suppliedParams).toEqual(
        expect.arrayContaining([
          172,
          280,
          260,
          JSON.stringify([0.55, 0.75, 0.95]),
          JSON.stringify([0.6, 0.8, 1]),
          JSON.stringify([0.8, 1, 1.2]),
          "explicit values",
        ]),
      );
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
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
      const execute = vi.fn().mockResolvedValue([makeDbRow()]);
      const repository = new SportSettingsRepository({ execute }, "user-1", "Pacific/Kiritimati");
      await repository.upsert({ sport: "cycling", thresholdHr: 175 });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(statementParams(execute)).toContain("2026-01-02");
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
