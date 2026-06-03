import { describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../../db/index.ts";
import {
  activity as activityTable,
  dailyMetrics as dailyMetricsTable,
  metricStream as metricStreamTable,
  sleepSession as sleepSessionTable,
} from "../../db/schema.ts";
import { type FitbitActivity, FitbitClient } from "./client.ts";
import type {
  ParsedFitbitActivity,
  ParsedFitbitBodyMeasurement,
  ParsedFitbitDailyMetrics,
  ParsedFitbitSleep,
} from "./parsers.ts";
import {
  persistActivity,
  persistBodyMeasurement,
  persistDailyMetrics,
  persistSleep,
} from "./persisters.ts";

// ============================================================
// Mock DB (chainable insert/delete pattern)
// ============================================================

function createMockDb() {
  const chain = {
    values: vi.fn(),
    onConflictDoUpdate: vi.fn(),
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    returning: vi.fn().mockResolvedValue([{ id: "mock-activity-id" }]),
    where: vi.fn().mockResolvedValue(undefined),
  };

  for (const fn of Object.values(chain)) {
    if (!vi.isMockFunction(fn) || fn.getMockImplementation()) continue;
    fn.mockReturnValue(chain);
  }

  const insertFn = vi.fn().mockReturnValue(chain);
  const deleteFn = vi.fn().mockReturnValue(chain);

  const db: SyncDatabase = {
    select: vi.fn(),
    insert: insertFn,
    delete: deleteFn,
    execute: vi.fn(),
  };

  return Object.assign(db, chain);
}

function expectConflictTarget(
  db: ReturnType<typeof createMockDb>,
  expectedTarget: ReadonlyArray<unknown>,
): void {
  const targetMatched = db.onConflictDoUpdate.mock.calls.some((callArgs) => {
    const [arg] = callArgs;
    if (typeof arg !== "object" || arg === null || !("target" in arg)) {
      return false;
    }
    const target = Reflect.get(arg, "target");
    if (!Array.isArray(target) || target.length !== expectedTarget.length) {
      return false;
    }
    return target.every((column, index) => column === expectedTarget[index]);
  });
  expect(targetMatched).toBe(true);
}

function expectConflictSetContainsKey(
  db: ReturnType<typeof createMockDb>,
  expectedTarget: ReadonlyArray<unknown>,
  key: string,
): void {
  const setMatched = db.onConflictDoUpdate.mock.calls.some((callArgs) => {
    const [arg] = callArgs;
    if (typeof arg !== "object" || arg === null || !("target" in arg) || !("set" in arg)) {
      return false;
    }
    const target = Reflect.get(arg, "target");
    const set = Reflect.get(arg, "set");
    if (!Array.isArray(target) || target.length !== expectedTarget.length) {
      return false;
    }
    const targetMatches = target.every((column, index) => column === expectedTarget[index]);
    if (!targetMatches || typeof set !== "object" || set === null) {
      return false;
    }
    return key in set;
  });
  expect(setMatched).toBe(true);
}

function expectDoNothingConflictTarget(
  db: ReturnType<typeof createMockDb>,
  expectedTarget: ReadonlyArray<unknown>,
): void {
  const targetMatched = db.onConflictDoNothing.mock.calls.some((callArgs) => {
    const [arg] = callArgs;
    if (typeof arg !== "object" || arg === null || !("target" in arg)) {
      return false;
    }
    const target = Reflect.get(arg, "target");
    if (!Array.isArray(target) || target.length !== expectedTarget.length) {
      return false;
    }
    return target.every((column, index) => column === expectedTarget[index]);
  });
  expect(targetMatched).toBe(true);
}

// ============================================================
// Parsed sample inputs
// ============================================================

const parsedActivity: ParsedFitbitActivity = {
  externalId: "12345678",
  activityType: "running",
  name: "Run",
  startedAt: new Date("2026-03-01T08:30:00Z"),
  endedAt: new Date("2026-03-01T09:30:00Z"),
  calories: 450,
  distanceKm: 10.5,
  steps: 8500,
  averageHeartRate: 155,
};

const rawActivity: FitbitActivity = {
  logId: 12345678,
  activityName: "Run",
  activityTypeId: 90009,
  startTime: "08:30",
  activeDuration: 3600000,
  calories: 450,
  distance: 10.5,
  distanceUnit: "Kilometer",
  steps: 8500,
  averageHeartRate: 155,
  logType: "auto_detected",
  startDate: "2026-03-01",
};

const parsedSleep: ParsedFitbitSleep = {
  externalId: "87654321",
  startedAt: new Date("2026-02-28T23:15:00Z"),
  endedAt: new Date("2026-03-01T07:00:00Z"),
  durationMinutes: 465,
  deepMinutes: 85,
  lightMinutes: 210,
  remMinutes: 95,
  awakeMinutes: 35,
  efficiencyPct: 92,
  sleepType: "main",
  isNap: false,
};

const parsedDaily: ParsedFitbitDailyMetrics = {
  date: "2026-03-01",
  steps: 12345,
  restingHr: 58,
  activeEnergyKcal: 1200,
  exerciseMinutes: 70,
  distanceKm: 9.5,
  flightsClimbed: 12,
};

const parsedBody: ParsedFitbitBodyMeasurement = {
  externalId: "55555",
  recordedAt: new Date("2026-03-01T07:30:00Z"),
  weightKg: 82.5,
  bodyFatPct: 18.5,
};

// ============================================================
// Tests
// ============================================================

describe("persistActivity", () => {
  it("upserts the activity row on the user-scoped conflict target", async () => {
    const db = createMockDb();

    const { errors } = await persistActivity(db, parsedActivity, rawActivity);

    expect(errors).toHaveLength(0);
    expect(db.insert).toHaveBeenCalledWith(activityTable);
    const [values] = db.values.mock.calls[0] ?? [];
    expect(values).toMatchObject({
      providerId: "fitbit",
      externalId: "12345678",
      activityType: "running",
      name: "Run",
    });
    expectConflictTarget(db, [
      activityTable.userId,
      activityTable.providerId,
      activityTable.externalId,
    ]);
    expectConflictSetContainsKey(
      db,
      [activityTable.userId, activityTable.providerId, activityTable.externalId],
      "activityType",
    );
  });

  it("downloads and ingests TCX when a tcxLink is present and a client is given", async () => {
    const db = createMockDb();
    const client = new FitbitClient("test-token");
    const downloadTcx = vi
      .spyOn(client, "downloadTcx")
      .mockResolvedValue("<TrainingCenterDatabase></TrainingCenterDatabase>");

    const { errors } = await persistActivity(
      db,
      parsedActivity,
      { ...rawActivity, tcxLink: "/1/user/-/activities/12345678.tcx" },
      client,
    );

    expect(errors).toHaveLength(0);
    expect(downloadTcx).toHaveBeenCalledWith("/1/user/-/activities/12345678.tcx");
  });

  it("captures a TCX download error without throwing", async () => {
    const db = createMockDb();
    const client = new FitbitClient("test-token");
    vi.spyOn(client, "downloadTcx").mockRejectedValue(new Error("download failed"));

    const { errors } = await persistActivity(
      db,
      parsedActivity,
      { ...rawActivity, tcxLink: "/1/user/-/activities/12345678.tcx" },
      client,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.externalId).toBe("12345678");
    expect(errors[0]?.message).toContain("download failed");
  });

  it("does not download TCX when no client is supplied", async () => {
    const db = createMockDb();

    const { errors } = await persistActivity(db, parsedActivity, {
      ...rawActivity,
      tcxLink: "/1/user/-/activities/12345678.tcx",
    });

    expect(errors).toHaveLength(0);
    expect(db.delete).not.toHaveBeenCalled();
  });
});

describe("persistSleep", () => {
  it("upserts the sleep session on the user-scoped conflict target", async () => {
    const db = createMockDb();

    await persistSleep(db, parsedSleep);

    expect(db.insert).toHaveBeenCalledWith(sleepSessionTable);
    const [values] = db.values.mock.calls[0] ?? [];
    expect(values).toMatchObject({
      providerId: "fitbit",
      externalId: "87654321",
      durationMinutes: 465,
      sleepType: "main",
    });
    expectConflictTarget(db, [
      sleepSessionTable.userId,
      sleepSessionTable.providerId,
      sleepSessionTable.externalId,
    ]);
    expectConflictSetContainsKey(
      db,
      [sleepSessionTable.userId, sleepSessionTable.providerId, sleepSessionTable.externalId],
      "durationMinutes",
    );
  });
});

describe("persistDailyMetrics", () => {
  it("upserts daily metrics on the user/date/provider/source conflict target", async () => {
    const db = createMockDb();

    await persistDailyMetrics(db, parsedDaily);

    expect(db.insert).toHaveBeenCalledWith(dailyMetricsTable);
    const [values] = db.values.mock.calls[0] ?? [];
    expect(values).toMatchObject({
      providerId: "fitbit",
      date: "2026-03-01",
      steps: 12345,
      exerciseMinutes: 70,
      flightsClimbed: 12,
    });
    expectConflictTarget(db, [
      dailyMetricsTable.userId,
      dailyMetricsTable.date,
      dailyMetricsTable.providerId,
      dailyMetricsTable.sourceName,
    ]);
    expectConflictSetContainsKey(
      db,
      [
        dailyMetricsTable.userId,
        dailyMetricsTable.date,
        dailyMetricsTable.providerId,
        dailyMetricsTable.sourceName,
      ],
      "steps",
    );
  });
});

describe("persistBodyMeasurement", () => {
  it("clears prior body channels then writes weight and body fat metric stream rows", async () => {
    const db = createMockDb();

    await persistBodyMeasurement(db, parsedBody);

    // Existing body channels are deleted before re-inserting.
    expect(db.delete).toHaveBeenCalledWith(metricStreamTable);
    expect(db.where).toHaveBeenCalled();

    const weightRow = db.values.mock.calls
      .flatMap(([arg]) => (Array.isArray(arg) ? arg : [arg]))
      .find(
        (row): row is Record<string, unknown> =>
          typeof row === "object" && row !== null && Reflect.get(row, "channel") === "body_weight",
      );
    expect(weightRow).toBeDefined();
    expect(weightRow?.scalar).toBe(82.5);

    const bodyFatRow = db.values.mock.calls
      .flatMap(([arg]) => (Array.isArray(arg) ? arg : [arg]))
      .find(
        (row): row is Record<string, unknown> =>
          typeof row === "object" &&
          row !== null &&
          Reflect.get(row, "channel") === "body_fat_percentage",
      );
    expect(bodyFatRow).toBeDefined();
    expect(bodyFatRow?.scalar).toBe(18.5);

    expectDoNothingConflictTarget(db, [
      metricStreamTable.userId,
      metricStreamTable.providerId,
      metricStreamTable.externalId,
      metricStreamTable.channel,
      metricStreamTable.recordedAt,
    ]);
  });
});
