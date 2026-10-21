import { describe, expect, it, vi } from "vitest";
import { dailyMetrics, sleepSession, sleepStage } from "../../db/schema/activity.ts";
import { createCapturingMetricStreamPublisher, createMockDatabase } from "../test-helpers.ts";
import { syncGarminHealthRecord } from "./health.ts";

vi.mock("../../db/provider-data-deletion.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../db/provider-data-deletion.ts")>();
  const { resolveProviderDataGenerationsForTest } = await import("../test-helpers.ts");
  return { ...actual, getProviderDataGenerations: resolveProviderDataGenerationsForTest };
});

const userId = "00000000-0000-0000-0000-000000000001";
const base = {
  userId: "garmin-owner",
  summaryId: "health-summary",
  calendarDate: "2023-11-14",
  startTimeInSeconds: 1_700_000_000,
  durationInSeconds: 3600,
};

function setup() {
  const { db, spies } = createMockDatabase();
  const capture = createCapturingMetricStreamPublisher();
  spies.returning.mockResolvedValue([{ id: "sleep-session" }]);
  return { db, spies, capture, options: { userId, metricStreamPublisher: capture.publisher } };
}

describe("syncGarminHealthRecord daily mapping", () => {
  it("converts distance and combined intensity duration while keeping the Dofek owner", async () => {
    const { db, spies, options } = setup();
    const count = await syncGarminHealthRecord(
      db,
      "dailies",
      {
        ...base,
        steps: 4321,
        distanceInMeters: 3000.5,
        floorsClimbed: 7,
        moderateIntensityDurationInSeconds: 1800,
        vigorousIntensityDurationInSeconds: 91,
      },
      { ...options, userId: ` ${userId} ` },
    );

    expect(count).toBe(1);
    expect(spies.insert).toHaveBeenCalledExactlyOnceWith(dailyMetrics);
    expect(spies.values.mock.calls[0]?.[0]).toStrictEqual({
      userId,
      providerId: "garmin",
      date: "2023-11-14",
      steps: 4321,
      distanceKm: 3.0005,
      flightsClimbed: 7,
      exerciseMinutes: 32,
    });
    expect(spies.onConflictDoUpdate.mock.calls[0]?.[0].set).toStrictEqual({
      date: "2023-11-14",
      steps: 4321,
      distanceKm: 3.0005,
      flightsClimbed: 7,
      exerciseMinutes: 32,
    });
  });

  it.each([
    { input: {}, fields: { steps: undefined, distanceKm: undefined, flightsClimbed: undefined } },
    {
      input: { steps: null, distanceInMeters: null, floorsClimbed: null },
      fields: { steps: null, distanceKm: null, flightsClimbed: null },
    },
    {
      input: { steps: 0, distanceInMeters: 0, floorsClimbed: 0 },
      fields: { steps: 0, distanceKm: 0, flightsClimbed: 0 },
    },
  ])(
    "preserves sparse, explicit unknown and zero daily values: $input",
    async ({ input, fields }) => {
      const { db, spies, options } = setup();
      await syncGarminHealthRecord(db, "dailies", { ...base, ...input }, options);
      expect(spies.values.mock.calls[0]?.[0]).toStrictEqual({
        userId,
        providerId: "garmin",
        date: base.calendarDate,
        ...fields,
        exerciseMinutes: undefined,
      });
    },
  );

  it.each([
    {
      input: { moderateIntensityDurationInSeconds: 0, vigorousIntensityDurationInSeconds: 0 },
      expected: 0,
    },
    {
      input: { moderateIntensityDurationInSeconds: 29, vigorousIntensityDurationInSeconds: 0 },
      expected: 0,
    },
    {
      input: { moderateIntensityDurationInSeconds: 30, vigorousIntensityDurationInSeconds: 0 },
      expected: 1,
    },
    { input: { moderateIntensityDurationInSeconds: 61 }, expected: undefined },
    { input: { vigorousIntensityDurationInSeconds: 61 }, expected: undefined },
    { input: { moderateIntensityDurationInSeconds: null }, expected: null },
    { input: { vigorousIntensityDurationInSeconds: null }, expected: null },
  ])(
    "keeps missing intensity contributions distinct from null and zero: $input",
    async ({ input, expected }) => {
      const { db, spies, options } = setup();
      await syncGarminHealthRecord(db, "dailies", { ...base, ...input }, options);
      expect(spies.values.mock.calls[0]?.[0].exerciseMinutes).toBe(expected);
      expect(spies.onConflictDoUpdate.mock.calls[0]?.[0].set.exerciseMinutes).toBe(expected);
    },
  );

  it.each([0, null, undefined, 42.5])(
    "preserves the supplied nightly HRV value %s",
    async (lastNightAvg) => {
      const { db, spies, options } = setup();
      expect(await syncGarminHealthRecord(db, "hrv", { ...base, lastNightAvg }, options)).toBe(1);
      expect(spies.insert).toHaveBeenCalledExactlyOnceWith(dailyMetrics);
      expect(spies.values.mock.calls[0]?.[0]).toStrictEqual({
        userId,
        providerId: "garmin",
        date: base.calendarDate,
        hrv: lastNightAvg,
      });
      expect(spies.onConflictDoUpdate.mock.calls[0]?.[0].set).toStrictEqual({
        date: base.calendarDate,
        hrv: lastNightAvg,
      });
    },
  );
});

