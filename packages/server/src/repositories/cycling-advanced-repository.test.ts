import { CYCLING_ACTIVITY_TYPES } from "@dofek/training/training";
import { describe, expect, it, vi } from "vitest";
import { makeMockSensorStore } from "../lib/test-helpers.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import {
  ActivityVariabilityModel,
  PedalDynamicsModel,
  VerticalAscentModel,
} from "./cycling-advanced-models.ts";
import { CyclingAdvancedRepository } from "./cycling-advanced-repository.ts";
import {
  expectClickHouseFiniteDaysFilter,
  expectClickHouseUnboundedDaysFilter,
} from "./test-helpers.ts";

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

describe("ActivityVariabilityModel", () => {
  it("computes variability index as NP / avg power", () => {
    const model = new ActivityVariabilityModel(
      {
        activityId: "ride-1",
        date: "2024-03-15",
        activityName: "Morning Ride",
        normalizedPower: 220,
        averagePower: 200,
      },
      0.88,
    );
    expect(model.variabilityIndex).toBeCloseTo(1.1, 3);
  });

  it("renders canonical intensity factor", () => {
    const model = new ActivityVariabilityModel(
      {
        activityId: "ride-1",
        date: "2024-03-15",
        activityName: "Morning Ride",
        normalizedPower: 220,
        averagePower: 200,
      },
      0.88,
    );
    expect(model.intensityFactor).toBeCloseTo(0.88, 2);
  });

  it("serializes to API shape", () => {
    const model = new ActivityVariabilityModel(
      {
        activityId: "ride-1",
        date: "2024-03-15",
        activityName: "Morning Ride",
        normalizedPower: 220,
        averagePower: 200,
      },
      0.88,
    );
    const detail = model.toDetail();
    expect(detail.activityId).toBe("ride-1");
    expect(detail.date).toBe("2024-03-15");
    expect(detail.activityName).toBe("Morning Ride");
    expect(detail.normalizedPower).toBe(220);
    expect(detail.averagePower).toBe(200);
    expect(typeof detail.variabilityIndex).toBe("number");
    expect(typeof detail.intensityFactor).toBe("number");
  });

  it("exposes getters", () => {
    const model = new ActivityVariabilityModel(
      {
        activityId: "ride-1",
        date: "2024-03-15",
        activityName: "Morning Ride",
        normalizedPower: 220,
        averagePower: 200,
      },
      0.88,
    );
    expect(model.activityId).toBe("ride-1");
    expect(model.date).toBe("2024-03-15");
    expect(model.activityName).toBe("Morning Ride");
    expect(model.normalizedPower).toBe(220);
    expect(model.averagePower).toBe(200);
  });
});

describe("VerticalAscentModel", () => {
  it("computes VAM in meters/hour", () => {
    const model = new VerticalAscentModel({
      activityId: "00000000-0000-4000-8000-000000000001",
      date: "2024-03-15",
      activityName: "Hill Climb",
      activityType: "cycling",
      modality: "mountain",
      elevationGainMeters: 500,
      elapsedSeconds: 1800, // 30 minutes
    });
    // 500m / (1800/3600 h) = 1000 m/h
    expect(model.verticalAscentRate).toBe(1000);
  });

  it("computes climbing minutes", () => {
    const model = new VerticalAscentModel({
      activityId: "00000000-0000-4000-8000-000000000002",
      date: "2024-03-15",
      activityName: "Hill Climb",
      activityType: "cycling",
      modality: "mountain",
      elevationGainMeters: 500,
      elapsedSeconds: 1800,
    });
    expect(model.elapsedMinutes).toBe(30);
  });

  it("returns 0 VAM when no elapsed seconds", () => {
    const model = new VerticalAscentModel({
      activityId: "00000000-0000-4000-8000-000000000003",
      date: "2024-03-15",
      activityName: "Flat Ride",
      activityType: "cycling",
      modality: "road",
      elevationGainMeters: 0,
      elapsedSeconds: 0,
    });
    expect(model.verticalAscentRate).toBe(0);
  });

  it("serializes to API shape", () => {
    const model = new VerticalAscentModel({
      activityId: "ascent-activity",
      date: "2024-03-15",
      activityName: "Hill Climb",
      activityType: "cycling",
      modality: "mountain",
      elevationGainMeters: 500,
      elapsedSeconds: 1800,
    });
    const detail = model.toDetail();
    expect(detail.activityId).toBe("ascent-activity");
    expect(detail.date).toBe("2024-03-15");
    expect(detail.activityName).toBe("Hill Climb");
    expect(detail.activityType).toBe("cycling");
    expect(detail.modality).toBe("mountain");
    expect(detail.verticalAscentRate).toBe(1000);
    expect(detail.elevationGainMeters).toBe(500);
    expect(detail.elapsedMinutes).toBe(30);
  });
});

