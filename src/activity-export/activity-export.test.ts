/// <reference path="./garmin-fitsdk.d.ts" />
import { Decoder, Stream } from "@garmin/fitsdk";
import { describe, expect, it } from "vitest";
import { parseTcx } from "../tcx/parser.ts";
import { generateCsv } from "./csv.ts";
import { generateFit } from "./fit.ts";
import { generateGpx, hasGpsPoints } from "./gpx.ts";
import { buildActivityExportFilename, serializeActivityExport } from "./index.ts";
import { fitSport, tcxSport } from "./sports.ts";
import { generateTcx } from "./tcx.ts";
import type { ActivityExportInput } from "./types.ts";
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
    const gpx = generateGpx(sampleActivity);
    expect(gpx).toContain("<gpx");
    expect(gpx).toContain('lat="37.7749"');
    expect(gpx).toContain("<gpxtpx:hr>140</gpxtpx:hr>");
    expect(hasGpsPoints(sampleActivity)).toBe(true);
  });

  it("generates TCX that can be parsed back into trackpoints", () => {
    const tcx = generateTcx(cyclingActivity);
    expect(tcx).toContain('Sport="Biking"');
    expect(tcx).toContain("<Watts>200</Watts>");

    const trackpoints = parseTcx(tcx);
    expect(trackpoints).toHaveLength(3);
    expect(trackpoints[0]?.heartRate).toBe(140);
    expect(trackpoints[1]?.lat).toBeCloseTo(37.7755, 4);
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
      }),
    );

    const record = messages.recordMesgs?.[0];
    expect(record).toEqual(
      expect.objectContaining({
        heartRate: 140,
        power: 200,
        cadence: 165,
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