const sensorFeeds = [
  { type: "dailies", field: "timeOffsetHeartRateSamples", channel: "heart_rate", values: [0, 72] },
  { type: "pulseox", field: "timeOffsetSpo2Values", channel: "spo2", values: [95, 98] },
  {
    type: "allDayRespiration",
    field: "timeOffsetEpochToBreaths",
    channel: "respiratory_rate",
    values: [12.5, 15],
  },
] as const;

describe("syncGarminHealthRecord sensor mapping", () => {
  it.each(sensorFeeds)(
    "publishes $type offsets in seconds to the correct channel and replacement scope",
    async ({ type, field, channel, values }) => {
      const { db, capture, options } = setup();
      expect(
        await syncGarminHealthRecord(
          db,
          type,
          {
            ...base,
            [field]: { "0": values[0], "61.5": values[1] },
          },
          options,
        ),
      ).toBe(1);
      expect(capture.deletedMetricStreamScopes).toStrictEqual([
        { userId, providerId: "garmin", externalId: `${type}:health-summary`, channel },
      ]);
      expect(capture.publishedMetricStreamRows).toMatchObject([
        {
          userId,
          providerId: "garmin",
          externalId: `${type}:health-summary`,
          channel,
          scalar: values[0],
          sourceType: "api",
          recordedAt: "2023-11-14T22:13:20.000Z",
        },
        {
          userId,
          providerId: "garmin",
          externalId: `${type}:health-summary`,
          channel,
          scalar: values[1],
          sourceType: "api",
          recordedAt: "2023-11-14T22:14:21.500Z",
        },
      ]);
      expect(capture.publishedMetricStreamRows).toHaveLength(2);
    },
  );

  it.each(sensorFeeds)(
    "replaces explicit empty $type readings",
    async ({ type, field, channel }) => {
      const { db, capture, options } = setup();
      await syncGarminHealthRecord(db, type, { ...base, [field]: {} }, options);
      expect(capture.deletedMetricStreamScopes).toStrictEqual([
        { userId, providerId: "garmin", externalId: `${type}:health-summary`, channel },
      ]);
      expect(capture.publishedMetricStreamRows).toEqual([]);
    },
  );

  it.each(sensorFeeds)("leaves an omitted $type channel untouched", async ({ type }) => {
    const { db, capture, options } = setup();
    await syncGarminHealthRecord(db, type, base, options);
    expect(capture.deletedMetricStreamScopes).toEqual([]);
    expect(capture.publishedMetricStreamRows).toEqual([]);
  });
});