describe("PedalDynamicsModel", () => {
  it("serializes to API shape", () => {
    const model = new PedalDynamicsModel({
      date: "2024-03-15",
      activityName: "Interval Session",
      leftRightBalance: 49.5,
      avgTorqueEffectiveness: 72.3,
      avgPedalSmoothness: 18.5,
    });
    expect(model.toDetail()).toEqual({
      date: "2024-03-15",
      activityName: "Interval Session",
      leftRightBalance: 49.5,
      avgTorqueEffectiveness: 72.3,
      avgPedalSmoothness: 18.5,
    });
  });
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

describe("CyclingAdvancedRepository", () => {
  function makeSensorStore(rows: unknown[], rawActivityCount = rows.length): ActivitySensorStore {
    // Mirror ClickHouseActivitySensorStore.query: parse rows through the
    // supplied Zod schema so coerce/transform validators actually run.
    const query: ActivitySensorStore["query"] = async (schema, queryText = "") => {
      if (queryText.includes("raw_activity_count")) {
        return [schema.parse({ raw_activity_count: rawActivityCount })];
      }
      return rows.map((row) => schema.parse(row));
    };
    return {
      ...makeMockSensorStore(),
      query: vi.fn(query),
    };
  }

  function makeRepository(rows: Record<string, unknown>[] = [], rawActivityCount = rows.length) {
    const execute = vi.fn().mockResolvedValue([{ activity_count: rawActivityCount }]);
    const sensorStore = makeSensorStore(rows, rawActivityCount);
    const repo = new CyclingAdvancedRepository({ execute }, "user-1", "UTC", sensorStore);
    return { repo, execute, sensorStore };
  }

  function expectCyclingOnlyActivityTypes(activityTypes: unknown) {
    expect(activityTypes).toEqual([...CYCLING_ACTIVITY_TYPES]);
    expect(activityTypes).not.toContain("walking");
    expect(activityTypes).not.toContain("running");
    expect(activityTypes).not.toContain("hiking");
  }

  describe("getActivityVariability", () => {
    it("renders activity-applicable canonical intensity factors", async () => {
      const { repo } = makeRepository(
        [
          {
            activity_id: "ride-1",
            date: "2024-03-15",
            name: "Ride",
            np: 220,
            avg_power: 200,
            intensity_factor: 0.73,
            total_count: 1,
          },
        ],
        1,
      );
      const result = await repo.getActivityVariability(90, 20, 0);
      expect(result.models[0]?.intensityFactor).toBe(0.73);
    });
    it("reports insufficient threshold evidence when normalized power exists", async () => {
      const { repo, sensorStore } = makeRepository([], 1);
      sensorStore.query = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0, power_total: 1 }]);
      expect((await repo.getActivityVariability(90, 20, 0)).emptyReason).toBe("no_ftp_estimate");
    });
    it("keeps pagination totals beyond the last page", async () => {
      const { repo, sensorStore } = makeRepository([], 1);
      sensorStore.query = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 4, power_total: 5 }]);
      expect(await repo.getActivityVariability(90, 20, 10)).toMatchObject({
        models: [],
        totalCount: 4,
        emptyReason: null,
      });
    });
    it.each([
      { label: "zero normalized-power activities", rows: [{ total: 0, power_total: 0 }] },
      { label: "no aggregate row", rows: [] },
    ])("reports missing normalized power with $label", async ({ rows }) => {
      const { repo, sensorStore } = makeRepository([], 1);
      sensorStore.query = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(rows);
      expect(await repo.getActivityVariability(90, 20, 0)).toMatchObject({
        models: [],
        totalCount: 0,
        emptyReason: "no_normalized_power",
      });
    });
    it("returns an empty state without activities", async () => {
      const { repo } = makeRepository([]);
      expect((await repo.getActivityVariability(90, 20, 0)).emptyReason).toBe(
        "no_cycling_activities",
      );
    });
  });

  describe("getVerticalAscentRates", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getVerticalAscentRates(90);
      expect(result).toEqual([]);
    });

    it("does not scan activity_summary or deduped_sensor when no raw activities exist", async () => {
      const { repo, sensorStore } = makeRepository([]);
      await repo.getVerticalAscentRates(90);

      expect(sensorStore.query).not.toHaveBeenCalled();
    });

    it("returns VerticalAscentModel instances", async () => {
      const { repo } = makeRepository([
        {
          activity_id: "ascent-activity",
          date: "2024-03-15",
          name: "Hill Climb",
          canonical_type: "cycling",
          modality: "mountain",
          elevation_gain: 500,
          elapsed_seconds: 1800,
        },
      ]);
      const result = await repo.getVerticalAscentRates(90);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(VerticalAscentModel);
      expect(result[0]?.toDetail().activityId).toBe("ascent-activity");
      expect(result[0]?.toDetail().verticalAscentRate).toBe(1000);
    });

    it("excludes indoor and virtual cycling workouts", async () => {
      const { repo } = makeRepository([
        {
          activity_id: "00000000-0000-4000-8000-000000000004",
          date: "2024-03-15",
          name: "Spin Class",
          canonical_type: "cycling",
          modality: "indoor",
          elevation_gain: 500,
          elapsed_seconds: 1800,
        },
        {
          activity_id: "00000000-0000-4000-8000-000000000005",
          date: "2024-03-16",
          name: "Virtual Climb",
          canonical_type: "cycling",
          modality: "virtual",
          elevation_gain: 1000,
          elapsed_seconds: 3600,
        },
        {
          activity_id: "00000000-0000-4000-8000-000000000006",
          date: "2024-03-17",
          name: "Outdoor Climb",
          canonical_type: "cycling",
          modality: "road",
          elevation_gain: 750,
          elapsed_seconds: 2700,
        },
      ]);

      const result = await repo.getVerticalAscentRates(90);

      expect(result.map((model) => model.toDetail().activityName)).toEqual(["Outdoor Climb"]);
    });

    it("does not require grade channel data — altitude-only providers return results", async () => {
      // Regression test: providers that don't emit a grade channel (Garmin, Wahoo)
      // must still surface climbing. The precomputed climbing columns are derived
      // with a LEFT JOIN on grade, so altitude-only activities keep a climbing value.
      const { repo, sensorStore } = makeRepository(
        [
          {
            activity_id: "00000000-0000-4000-8000-000000000007",
            date: "2024-04-01",
            name: "Garmin Ride",
            canonical_type: "cycling",
            modality: "road",
            elevation_gain: 800,
            elapsed_seconds: 2400,
          },
        ],
        1,
      );
      const result = await repo.getVerticalAscentRates(90);
      expect(result).toHaveLength(1);
      expect(result[0]?.toDetail().activityName).toBe("Garmin Ride");
      expect(sensorStore.query).toHaveBeenCalledTimes(1);
    });

    it("queries vertical ascent from elevation gain and includes activity type", async () => {
      const { repo, sensorStore } = makeRepository([], 1);
      await repo.getVerticalAscentRates(90);
      const [, query, params] = sensorStore.query.mock.calls[0];
      expect(query).toContain("analytics.activity_summary");
      expect(query).toContain("coalesce(nullIf(asum.name, ''), asum.canonical_type) AS name");
      expect(query).toContain("asum.canonical_type AS canonical_type");
      expect(query).toContain("asum.modality AS modality");
      expect(query).toContain("round(asum.elevation_gain_m, 1)");
      expect(query).toContain(
        "greatest(toInt32(dateDiff('second', asum.started_at, asum.ended_at)), 0) AS elapsed_seconds",
      );
      expect(query).toContain("asum.elevation_gain_m > 0");
      expect(query).not.toContain("asum.climbing_seconds > 60");
      expect(params).toMatchObject({
        userId: "user-1",
        timezone: "UTC",
        days: 90,
      });
      expectCyclingOnlyActivityTypes(params.activityTypes);
    });

    it("includes rides with elevation gain when climb seconds are short", async () => {
      const { repo } = makeRepository([
        {
          activity_id: "00000000-0000-4000-8000-000000000008",
          date: "2026-04-20",
          name: "Rolling Gravel",
          canonical_type: "cycling",
          modality: "gravel",
          elevation_gain: 300,
          elapsed_seconds: 45,
        },
      ]);

      const result = await repo.getVerticalAscentRates(90);

      expect(result).toHaveLength(1);
      expect(result[0]?.toDetail()).toMatchObject({
        activityName: "Rolling Gravel",
        activityType: "cycling",
        elevationGainMeters: 300,
      });
    });

    it("applies finite selected-range lower-bound filters", async () => {
      const { repo, sensorStore } = makeRepository([], 1);

      await repo.getVerticalAscentRates(30);

      const [, query, params] = sensorStore.query.mock.calls[0];
      expectClickHouseFiniteDaysFilter(query, params);
    });

    it("omits selected-range lower-bound filters when days is null", async () => {
      const { repo, sensorStore } = makeRepository([], 1);

      await repo.getVerticalAscentRates(null);

      const [, query, params] = sensorStore.query.mock.calls[0];
      expectClickHouseUnboundedDaysFilter(query, params);
    });
  });

  describe("getPedalDynamics", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getPedalDynamics(90);
      expect(result).toEqual([]);
    });

    it("returns PedalDynamicsModel instances", async () => {
      const { repo } = makeRepository([
        {
          date: "2024-03-15",
          name: "Interval Session",
          avg_balance: 49.5,
          avg_torque_effectiveness: 72.3,
          avg_pedal_smoothness: 18.5,
        },
      ]);
      const result = await repo.getPedalDynamics(90);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(PedalDynamicsModel);
      expect(result[0]?.toDetail().leftRightBalance).toBe(49.5);
    });

    it("queries pedal dynamics from activity summary with left balance present", async () => {
      const { repo, sensorStore } = makeRepository([]);
      await repo.getPedalDynamics(90);
      const [, query, params] = sensorStore.query.mock.calls[0];
      expect(query).toContain("analytics.activity_summary");
      expect(query).toContain("asum.avg_left_balance IS NOT NULL");
      expect(query).toContain("(asum.avg_left_torque_eff + asum.avg_right_torque_eff) / 2");
      expect(query).toContain("(asum.avg_left_pedal_smooth + asum.avg_right_pedal_smooth) / 2");
      expect(params).toMatchObject({
        userId: "user-1",
        timezone: "UTC",
        days: 90,
      });
      expectCyclingOnlyActivityTypes(params.activityTypes);
    });
  });
});
