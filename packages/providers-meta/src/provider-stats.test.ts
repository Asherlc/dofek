import { describe, expect, it } from "vitest";
import {
  DATA_TYPE_LABELS,
  type ProviderStats,
  providerStatsBreakdown,
  providerStatsTotal,
} from "./provider-stats.ts";

const FULL_STATS: ProviderStats = {
  activities: 100,
  dailyMetrics: 200,
  sleepSessions: 50,
  bodyMeasurements: 30,
  foodEntries: 400,
  healthEvents: 10,
  metricStream: 5000,
  nutritionDaily: 150,
  labPanels: 3,
  labResults: 5,
  journalEntries: 20,
};

const SPARSE_STATS: ProviderStats = {
  activities: 42,
  dailyMetrics: 0,
  sleepSessions: 0,
  bodyMeasurements: 0,
  foodEntries: 0,
  healthEvents: 0,
  metricStream: 0,
  nutritionDaily: 0,
  labPanels: 0,
  labResults: 0,
  journalEntries: 0,
};

const EMPTY_STATS: ProviderStats = {
  activities: 0,
  dailyMetrics: 0,
  sleepSessions: 0,
  bodyMeasurements: 0,
  foodEntries: 0,
  healthEvents: 0,
  metricStream: 0,
  nutritionDaily: 0,
  labPanels: 0,
  labResults: 0,
  journalEntries: 0,
};

describe("DATA_TYPE_LABELS", () => {
  it("maps all ProviderStats keys to human-readable labels", () => {
    expect(DATA_TYPE_LABELS).toEqual([
      { key: "activities", label: "Activities" },
      { key: "metricStream", label: "Metric Stream" },
      { key: "dailyMetrics", label: "Daily Metrics" },
      { key: "sleepSessions", label: "Sleep" },
      { key: "bodyMeasurements", label: "Body" },
      { key: "foodEntries", label: "Food" },
      { key: "nutritionDaily", label: "Nutrition" },
      { key: "healthEvents", label: "Events" },
      { key: "labPanels", label: "Lab Panels" },
      { key: "labResults", label: "Lab Results" },
      { key: "journalEntries", label: "Journal" },
    ]);
  });
});

describe("providerStatsTotal", () => {
  it("sums all stat fields", () => {
    expect(providerStatsTotal(FULL_STATS)).toBe(5968);
  });

  it("returns 0 for empty stats", () => {
    expect(providerStatsTotal(EMPTY_STATS)).toBe(0);
  });

  it("returns the single non-zero value for sparse stats", () => {
    expect(providerStatsTotal(SPARSE_STATS)).toBe(42);
  });
});

describe("providerStatsBreakdown", () => {
  it("returns only non-zero entries with labels and counts", () => {
    const breakdown = providerStatsBreakdown(SPARSE_STATS);
    expect(breakdown).toEqual([{ label: "Activities", count: 42 }]);
  });

  it("returns all entries for full stats in display order", () => {
    const breakdown = providerStatsBreakdown(FULL_STATS);
    expect(breakdown).toEqual([
      { label: "Activities", count: 100 },
      { label: "Metric Stream", count: 5000 },
      { label: "Daily Metrics", count: 200 },
      { label: "Sleep", count: 50 },
      { label: "Body", count: 30 },
      { label: "Food", count: 400 },
      { label: "Nutrition", count: 150 },
      { label: "Events", count: 10 },
      { label: "Lab Panels", count: 3 },
      { label: "Lab Results", count: 5 },
      { label: "Journal", count: 20 },
    ]);
  });

  it("returns empty array for empty stats", () => {
    expect(providerStatsBreakdown(EMPTY_STATS)).toEqual([]);
  });
});
