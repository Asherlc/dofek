/// <reference path="./garmin-fitsdk.d.ts" />
import { Decoder, Stream, Utils } from "@garmin/fitsdk";
import { describe, expect, it } from "vitest";
import { parseTcx } from "../tcx/parser.ts";
import { generateCsv } from "./csv.ts";
import { generateFit } from "./fit.ts";
import { generateGpx, hasGpsPoints } from "./gpx.ts";
import { buildActivityExportFilename, serializeActivityExport } from "./index.ts";
import { fitSport, tcxSport } from "./sports.ts";
import { generateTcx } from "./tcx.ts";
import type { ActivityExportInput, ActivityExportPoint } from "./types.ts";
import { escapeXml } from "./xml.ts";

const sampleActivity: ActivityExportInput = {
  id: "11111111-1111-1111-1111-111111111111",
  activityType: "running",
  startedAt: "2026-03-18T07:00:00.000Z",
  endedAt: "2026-03-18T07:30:00.000Z",
  name: "Morning Run",
  notes: null,
  avgHr: 150,
  maxHr: 175,
  avgPower: null,
  maxPower: null,
  avgSpeed: 3.2,
  maxSpeed: 4.1,
  avgCadence: 170,
  totalDistance: 10_000,
  elevationGain: 120,
  elevationLoss: 110,
  points: [
    {
      recordedAt: "2026-03-18T07:00:00.000Z",
      lat: 37.7749,
      lng: -122.4194,
      altitude: 10,
      heartRate: 140,
      power: null,
      speed: 3.0,
      cadence: 165,
    },
    {
      recordedAt: "2026-03-18T07:15:00.000Z",
      lat: 37.7755,
      lng: -122.4188,
      altitude: 25,
      heartRate: 155,
      power: null,
      speed: 3.4,
      cadence: 172,
    },
    {
      recordedAt: "2026-03-18T07:30:00.000Z",
      lat: 37.7761,
      lng: -122.4182,
      altitude: 18,
      heartRate: 160,
      power: null,
      speed: 3.1,
      cadence: 168,
    },
  ],
};

const cyclingActivity: ActivityExportInput = {
  ...sampleActivity,
  activityType: "cycling",
  name: "Morning Ride",
  points: sampleActivity.points.map((point, index) => ({
    ...point,
    power: 200 + index * 10,
  })),
};

function activityPointAt(activity: ActivityExportInput, index: number): ActivityExportPoint {
  const point = activity.points[index];
  if (!point) {
    throw new Error(`Expected activity point at index ${index}`);
  }
  return point;
}

function decodeFit(activity: ActivityExportInput) {
  const fit = generateFit(activity);
  const decoder = new Decoder(Stream.fromByteArray(fit));
  expect(decoder.isFIT()).toBe(true);
  expect(decoder.checkIntegrity()).toBe(true);
  return decoder.read();
}