describe("syncGarminHealthRecord sleep mapping", () => {
  it("maps all stage names and second timestamps, rounds durations and keeps the provider offset", async () => {
    const { db, spies, options } = setup();
    expect(
      await syncGarminHealthRecord(
        db,
        "sleeps",
        {
          ...base,
          startTimeOffsetInSeconds: -25200,
          awakeDurationInSeconds: 90,
          deepSleepDurationInSeconds: 89,
          lightSleepDurationInSeconds: 181,
          remSleepInSeconds: 31,
          sleepLevelsMap: {
            deep: [{ startTimeInSeconds: 1700000000, endTimeInSeconds: 1700000060 }],
            light: [{ startTimeInSeconds: 1700000060, endTimeInSeconds: 1700000120 }],
            rem: [{ startTimeInSeconds: 1700000120, endTimeInSeconds: 1700000180 }],
            awake: [{ startTimeInSeconds: 1700000180, endTimeInSeconds: 1700000240 }],
          },
        },
        options,
      ),
    ).toBe(1);
    const fields = {
      startedAt: new Date("2023-11-14T22:13:20.000Z"),
      endedAt: new Date("2023-11-14T23:14:50.000Z"),
      durationMinutes: 60,
      deepMinutes: 1,
      lightMinutes: 3,
      remMinutes: 1,
      awakeMinutes: 2,
      stagingAvailable: true,
      startUtcOffsetMinutes: -420,
      localTimeSource: "provider_offset",
    };
    expect(spies.values.mock.calls[0]?.[0]).toStrictEqual({
      userId,
      providerId: "garmin",
      externalId: "health-summary",
      ...fields,
    });
    expect(spies.onConflictDoUpdate.mock.calls[0]?.[0].set).toStrictEqual(fields);
    expect(spies.deleteFn).toHaveBeenCalledExactlyOnceWith(sleepStage);
    expect(spies.insert.mock.calls.map(([table]) => table)).toEqual([sleepSession, sleepStage]);
    expect(spies.values.mock.calls[1]?.[0]).toStrictEqual([
      {
        sessionId: "sleep-session",
        stage: "deep",
        startedAt: new Date("2023-11-14T22:13:20.000Z"),
        endedAt: new Date("2023-11-14T22:14:20.000Z"),
      },
      {
        sessionId: "sleep-session",
        stage: "light",
        startedAt: new Date("2023-11-14T22:14:20.000Z"),
        endedAt: new Date("2023-11-14T22:15:20.000Z"),
      },
      {
        sessionId: "sleep-session",
        stage: "rem",
        startedAt: new Date("2023-11-14T22:15:20.000Z"),
        endedAt: new Date("2023-11-14T22:16:20.000Z"),
      },
      {
        sessionId: "sleep-session",
        stage: "awake",
        startedAt: new Date("2023-11-14T22:16:20.000Z"),
        endedAt: new Date("2023-11-14T22:17:20.000Z"),
      },
    ]);
  });

  it.each([null, undefined, 0])(
    "preserves null, omitted and zero sleep durations (%s)",
    async (value) => {
      const { db, spies, options } = setup();
      await syncGarminHealthRecord(
        db,
        "sleeps",
        {
          ...base,
          deepSleepDurationInSeconds: value,
          lightSleepDurationInSeconds: value,
          remSleepInSeconds: value,
          awakeDurationInSeconds: value,
        },
        options,
      );
      expect(spies.values.mock.calls[0]?.[0]).toStrictEqual({
        userId,
        providerId: "garmin",
        externalId: "health-summary",
        startedAt: new Date("2023-11-14T22:13:20.000Z"),
        endedAt: value === 0 ? new Date("2023-11-14T23:13:20.000Z") : null,
        durationMinutes: 60,
        deepMinutes: value,
        lightMinutes: value,
        remMinutes: value,
        awakeMinutes: value,
        stagingAvailable: undefined,
      });
      expect(spies.onConflictDoUpdate.mock.calls[0]?.[0].set.endedAt).toStrictEqual(
        value === undefined
          ? undefined
          : value === null
            ? null
            : new Date("2023-11-14T23:13:20.000Z"),
      );
      expect(spies.deleteFn).not.toHaveBeenCalled();
    },
  );

  it.each([{}, { deep: [], awake: [] }])(
    "clears explicit empty stage replacements: %s",
    async (sleepLevelsMap) => {
      const { db, spies, options } = setup();
      await syncGarminHealthRecord(
        db,
        "sleeps",
        { ...base, sleepLevelsMap, startTimeOffsetInSeconds: 0 },
        options,
      );
      expect(spies.values.mock.calls[0]?.[0]).toMatchObject({
        stagingAvailable: false,
        startUtcOffsetMinutes: 0,
        localTimeSource: "provider_offset",
      });
      expect(spies.deleteFn).toHaveBeenCalledExactlyOnceWith(sleepStage);
      expect(spies.insert).toHaveBeenCalledExactlyOnceWith(sleepSession);
    },
  );

  it("publishes sleep oxygen and respiration in independent scoped channels", async () => {
    const { db, capture, options } = setup();
    await syncGarminHealthRecord(
      db,
      "sleeps",
      { ...base, timeOffsetSleepSpo2: { "0": 96 }, timeOffsetSleepRespiration: { "61.5": 13.5 } },
      options,
    );
    expect(capture.deletedMetricStreamScopes).toStrictEqual([
      { userId, providerId: "garmin", externalId: "sleeps:health-summary", channel: "spo2" },
      {
        userId,
        providerId: "garmin",
        externalId: "sleeps:health-summary",
        channel: "respiratory_rate",
      },
    ]);
    expect(capture.publishedMetricStreamRows).toMatchObject([
      {
        userId,
        providerId: "garmin",
        externalId: "sleeps:health-summary",
        channel: "spo2",
        scalar: 96,
        sourceType: "api",
        recordedAt: "2023-11-14T22:13:20.000Z",
      },
      {
        userId,
        providerId: "garmin",
        externalId: "sleeps:health-summary",
        channel: "respiratory_rate",
        scalar: 13.5,
        sourceType: "api",
        recordedAt: "2023-11-14T22:14:21.500Z",
      },
    ]);
    expect(capture.publishedMetricStreamRows).toHaveLength(2);
  });

  it("fails before stage replacement or sensor publishing when no sleep session is returned", async () => {
    const { db, spies, capture, options } = setup();
    spies.returning.mockResolvedValue([]);
    await expect(
      syncGarminHealthRecord(
        db,
        "sleeps",
        { ...base, sleepLevelsMap: {}, timeOffsetSleepSpo2: { "0": 96 } },
        options,
      ),
    ).rejects.toThrow("Garmin sleep upsert did not return a session");
    expect(spies.deleteFn).not.toHaveBeenCalled();
    expect(capture.deletedMetricStreamScopes).toEqual([]);
  });
});

