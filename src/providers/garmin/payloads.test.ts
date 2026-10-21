import { describe, expect, it } from "vitest";
import { parseGarminWebhookPayload } from "./payloads.ts";

const summary = {
  userId: "stable-owner",
  summaryId: "summary-1",
  calendarDate: "2026-10-20",
  startTimeInSeconds: 1792454400,
  startTimeOffsetInSeconds: -25200,
  durationInSeconds: 86400,
};

const activity = {
  ...summary,
  activityId: 5001904988,
  activityType: "RUNNING",
  activityName: "Morning run",
  durationInSeconds: 1800,
};

const activityFile = {
  ...activity,
  summaryId: "5001904988-file",
  fileType: "FIT",
  callbackURL: "https://apis.garmin.com/wellness-api/rest/activityFile?id=activity&token=opaque",
};

describe("parseGarminWebhookPayload", () => {
  it("preserves daily source facts, sparse metrics, and opaque upstream provenance", () => {
    const record = {
      ...summary,
      steps: 1200,
      timeOffsetHeartRateSamples: { "15": 60 },
      activeKilocalories: 100,
    };
    const events = parseGarminWebhookPayload({ dailies: [record] });
    expect(events).toEqual([
      {
        ownerExternalId: "stable-owner",
        eventType: "update",
        objectType: "dailies",
        objectId: "summary-1",
        metadata: { payload: record },
      },
    ]);
    expect(events[0]?.metadata?.payload).not.toHaveProperty("restingHeartRateInBeatsPerMinute");
  });

  it.each([
    "AUTO_TENTATIVE",
    "AUTO_FINAL",
    "ENHANCED_TENTATIVE",
    "ENHANCED_FINAL",
    "FUTURE_VALIDATION",
  ])("retains %s sleep state for replacement handling", (validation) => {
    const record = {
      ...summary,
      durationInSeconds: 20000,
      validation,
      sleepLevelsMap: {
        deep: [
          {
            startTimeInSeconds: summary.startTimeInSeconds,
            endTimeInSeconds: summary.startTimeInSeconds + 60,
          },
        ],
      },
    };
    const [event] = parseGarminWebhookPayload({ sleeps: [record] });
    expect(event).toMatchObject({
      objectType: "sleeps",
      objectId: summary.summaryId,
      metadata: { payload: record },
    });
  });

  it("preserves corrected sleep summaries and explicit empty stages as separate replacement events", () => {
    const provisional = { ...summary, validation: "AUTO_TENTATIVE", durationInSeconds: 1200 };
    const corrected = {
      ...provisional,
      validation: "AUTO_FINAL",
      durationInSeconds: 2400,
      sleepLevelsMap: {},
    };
    const events = parseGarminWebhookPayload({ sleeps: [provisional, corrected] });
    expect(events.map((event) => event.objectId)).toEqual([summary.summaryId, summary.summaryId]);
    expect(events[0]?.metadata?.payload).not.toHaveProperty("sleepLevelsMap");
    expect(events[1]?.metadata?.payload).toHaveProperty("sleepLevelsMap", {});
  });

  it.each([
    ["hrv", { lastNightAvg: 44, hrvValues: { "300": 32 } }],
    ["pulseox", { onDemand: true, durationInSeconds: 0, timeOffsetSpo2Values: { "55740": 93 } }],
    ["allDayRespiration", { timeOffsetEpochToBreaths: { "0": 14.63 } }],
  ])("retains the %s family and original raw readings", (family, fields) => {
    const record = { ...summary, ...fields };
    expect(parseGarminWebhookPayload({ [family]: [record] })).toEqual([
      {
        ownerExternalId: summary.userId,
        eventType: "update",
        objectType: family,
        objectId: summary.summaryId,
        metadata: { payload: record },
      },
    ]);
  });

  it.each([5001904988, "5001904988"])(
    "uses activityId %s as canonical activity identity",
    (activityId) => {
      const record = { ...activity, activityId, summaryId: "separate-summary-id" };
      const [event] = parseGarminWebhookPayload({ activities: [record] });
      expect(event).toMatchObject({
        objectType: "activities",
        objectId: "5001904988",
        metadata: { payload: record },
      });
    },
  );

  it("retains activity-file identity and callback without treating its summary suffix as an activity ID", () => {
    const [event] = parseGarminWebhookPayload({ activityFiles: [activityFile] });
    expect(event).toMatchObject({
      objectType: "activityFiles",
      objectId: "5001904988",
      metadata: { payload: activityFile },
    });
  });

  it("retains manually updated summaries with their documented summary identity", () => {
    const record = { ...summary, activityType: "RUNNING", manual: true };
    const [event] = parseGarminWebhookPayload({ manuallyUpdatedActivities: [record] });
    expect(event).toMatchObject({
      objectType: "manuallyUpdatedActivities",
      objectId: "summary-1",
      metadata: { payload: record },
    });
  });

  it("retains lifecycle notifications with stable ownership", () => {
    const deregistration = { userId: "stable-owner" };
    const permissions = {
      userId: "stable-owner",
      summaryId: "permission-change",
      permissions: [],
      changeTimeInSeconds: 1792454400,
    };
    expect(
      parseGarminWebhookPayload({
        deregistrations: [deregistration],
        userPermissionsChange: [permissions],
      }),
    ).toEqual([
      {
        ownerExternalId: "stable-owner",
        eventType: "delete",
        objectType: "deregistrations",
        objectId: "stable-owner",
        metadata: { payload: deregistration },
      },
      {
        ownerExternalId: "stable-owner",
        eventType: "update",
        objectType: "userPermissionsChange",
        objectId: "permission-change",
        metadata: { payload: permissions },
      },
    ]);
  });

  it.each([
    null,
    [],
    "not-json",
    {},
    { dailies: {} },
    { activities: [summary] },
    { sleeps: [{ ...summary, userId: "" }] },
  ])("rejects malformed or ownerless input %j", (body) =>
    expect(() => parseGarminWebhookPayload(body)).toThrow(),
  );

  it.each(["epochs", "bodyComps", "stressDetails", "nutrition", "activityDetails", "unknownFeed"])(
    "fails explicitly for unsupported feed %s even beside supported data",
    (feed) =>
      expect(() => parseGarminWebhookPayload({ dailies: [summary], [feed]: [summary] })).toThrow(
        feed,
      ),
  );

  it.each([
    { ...summary, calendarDate: "2026-02-30" },
    { ...summary, durationInSeconds: -1 },
    { ...summary, steps: "1200" },
    { ...summary, timeOffsetHeartRateSamples: { bad: 60 } },
  ])("rejects invalid daily boundaries %j", (record) => {
    expect(() => parseGarminWebhookPayload({ dailies: [record] })).toThrow();
  });

  it("rejects reversed sleep stages", () => {
    expect(() =>
      parseGarminWebhookPayload({
        sleeps: [
          {
            ...summary,
            sleepLevelsMap: {
              deep: [
                {
                  startTimeInSeconds: 100,
                  endTimeInSeconds: 99,
                },
              ],
            },
          },
        ],
      }),
    ).toThrow();
  });

  it.each([
    "http://apis.garmin.com/wellness-api/rest/activityFile?id=1",
    "https://evil.example/wellness-api/rest/activityFile?id=1",
    "https://apis.garmin.com.evil.example/wellness-api/rest/activityFile?id=1",
    "https://apis.garmin.com:444/wellness-api/rest/activityFile?id=1",
    "https://user:password@apis.garmin.com/wellness-api/rest/activityFile?id=1",
    "https://apis.garmin.com/wellness-api/rest/activityFile/extra?id=1",
    "https://apis.garmin.com/wellness-api/rest/activityFile?id=1#fragment",
    "https://apis.garmin.com/wellness-api/rest/activityFile?id=1#",
    "https://apis.garmin.com/wellness-api/rest/other?id=1",
    "not-a-url",
  ])("rejects unsafe callback %s", (callbackURL) => {
    expect(() =>
      parseGarminWebhookPayload({ activityFiles: [{ ...activityFile, callbackURL }] }),
    ).toThrow();
  });

  it("accepts explicit default HTTPS port in a callback", () => {
    const callbackURL =
      "https://apis.garmin.com:443/wellness-api/rest/activityFile?id=1&token=opaque";
    expect(
      parseGarminWebhookPayload({ activityFiles: [{ ...activityFile, callbackURL }] })[0]?.objectId,
    ).toBe("5001904988");
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, "", -1, 1.5])(
    "rejects ambiguous activity identity %s",
    (activityId) => {
      expect(() =>
        parseGarminWebhookPayload({ activities: [{ ...activity, activityId }] }),
      ).toThrow();
    },
  );
});
