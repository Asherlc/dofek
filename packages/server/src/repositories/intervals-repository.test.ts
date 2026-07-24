import { describe, expect, it, vi } from "vitest";
import { makeMockSensorStore } from "../lib/test-helpers.ts";
import { average, IntervalsRepository, maxVal, summarizeSegment } from "./intervals-repository.ts";

// ---------------------------------------------------------------------------
// Utility function tests
// ---------------------------------------------------------------------------

describe("average", () => {
  it("returns null for empty array", () => {
    expect(average([])).toBeNull();
  });

  it("returns null when all values are null", () => {
    expect(average([null, null, null])).toBeNull();
  });

  it("returns null when all values are zero", () => {
    expect(average([0, 0, 0])).toBeNull();
  });

  it("filters out null and zero values", () => {
    // Only 100 and 200 are valid → average = 150
    expect(average([null, 0, 100, 200])).toBe(150);
  });

  it("rounds to one decimal place", () => {
    // (100 + 200 + 150) / 3 = 150
    expect(average([100, 200, 150])).toBe(150);
  });

  it("rounds correctly for non-round averages", () => {
    // (10 + 20 + 33) / 3 = 21.0
    expect(average([10, 20, 33])).toBe(21);
  });

  it("handles single value", () => {
    expect(average([42])).toBe(42);
  });

  it("handles fractional result", () => {
    // (1 + 2) / 2 = 1.5
    expect(average([1, 2])).toBe(1.5);
  });
});

describe("maxVal", () => {
  it("returns null for empty array", () => {
    expect(maxVal([])).toBeNull();
  });

  it("returns null when all values are null", () => {
    expect(maxVal([null, null])).toBeNull();
  });

  it("filters out nulls and returns max", () => {
    expect(maxVal([null, 10, 50, null, 30])).toBe(50);
  });

  it("handles single value", () => {
    expect(maxVal([7])).toBe(7);
  });

  it("handles all same values", () => {
    expect(maxVal([5, 5, 5])).toBe(5);
  });

  it("includes zero values (unlike average)", () => {
    expect(maxVal([0, 10, 5])).toBe(10);
  });
});

describe("summarizeSegment", () => {
  const first = { minute_start: "2024-01-15T10:00:00Z" };
  const last = { minute_start: "2024-01-15T10:05:00Z" };

  it("computes averages and maxes from segment rows", () => {
    const rows = [
      {
        avg_power: 200,
        avg_hr: 140,
        avg_speed: 8.0,
        avg_cadence: 90,
        max_power: 250,
        max_hr: 155,
        max_speed: 9.0,
      },
      {
        avg_power: 220,
        avg_hr: 150,
        avg_speed: 8.5,
        avg_cadence: 92,
        max_power: 280,
        max_hr: 160,
        max_speed: 9.5,
      },
    ];

    const result = summarizeSegment(rows, first, last);

    expect(result.startedAt).toBe("2024-01-15T10:00:00Z");
    expect(result.endedAt).toBe("2024-01-15T10:05:00Z");
    expect(result.avgPower).toBe(210);
    expect(result.maxPower).toBe(280);
    expect(result.avgHeartRate).toBe(145);
    expect(result.maxHeartRate).toBe(160);
    expect(result.avgSpeed).toBe(8.3);
    expect(result.maxSpeed).toBe(9.5);
    expect(result.avgCadence).toBe(91);
  });

  it("returns nulls when all metric values are null", () => {
    const rows = [
      {
        avg_power: null,
        avg_hr: null,
        avg_speed: null,
        avg_cadence: null,
        max_power: null,
        max_hr: null,
        max_speed: null,
      },
    ];

    const result = summarizeSegment(rows, first, last);

    expect(result.avgPower).toBeNull();
    expect(result.maxPower).toBeNull();
    expect(result.avgHeartRate).toBeNull();
    expect(result.maxHeartRate).toBeNull();
    expect(result.avgSpeed).toBeNull();
    expect(result.maxSpeed).toBeNull();
    expect(result.avgCadence).toBeNull();
  });

  it("rounds maxHeartRate to integer", () => {
    const rows = [
      {
        avg_power: null,
        avg_hr: 140,
        avg_speed: null,
        avg_cadence: null,
        max_power: null,
        max_hr: 155.7,
        max_speed: null,
      },
    ];

    const result = summarizeSegment(rows, first, last);
    expect(result.maxHeartRate).toBe(156);
  });
});

