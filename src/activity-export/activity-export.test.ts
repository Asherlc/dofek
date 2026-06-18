import { Decoder, Stream } from "@garmin/fitsdk";
import { describe, expect, it } from "vitest";
import { parseTcx } from "../tcx/parser.ts";
import { generateCsv } from "./csv.ts";
import { generateFit } from "./fit.ts";
import { generateGpx, hasGpsPoints } from "./gpx.ts";
import { serializeActivityExport } from "./index.ts";
import { generateTcx } from "./tcx.ts";
import type { ActivityExportInput } from "./types.ts";

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

describe("activity export serializers", () => {
  it("generates GPX with GPS and sensor extensions", () => {
    const gpx = generateGpx(sampleActivity);
    expect(gpx).toContain("<gpx");
    expect(gpx).toContain('lat="37.7749"');
    expect(gpx).toContain("<gpxtpx:hr>140</gpxtpx:hr>");
    expect(hasGpsPoints(sampleActivity)).toBe(true);
  });

  it("generates TCX that can be parsed back into trackpoints", () => {
    const tcx = generateTcx(sampleActivity);
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

  it("generates a valid FIT activity file", () => {
    const fit = generateFit(sampleActivity);
    const stream = Stream.fromByteArray(fit);
    const decoder = new Decoder(stream);
    expect(decoder.isFIT()).toBe(true);
    expect(decoder.checkIntegrity()).toBe(true);

    const { messages, errors } = decoder.read();
    expect(errors).toEqual([]);
    expect(messages.sessionMesgs?.length).toBeGreaterThan(0);
    expect(messages.recordMesgs?.length).toBeGreaterThan(0);
  });

  it("rejects GPX export when GPS points are missing", () => {
    const indoorActivity: ActivityExportInput = {
      ...sampleActivity,
      points: sampleActivity.points.map((point) => ({ ...point, lat: null, lng: null })),
    };

    expect(() => serializeActivityExport(indoorActivity, "gpx")).toThrow(
      "GPX export requires GPS track points",
    );
    expect(serializeActivityExport(indoorActivity, "csv").contentType).toContain("text/csv");
  });
});