describe("syncGarminHealthRecord validation", () => {
  it("requires an explicit Dofek owner before writing any health record", async () => {
    const { db, spies } = createMockDatabase();
    await expect(syncGarminHealthRecord(db, "dailies", {}, {})).rejects.toThrow("userId");
    expect(spies.insert).not.toHaveBeenCalled();
  });

  it.each(["dailies", "sleeps", "hrv", "pulseox", "allDayRespiration"] as const)(
    "validates %s payload before writing",
    async (type) => {
      const { db, spies } = createMockDatabase();
      await expect(
        syncGarminHealthRecord(
          db,
          type,
          {},
          {
            userId: "00000000-0000-0000-0000-000000000001",
          },
        ),
      ).rejects.toThrow();
      expect(spies.insert).not.toHaveBeenCalled();
      expect(spies.execute).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown sleep stages rather than dropping data", async () => {
    const { db, spies } = createMockDatabase();
    await expect(
      syncGarminHealthRecord(
        db,
        "sleeps",
        {
          userId: "garmin-owner",
          summaryId: "sleep-summary",
          calendarDate: "2026-10-20",
          startTimeInSeconds: 1792454400,
          durationInSeconds: 3600,
          sleepLevelsMap: {
            unknown: [{ startTimeInSeconds: 1792454400, endTimeInSeconds: 1792454460 }],
          },
        },
        { userId: "00000000-0000-0000-0000-000000000001" },
      ),
    ).rejects.toThrow("unknown");
    expect(spies.insert).not.toHaveBeenCalled();
  });
});
