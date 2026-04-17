import { describe, expect, it } from "vitest";
import { parseTcx, tcxToSensorSamples } from "./parser.ts";

const SAMPLE_TCX = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase>
  <Activities>
    <Activity Sport="Running">
      <Lap StartTime="2024-01-15T10:00:00Z">
        <Track>
          <Trackpoint>
            <Time>2024-01-15T10:00:00Z</Time>
            <Position>
              <LatitudeDegrees>40.7128</LatitudeDegrees>
              <LongitudeDegrees>-74.006</LongitudeDegrees>
            </Position>
            <AltitudeMeters>10.5</AltitudeMeters>
            <HeartRateBpm><Value>155</Value></HeartRateBpm>
            <Cadence>80</Cadence>
          </Trackpoint>
          <Trackpoint>
            <Time>2024-01-15T10:00:05Z</Time>
            <Position>
              <LatitudeDegrees>40.7129</LatitudeDegrees>
              <LongitudeDegrees>-74.0061</LongitudeDegrees>
            </Position>
            <AltitudeMeters>11.0</AltitudeMeters>
            <HeartRateBpm><Value>160</Value></HeartRateBpm>
            <Cadence>82</Cadence>
          </Trackpoint>
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;

describe("parseTcx", () => {
  it("parses trackpoints with GPS, altitude, HR, and cadence", () => {
    const [first] = parseTcx(SAMPLE_TCX);

    expect(first).toBeDefined();
    expect(first?.lat).toBeCloseTo(40.7128);
    expect(first?.lng).toBeCloseTo(-74.006);
    expect(first?.altitude).toBeCloseTo(10.5);
    expect(first?.heartRate).toBe(155);
    expect(first?.cadence).toBe(80);
    expect(first?.recordedAt).toEqual(new Date("2024-01-15T10:00:00Z"));
  });

  it("parses second trackpoint correctly", () => {
    const [, second] = parseTcx(SAMPLE_TCX);

    expect(second).toBeDefined();
    expect(second?.lat).toBeCloseTo(40.7129);
    expect(second?.heartRate).toBe(160);
    expect(second?.cadence).toBe(82);
  });

  it("handles trackpoints without GPS position", () => {
    const tcx = `<?xml version="1.0"?>
    <TrainingCenterDatabase>
      <Activities><Activity><Lap><Track>
        <Trackpoint>
          <Time>2024-01-15T10:00:00Z</Time>
          <HeartRateBpm><Value>140</Value></HeartRateBpm>
        </Trackpoint>
      </Track></Lap></Activity></Activities>
    </TrainingCenterDatabase>`;

    const [point] = parseTcx(tcx);

    expect(point).toBeDefined();
    expect(point?.lat).toBeUndefined();
    expect(point?.lng).toBeUndefined();
    expect(point?.heartRate).toBe(140);
  });

  it("handles extensions with power and speed", () => {
    const tcx = `<?xml version="1.0"?>
    <TrainingCenterDatabase>
      <Activities><Activity><Lap><Track>
        <Trackpoint>
          <Time>2024-01-15T10:00:00Z</Time>
          <Extensions>
            <TPX><Watts>250</Watts><Speed>3.5</Speed></TPX>
          </Extensions>
        </Trackpoint>
      </Track></Lap></Activity></Activities>
    </TrainingCenterDatabase>`;

    const [point] = parseTcx(tcx);

    expect(point).toBeDefined();
    expect(point?.power).toBe(250);
    expect(point?.speed).toBeCloseTo(3.5);
  });

  it("returns empty array for empty TCX", () => {
    const tcx = `<?xml version="1.0"?>
    <TrainingCenterDatabase>
      <Activities><Activity><Lap><Track>
      </Track></Lap></Activity></Activities>
    </TrainingCenterDatabase>`;

    expect(parseTcx(tcx)).toHaveLength(0);
  });

  it("accepts Buffer input", () => {
    const buffer = Buffer.from(SAMPLE_TCX, "utf-8");
    const points = parseTcx(buffer);
    expect(points).toHaveLength(2);
  });

  it("handles malformed XML gracefully", () => {
    const tcx = `<?xml version="1.0"?>
    <TrainingCenterDatabase>
      <Activities><Activity><Lap><Track>
        <Trackpoint>
          <Time>2024-01-15T10:00:00Z</Time>
          <HeartRateBpm><Value>140</Value></HeartRateBpm>
        <!-- missing closing tag -->
      </Track></Lap></Activity></Activities>
    </TrainingCenterDatabase>`;

    const points = parseTcx(tcx);
    // SAX parser will still try to find whatever it can
    expect(Array.isArray(points)).toBe(true);
  });

  it("handles trackpoints without a Time tag", () => {
    const tcx = `<?xml version="1.0"?>
    <TrainingCenterDatabase>
      <Activities><Activity><Lap><Track>
        <Trackpoint>
          <HeartRateBpm><Value>140</Value></HeartRateBpm>
        </Trackpoint>
      </Track></Lap></Activity></Activities>
    </TrainingCenterDatabase>`;

    const points = parseTcx(tcx);
    // Should skip trackpoints without Time
    expect(points).toHaveLength(0);
  });

  it("handles empty or whitespace-only tags", () => {
    const tcx = `<?xml version="1.0"?>
    <TrainingCenterDatabase>
      <Activities><Activity><Lap><Track>
        <Trackpoint>
          <Time>  </Time>
          <HeartRateBpm><Value>140</Value></HeartRateBpm>
        </Trackpoint>
      </Track></Lap></Activity></Activities>
    </TrainingCenterDatabase>`;

    const points = parseTcx(tcx);
    expect(points).toHaveLength(0);
  });
});

describe("tcxToSensorSamples", () => {
  it("converts trackpoints to metric stream rows", () => {
    const points = parseTcx(SAMPLE_TCX);
    const rows = tcxToSensorSamples(points, "fitbit", "activity-123");

    expect(rows).toHaveLength(2);
    const [firstRow] = rows;
    expect(firstRow).toBeDefined();
    expect(firstRow?.providerId).toBe("fitbit");
    expect(firstRow?.activityId).toBe("activity-123");
    expect(firstRow?.lat).toBeCloseTo(40.7128);
    expect(firstRow?.lng).toBeCloseTo(-74.006);
    expect(firstRow?.heartRate).toBe(155);
  });
});
