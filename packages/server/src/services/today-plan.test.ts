import { describe, expect, it, vi } from "vitest";
import type { AccessWindow } from "../billing/entitlement.ts";

vi.mock("dofek/personalization/storage", () => ({
  loadPersonalizedParams: vi.fn(async () => null),
}));

import { loadTodayPlan } from "./today-plan.ts";

type SensorStore = import("../repositories/activity-repository.ts").ActivitySensorStore;

function makeSensorStore(queryImpl: SensorStore["query"]): SensorStore {
  return {
    query: queryImpl,
    getActivitySummaries: vi.fn().mockResolvedValue([]),
    getStream: vi.fn().mockResolvedValue([]),
    getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerCurveSamples: vi.fn().mockResolvedValue([]),
    getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
    getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
    getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
    getPaceCurveRows: vi.fn().mockResolvedValue([]),
  };
}

describe("loadTodayPlan", () => {
  it("throws PRECONDITION_FAILED when the ClickHouse activity analytics store is missing", async () => {
    const planPromise = loadTodayPlan(
      {
        db: { execute: vi.fn() },
        userId: "00000000-0000-4000-8000-000000000001",
        sensorStore: undefined,
      },
      "2026-07-26",
    );

    await expect(planPromise).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "todayPlan.get requires the ClickHouse activity analytics store. Set CLICKHOUSE_URL and retry.",
    });
  });

  it("returns insufficient_data when recovery rows are missing", async () => {
    const query = vi.fn(async (_schema: unknown, queryText: unknown) => {
      const sqlText = String(queryText);
      if (sqlText.includes("analytics.daily_recovery")) return [];
      if (sqlText.includes("analytics.daily_strain")) return [];
      if (sqlText.includes("analytics.daily_sleep")) return [];
      return [];
    });

    const plan = await loadTodayPlan(
      {
        db: { execute: vi.fn() },
        userId: "00000000-0000-4000-8000-000000000001",
        sensorStore: makeSensorStore(query),
      },
      "2026-07-26",
    );

    expect(plan.status).toBe("insufficient_data");
    expect(plan.missingInputs).toEqual(["recovery"]);
    expect(plan.message).toContain("recovery");
  });

  it("returns a ready plan with recovery and sleep supporting facts", async () => {
    const query = vi.fn(async (_schema: unknown, queryText: unknown) => {
      const sqlText = String(queryText);
      if (sqlText.includes("analytics.daily_recovery")) {
        return [
          {
            date: "2026-07-26",
            hrv_score: 80,
            resting_hr_score: 80,
            sleep_score: 80,
            respiratory_rate_score: 80,
          },
        ];
      }
      if (sqlText.includes("analytics.daily_strain")) {
        return [{ date: "2026-07-26", daily_load: 40 }];
      }
      if (sqlText.includes("analytics.daily_sleep")) {
        return [{ date: "2026-07-26", duration_minutes: 480, efficiency_pct: 90 }];
      }
      return [];
    });

    const plan = await loadTodayPlan(
      {
        db: { execute: vi.fn() },
        userId: "00000000-0000-4000-8000-000000000001",
        sensorStore: makeSensorStore(query),
      },
      "2026-07-26",
    );

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    expect(plan.action.id).toBe("strain_target");
    expect(plan.action.title).toContain("strain");
    expect(plan.supportingFacts).toHaveLength(2);
    expect(plan.supportingFacts[0]?.label).toBe("Recovery");
    expect(plan.supportingFacts[1]?.label).toBe("Sleep performance");
    expect(plan.supportingFacts[0]?.value).toBe("80/100");
    expect(plan.confidence).toBe("high");
    expect(plan.freshness.recoveryDate).toBe("2026-07-26");
    expect(plan.freshness.sleepDate).toBe("2026-07-26");
  });

  it("queries the recovery, strain, and sleep read models with dashboard priority", async () => {
    const query = vi.fn(async () => []);
    await loadTodayPlan(
      {
        db: { execute: vi.fn() },
        userId: "00000000-0000-4000-8000-000000000001",
        sensorStore: makeSensorStore(query),
      },
      "2026-07-26",
    );

    const queryTexts = query.mock.calls.map((call) => String(call[1]));
    expect(queryTexts.some((text) => text.includes("analytics.daily_recovery"))).toBe(true);
    expect(queryTexts.some((text) => text.includes("analytics.daily_strain"))).toBe(true);
    expect(queryTexts.some((text) => text.includes("analytics.daily_sleep"))).toBe(true);

    expect(query.mock.calls).toHaveLength(3);
    for (const call of query.mock.calls) {
      // sensorStore.query(schema, queryText, params, options)
      const params = call[2];
      const options = call[3];
      expect(params).toMatchObject({
        userId: "00000000-0000-4000-8000-000000000001",
      });
      expect(options).toEqual({ priority: "dashboard" });
    }
  });

  it("applies limited accessWindow SQL fragments and ClickHouse query parameters", async () => {
    const accessWindow: AccessWindow = {
      kind: "limited",
      paid: false,
      reason: "free_signup_week",
      startDate: "2026-07-01",
      endDateExclusive: "2026-07-08",
    };

    const query = vi.fn(
      async (_schema: unknown, queryText: unknown, params: unknown, options: unknown) => {
        const sqlText = String(queryText);
        expect(options).toEqual({ priority: "dashboard" });
        expect(params).toMatchObject({
          userId: "00000000-0000-4000-8000-000000000001",
          accessStartDate: accessWindow.startDate,
          accessEndDateExclusive: accessWindow.endDateExclusive,
        });

        if (sqlText.includes("analytics.daily_recovery")) {
          expect(sqlText).toContain("AND recovery.date >= toDate({accessStartDate:String})");
          expect(sqlText).toContain("AND recovery.date < toDate({accessEndDateExclusive:String})");
          return [
            {
              date: "2026-07-26",
              hrv_score: 80,
              resting_hr_score: 80,
              sleep_score: 80,
              respiratory_rate_score: 80,
            },
          ];
        }
        if (sqlText.includes("analytics.daily_strain")) {
          expect(sqlText).toContain("AND strain.date >= toDate({accessStartDate:String})");
          expect(sqlText).toContain("AND strain.date < toDate({accessEndDateExclusive:String})");
          return [{ date: "2026-07-26", daily_load: 40 }];
        }
        if (sqlText.includes("analytics.daily_sleep")) {
          expect(sqlText).toContain("AND sleep.date >= toDate({accessStartDate:String})");
          expect(sqlText).toContain("AND sleep.date < toDate({accessEndDateExclusive:String})");
          return [{ date: "2026-07-26", duration_minutes: 480, efficiency_pct: 90 }];
        }

        return [];
      },
    );

    const plan = await loadTodayPlan(
      {
        db: { execute: vi.fn() },
        userId: "00000000-0000-4000-8000-000000000001",
        accessWindow,
        sensorStore: makeSensorStore(query),
      },
      "2026-07-26",
    );

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    expect(plan.freshness.sleepDate).toBe("2026-07-26");
  });

  it("does not treat partially missing sleep rows as usable sleep for confidence", async () => {
    const query = vi.fn(async (_schema: unknown, queryText: unknown) => {
      const sqlText = String(queryText);
      if (sqlText.includes("analytics.daily_recovery")) {
        return [
          {
            date: "2026-07-26",
            hrv_score: 80,
            resting_hr_score: 80,
            sleep_score: 80,
            respiratory_rate_score: 80,
          },
        ];
      }
      if (sqlText.includes("analytics.daily_strain")) {
        return [{ date: "2026-07-26", daily_load: 40 }];
      }
      if (sqlText.includes("analytics.daily_sleep")) {
        return [{ date: "2026-07-26", duration_minutes: 480, efficiency_pct: null }];
      }
      return [];
    });

    const plan = await loadTodayPlan(
      {
        db: { execute: vi.fn() },
        userId: "00000000-0000-4000-8000-000000000001",
        sensorStore: makeSensorStore(query),
      },
      "2026-07-26",
    );

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    expect(plan.missingInputs).toContain("sleep");
    expect(plan.confidence).not.toBe("high");
    expect(plan.freshness.sleepDate).toBeNull();
  });

  it("does not treat fully missing sleep rows as usable sleep for confidence and falls back to workload ratio", async () => {
    const query = vi.fn(async (_schema: unknown, queryText: unknown) => {
      const sqlText = String(queryText);
      if (sqlText.includes("analytics.daily_recovery")) {
        return [
          {
            date: "2026-07-26",
            hrv_score: 80,
            resting_hr_score: 80,
            sleep_score: 80,
            respiratory_rate_score: 80,
          },
        ];
      }
      if (sqlText.includes("analytics.daily_strain")) {
        return [{ date: "2026-07-26", daily_load: 40 }];
      }
      if (sqlText.includes("analytics.daily_sleep")) {
        return [{ date: "2026-07-26", duration_minutes: null, efficiency_pct: null }];
      }
      return [];
    });

    const plan = await loadTodayPlan(
      {
        db: { execute: vi.fn() },
        userId: "00000000-0000-4000-8000-000000000001",
        sensorStore: makeSensorStore(query),
      },
      "2026-07-26",
    );

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    expect(plan.missingInputs).toContain("sleep");
    expect(plan.confidence).not.toBe("high");
    expect(plan.freshness.sleepDate).toBeNull();
    expect(plan.supportingFacts[1]?.label).toBe("Recent-to-baseline workload ratio");
    expect(plan.supportingFacts[1]?.value).toBe("4");
  });
});