// ---------------------------------------------------------------------------
// Repository tests
// ---------------------------------------------------------------------------

function makeDb(rows: Record<string, unknown>[] = []) {
  return { execute: vi.fn().mockResolvedValueOnce(rows) };
}

describe("IntervalsRepository", () => {
  describe("getByActivity", () => {
    it("aggregates per-interval metrics from sensor samples", async () => {
      const intervalRows = [
        {
          id: "int-1",
          interval_index: 0,
          label: "Lap 1",
          interval_type: "lap",
          started_at: "2024-01-15T10:00:00Z",
          ended_at: "2024-01-15T10:10:00Z",
          duration_seconds: 600,
        },
      ];
      const sensorRows = [
        {
          recorded_at: "2024-01-15T10:00:00Z",
          heart_rate: 140,
          power: 200,
          speed: 8.0,
          cadence: 90,
          lat: null,
          lng: null,
          altitude: null,
        },
        {
          recorded_at: "2024-01-15T10:05:00Z",
          heart_rate: 150,
          power: 220,
          speed: 8.5,
          cadence: 92,
          lat: null,
          lng: null,
          altitude: null,
        },
      ];
      const db = makeDb(intervalRows);
      const sensorStore = makeMockSensorStore(sensorRows);
      const repo = new IntervalsRepository(db, "user-1", sensorStore);

      const result = await repo.getByActivity("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe("int-1");
      expect(result[0]?.avg_power).toBe(210);
      expect(result[0]?.max_power).toBe(220);
      expect(result[0]?.avg_heart_rate).toBe(145);
    });

    it("uses only samples inside the interval and computes distance and climbing from GPS samples", async () => {
      const intervalRows = [
        {
          id: "int-gps",
          interval_index: 0,
          label: "Hill",
          interval_type: "climb",
          started_at: "2024-01-15T10:00:00Z",
          ended_at: "2024-01-15T10:10:00Z",
          duration_seconds: 600,
        },
      ];
      const sensorRows = [
        {
          recorded_at: "2024-01-15T09:59:00Z",
          heart_rate: 100,
          power: 999,
          speed: 1,
          cadence: 10,
          lat: 37,
          lng: -122,
          altitude: 100,
        },
        {
          recorded_at: "2024-01-15T10:00:00Z",
          heart_rate: 140,
          power: 0,
          speed: 8,
          cadence: 0,
          lat: 37,
          lng: -122,
          altitude: 10,
        },
        {
          recorded_at: "2024-01-15T10:05:00Z",
          heart_rate: null,
          power: null,
          speed: null,
          cadence: null,
          lat: 37.0009,
          lng: -122,
          altitude: 8,
        },
        {
          recorded_at: "2024-01-15T10:10:00Z",
          heart_rate: 160,
          power: 240,
          speed: 10,
          cadence: 95,
          lat: 37.0018,
          lng: -122,
          altitude: 25,
        },
        {
          recorded_at: "2024-01-15T10:11:00Z",
          heart_rate: 200,
          power: 500,
          speed: 20,
          cadence: 120,
          lat: 37.01,
          lng: -122,
          altitude: 200,
        },
      ];
      const db = makeDb(intervalRows);
      const sensorStore = makeMockSensorStore(sensorRows);
      const repo = new IntervalsRepository(db, "user-1", sensorStore);

      const result = await repo.getByActivity("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: "int-gps",
        avg_heart_rate: 150,
        max_heart_rate: 160,
        avg_power: 240,
        max_power: 240,
        avg_speed: 9,
        max_speed: 10,
        avg_cadence: 95,
        elevation_gain: 17,
      });
      expect(result[0]?.distance_meters).toBeGreaterThan(190);
      expect(result[0]?.distance_meters).toBeLessThan(210);
    });

    it("returns empty array when no intervals exist", async () => {
      const db = makeDb([]);
      const sensorStore = makeMockSensorStore([]);
      const repo = new IntervalsRepository(db, "user-1", sensorStore);

      const result = await repo.getByActivity("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

      expect(result).toEqual([]);
    });
  });

  describe("detect", () => {
    function makeRepo(rows: Record<string, unknown>[] = []) {
      const db = { execute: vi.fn() };
      const sensorStore = makeMockSensorStore(rows);
      return new IntervalsRepository(db, "user-1", sensorStore);
    }

    it("returns empty array when no metric data", async () => {
      const repo = makeRepo([]);

      const result = await repo.detect("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

      expect(result).toEqual([]);
    });

    it("returns single interval when intensity is stable", async () => {
      const rows = [
        {
          minute_start: "2024-01-15T10:00:00Z",
          avg_power: 200,
          avg_hr: 140,
          avg_speed: 8.0,
          avg_cadence: 90,
          max_power: 210,
          max_hr: 145,
          max_speed: 8.5,
        },
        {
          minute_start: "2024-01-15T10:01:00Z",
          avg_power: 205,
          avg_hr: 142,
          avg_speed: 8.1,
          avg_cadence: 91,
          max_power: 215,
          max_hr: 148,
          max_speed: 8.6,
        },
        {
          minute_start: "2024-01-15T10:02:00Z",
          avg_power: 198,
          avg_hr: 141,
          avg_speed: 7.9,
          avg_cadence: 89,
          max_power: 208,
          max_hr: 146,
          max_speed: 8.4,
        },
      ];
      const repo = makeRepo(rows);

      const result = await repo.detect("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

      expect(result).toHaveLength(1);
      expect(result[0]?.intervalIndex).toBe(0);
      expect(result[0]?.startedAt).toBe("2024-01-15T10:00:00Z");
      expect(result[0]?.endedAt).toBe("2024-01-15T10:02:00Z");
    });

    it("splits into multiple intervals on large power change", async () => {
      const rows = [
        {
          minute_start: "2024-01-15T10:00:00Z",
          avg_power: 200,
          avg_hr: 140,
          avg_speed: 8.0,
          avg_cadence: 90,
          max_power: 210,
          max_hr: 145,
          max_speed: 8.5,
        },
        {
          minute_start: "2024-01-15T10:01:00Z",
          avg_power: 205,
          avg_hr: 142,
          avg_speed: 8.1,
          avg_cadence: 91,
          max_power: 215,
          max_hr: 148,
          max_speed: 8.6,
        },
        {
          minute_start: "2024-01-15T10:02:00Z",
          avg_power: 300,
          avg_hr: 165,
          avg_speed: 9.5,
          avg_cadence: 95,
          max_power: 350,
          max_hr: 175,
          max_speed: 10.0,
        },
        {
          minute_start: "2024-01-15T10:03:00Z",
          avg_power: 310,
          avg_hr: 168,
          avg_speed: 9.6,
          avg_cadence: 96,
          max_power: 360,
          max_hr: 178,
          max_speed: 10.2,
        },
      ];
      const repo = makeRepo(rows);

      const result = await repo.detect("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

      expect(result).toHaveLength(2);
      expect(result[0]?.intervalIndex).toBe(0);
      expect(result[0]?.endedAt).toBe("2024-01-15T10:01:00Z");
      expect(result[1]?.intervalIndex).toBe(1);
      expect(result[1]?.startedAt).toBe("2024-01-15T10:02:00Z");
    });

    it("falls back to heart rate when power is null", async () => {
      const rows = [
        {
          minute_start: "2024-01-15T10:00:00Z",
          avg_power: null,
          avg_hr: 120,
          avg_speed: 8.0,
          avg_cadence: null,
          max_power: null,
          max_hr: 125,
          max_speed: 8.5,
        },
        {
          minute_start: "2024-01-15T10:01:00Z",
          avg_power: null,
          avg_hr: 122,
          avg_speed: 8.1,
          avg_cadence: null,
          max_power: null,
          max_hr: 128,
          max_speed: 8.6,
        },
        {
          minute_start: "2024-01-15T10:02:00Z",
          avg_power: null,
          avg_hr: 160,
          avg_speed: 9.0,
          avg_cadence: null,
          max_power: null,
          max_hr: 170,
          max_speed: 9.5,
        },
      ];
      const repo = makeRepo(rows);

      const result = await repo.detect("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

      expect(result).toHaveLength(2);
    });

    it("handles single-row dataset as one interval", async () => {
      const rows = [
        {
          minute_start: "2024-01-15T10:00:00Z",
          avg_power: 200,
          avg_hr: 140,
          avg_speed: 8.0,
          avg_cadence: 90,
          max_power: 210,
          max_hr: 145,
          max_speed: 8.5,
        },
      ];
      const repo = makeRepo(rows);

      const result = await repo.detect("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

      expect(result).toHaveLength(1);
      expect(result[0]?.intervalIndex).toBe(0);
    });
  });
});