describe("activity export serializers", () => {
  it("escapes XML special characters", () => {
    expect(escapeXml(`Tom & Jerry's "run"`)).toBe("Tom &amp; Jerry&apos;s &quot;run&quot;");
  });

  it("maps activity types to TCX and FIT sports", () => {
    expect(tcxSport("cycling")).toBe("Biking");
    expect(tcxSport("running")).toBe("Running");
    expect(tcxSport("walking")).toBe("Walking");
    expect(tcxSport("open_water_swim")).toBe("Other");
    expect(tcxSport("strength_training")).toBe("Other");

    expect(fitSport("cycling")).toBe("cycling");
    expect(fitSport("running")).toBe("running");
    expect(fitSport("hiking")).toBe("walking");
    expect(fitSport("swimming")).toBe("swimming");
    expect(fitSport("strength_training")).toBe("training");
    expect(fitSport("yoga")).toBe("generic");
  });

  it("builds sanitized export filenames", () => {
    expect(buildActivityExportFilename(sampleActivity, "gpx")).toBe("Morning-Run-11111111.gpx");
    expect(buildActivityExportFilename({ ...sampleActivity, name: null }, "csv")).toBe(
      "running-11111111.csv",
    );
  });

  it("generates GPX with GPS and sensor extensions", () => {
    const gpx = generateGpx(cyclingActivity);
    expect(gpx).toContain("<gpx");
    expect(gpx).toContain('lat="37.7749"');
    expect(gpx).toContain('lon="-122.4194"');
    expect(gpx).toContain("<ele>10</ele>");
    expect(gpx).toContain("<ele>25</ele>");
    expect(gpx).toContain("<gpxtpx:hr>140</gpxtpx:hr>");
    expect(gpx).toContain("<gpxtpx:cad>165</gpxtpx:cad>");
    expect(gpx).toContain("<gpxtpx:cad>172</gpxtpx:cad>");
    expect(gpx).toContain("<power>200</power>");
    expect(gpx).toContain("<speed>3</speed>");
    expect(gpx).toContain("<speed>3.4</speed>");
    expect(hasGpsPoints(sampleActivity)).toBe(true);
  });

  it("omits GPX trackpoints and extensions when optional data is missing", () => {
    const gpsOnlyActivity: ActivityExportInput = {
      ...sampleActivity,
      name: null,
      points: [
        {
          recordedAt: "2026-03-18T07:00:00.000Z",
          lat: 37.7749,
          lng: -122.4194,
          altitude: null,
          heartRate: null,
          power: null,
          speed: null,
          cadence: null,
        },
        {
          recordedAt: "2026-03-18T07:15:00.000Z",
          lat: 37.7755,
          lng: null,
          altitude: 25,
          heartRate: 155,
          power: 210,
          speed: 3.4,
          cadence: 172,
        },
      ],
    };

    const gpx = generateGpx(gpsOnlyActivity);
    expect(gpx.match(/<trkpt/g)?.length).toBe(1);
    expect(gpx).not.toContain("<ele>");
    expect(gpx).not.toContain("<extensions>");
    expect(gpx).toContain("<name>running</name>");
    expect(hasGpsPoints(gpsOnlyActivity)).toBe(true);
    expect(
      hasGpsPoints({
        ...gpsOnlyActivity,
        points: [{ ...activityPointAt(gpsOnlyActivity, 0), lng: null }],
      }),
    ).toBe(false);
    expect(
      hasGpsPoints({
        ...gpsOnlyActivity,
        points: [{ ...activityPointAt(gpsOnlyActivity, 0), lat: null }],
      }),
    ).toBe(false);
  });

  it("escapes GPX metadata names", () => {
    const gpx = generateGpx({ ...sampleActivity, name: 'Tom & Jerry\'s "run"' });
    expect(gpx).toContain("<name>Tom &amp; Jerry&apos;s &quot;run&quot;</name>");
  });

  it("generates TCX that can be parsed back into trackpoints", () => {
    const tcx = generateTcx(cyclingActivity);
    expect(tcx).toContain('Sport="Biking"');
    expect(tcx).toContain("<Watts>200</Watts>");
    expect(tcx).toContain("<Speed>3</Speed>");
    expect(tcx).not.toContain("<Name>");
    expect(tcx).toContain("<Notes>Morning Ride</Notes>");
    expect(tcx).toContain("<TotalTimeSeconds>1800</TotalTimeSeconds>");
    expect(tcx).toContain("<DistanceMeters>10000</DistanceMeters>");
    expect(tcx).toContain("<MaximumSpeed>4.1</MaximumSpeed>");
    expect(tcx).toContain("<AverageHeartRateBpm>");
    expect(tcx).toContain("<MaximumHeartRateBpm>");
    expect(tcx).toContain("<Value>150</Value>");
    expect(tcx).toContain("<Value>175</Value>");
    expect(tcx).toContain("<AltitudeMeters>10</AltitudeMeters>");
    expect(tcx).toContain("<Cadence>165</Cadence>");

    const trackpoints = parseTcx(tcx);
    expect(trackpoints).toHaveLength(3);
    expect(trackpoints[0]?.heartRate).toBe(140);
    expect(trackpoints[1]?.lat).toBeCloseTo(37.7755, 4);
  });

  it("writes TCX power-only extensions and omits notes when the activity has no name", () => {
    const powerOnlyActivity: ActivityExportInput = {
      ...sampleActivity,
      name: null,
      points: [
        {
          ...activityPointAt(sampleActivity, 0),
          speed: null,
          power: 195,
        },
      ],
    };

    const tcx = generateTcx(powerOnlyActivity);
    expect(tcx).not.toContain("<Notes>");
    expect(tcx).toContain("<Watts>195</Watts>");
    expect(tcx).not.toContain("<Speed>");
  });

  it("derives TCX lap duration from the last stream point when endedAt is missing", () => {
    const openEndedActivity: ActivityExportInput = {
      ...sampleActivity,
      endedAt: null,
    };

    const tcx = generateTcx(openEndedActivity);
    expect(tcx).toContain("<TotalTimeSeconds>1800</TotalTimeSeconds>");
  });

  it("prefers endedAt over the last stream point for TCX lap duration", () => {
    const tcx = generateTcx({
      ...sampleActivity,
      endedAt: "2026-03-18T08:00:00.000Z",
    });
    expect(tcx).toContain("<TotalTimeSeconds>3600</TotalTimeSeconds>");
  });

  it("generates CSV with summary and stream sections", () => {
    const csv = generateCsv(sampleActivity);
    expect(csv).toContain("# activity summary");
    expect(csv).toContain("activity_id");
    expect(csv).toContain("# stream");
    expect(csv).toContain("recorded_at");
    expect(csv).toContain("2026-03-18T07:15:00.000Z");
  });

  it("generates a valid FIT activity file with expected session data", () => {
    const { messages, errors } = decodeFit(cyclingActivity);
    expect(errors).toEqual([]);
    expect(messages.sessionMesgs?.length).toBeGreaterThan(0);
    expect(messages.recordMesgs?.length).toBeGreaterThan(0);

    const session = messages.sessionMesgs?.[0];
    expect(session).toEqual(
      expect.objectContaining({
        sport: "cycling",
        avgHeartRate: 150,
        maxHeartRate: 175,
        totalDistance: 10_000,
        totalElapsedTime: 1800,
        totalTimerTime: 1800,
      }),
    );

    const records = messages.recordMesgs ?? [];
    expect(records[0]).toEqual(
      expect.objectContaining({
        heartRate: 140,
        power: 200,
        cadence: 165,
        distance: 0,
        positionLat: 450672111,
        positionLong: -1460520332,
        enhancedAltitude: 10,
        enhancedSpeed: 3,
      }),
    );
    expect(records[1]).toEqual(
      expect.objectContaining({
        distance: 85.04,
        positionLat: 450679270,
        positionLong: -1460513173,
        enhancedAltitude: 25,
      }),
    );
    expect(records[2]).toEqual(
      expect.objectContaining({
        distance: 170.08,
        positionLat: 450686428,
        positionLong: -1460506015,
        enhancedAltitude: 18,
      }),
    );
  });

  it("omits optional FIT record fields when stream values are absent", () => {
    const gpsOnlyActivity: ActivityExportInput = {
      ...sampleActivity,
      totalDistance: null,
      points: [
        {
          recordedAt: "2026-03-18T07:00:00.000Z",
          lat: 37.7749,
          lng: -122.4194,
          altitude: null,
          heartRate: null,
          power: null,
          speed: null,
          cadence: null,
        },
      ],
    };

    const { messages } = decodeFit(gpsOnlyActivity);
    const record = messages.recordMesgs?.[0];
    expect(record).toEqual(
      expect.objectContaining({
        distance: 0,
        positionLat: 450672111,
        positionLong: -1460520332,
      }),
    );
    expect(record?.heartRate).toBeUndefined();
    expect(record?.power).toBeUndefined();
    expect(record?.cadence).toBeUndefined();
    expect(record?.enhancedSpeed).toBeUndefined();
    expect(record?.enhancedAltitude).toBeUndefined();
    expect(messages.sessionMesgs?.[0]?.totalDistance).toBeCloseTo(0, 5);
  });

  it("derives FIT lap distance from GPS segments when totalDistance is missing", () => {
    const { messages } = decodeFit({ ...cyclingActivity, totalDistance: null });
    expect(messages.sessionMesgs?.[0]?.totalDistance).toBeCloseTo(170.08, 2);
    expect(messages.lapMesgs?.[0]?.totalDistance).toBeCloseTo(170.08, 2);
  });

  it("writes partial GPS and session stats only when values are present", () => {
    const partialGpsActivity: ActivityExportInput = {
      ...sampleActivity,
      avgHr: null,
      maxHr: null,
      avgPower: 205,
      maxPower: 220,
      avgCadence: 168,
      totalDistance: null,
      points: [
        {
          recordedAt: "2026-03-18T07:00:00.000Z",
          lat: 37.7749,
          lng: null,
          altitude: null,
          heartRate: null,
          power: null,
          speed: null,
          cadence: null,
        },
      ],
    };

    const { messages } = decodeFit(partialGpsActivity);
    const record = messages.recordMesgs?.[0];
    expect(record?.positionLat).toBe(450672111);
    expect(record?.positionLong).toBeUndefined();

    const session = messages.sessionMesgs?.[0];
    expect(session?.avgHeartRate).toBeUndefined();
    expect(session?.maxHeartRate).toBeUndefined();
    expect(session?.avgPower).toBe(205);
    expect(session?.maxPower).toBe(220);
    expect(session?.avgCadence).toBe(168);
  });

  it("skips FIT distance accumulation across points without complete GPS", () => {
    const gapActivity: ActivityExportInput = {
      ...cyclingActivity,
      totalDistance: null,
      points: [
        activityPointAt(cyclingActivity, 0),
        activityPointAt(cyclingActivity, 1),
        {
          ...activityPointAt(cyclingActivity, 2),
          lat: null,
          lng: null,
        },
      ],
    };

    const { messages } = decodeFit(gapActivity);
    expect(messages.recordMesgs).toHaveLength(3);
    expect(messages.recordMesgs?.[1]?.distance).toBeCloseTo(85.04, 2);
    expect(messages.recordMesgs?.[2]?.distance).toBeCloseTo(85.04, 2);
  });

  it("writes FIT activity local timestamps relative to the session end", () => {
    const { messages } = decodeFit(cyclingActivity);
    const activityMessage = messages.activityMesgs?.[0];
    const endDate = new Date(cyclingActivity.endedAt ?? cyclingActivity.startedAt);
    const endTime = Utils.convertDateToDateTime(endDate);
    const localTimestampOffset = endDate.getTimezoneOffset() * -60;

    expect(activityMessage?.localTimestamp).toBe(endTime + localTimestampOffset);
    expect(activityMessage?.totalTimerTime).toBe(1800);
  });

  it("derives FIT stop timing from the last stream point when endedAt is missing", () => {
    const openEndedActivity: ActivityExportInput = {
      ...cyclingActivity,
      endedAt: null,
    };

    const { messages, errors } = decodeFit(openEndedActivity);
    expect(errors).toEqual([]);

    const session = messages.sessionMesgs?.[0];
    expect(session).toEqual(
      expect.objectContaining({
        totalElapsedTime: 1800,
        totalTimerTime: 1800,
      }),
    );
  });

  it("generates FIT files for activities without stream points", () => {
    const indoorActivity: ActivityExportInput = {
      ...sampleActivity,
      points: [],
      avgHr: 132,
      avgSpeed: 2.5,
      avgCadence: 84,
    };

    const { messages, errors } = decodeFit(indoorActivity);
    expect(errors).toEqual([]);
    expect(messages.recordMesgs?.length).toBe(1);

    const record = messages.recordMesgs?.[0];
    expect(record).toEqual(
      expect.objectContaining({
        heartRate: 132,
        enhancedSpeed: 2.5,
        cadence: 84,
      }),
    );
  });

  it("serializes each export format through the shared entrypoint", () => {
    const gpx = serializeActivityExport(sampleActivity, "gpx");
    expect(gpx.contentType).toBe("application/gpx+xml");
    expect(gpx.filename).toBe("Morning-Run-11111111.gpx");
    expect(gpx.body.toString("utf-8")).toContain("<gpx");

    const tcx = serializeActivityExport(sampleActivity, "tcx");
    expect(tcx.contentType).toBe("application/vnd.garmin.tcx+xml");
    expect(tcx.body.toString("utf-8")).toContain("<TrainingCenterDatabase");

    const csv = serializeActivityExport(sampleActivity, "csv");
    expect(csv.contentType).toBe("text/csv; charset=utf-8");
    expect(csv.body.toString("utf-8")).toContain("# activity summary");

    const fit = serializeActivityExport(cyclingActivity, "fit");
    expect(fit.contentType).toBe("application/vnd.ant.fit");
    expect(fit.body.length).toBeGreaterThan(0);
  });

  it("rejects GPX and TCX export when GPS points are missing", () => {
    const indoorActivity: ActivityExportInput = {
      ...sampleActivity,
      points: sampleActivity.points.map((point) => ({ ...point, lat: null, lng: null })),
    };

    expect(() => serializeActivityExport(indoorActivity, "gpx")).toThrow(
      "GPX export requires GPS track points",
    );
    expect(() => serializeActivityExport(indoorActivity, "tcx")).toThrow(
      "TCX export requires GPS track points",
    );
    expect(serializeActivityExport(indoorActivity, "csv").contentType).toContain("text/csv");
  });
});
