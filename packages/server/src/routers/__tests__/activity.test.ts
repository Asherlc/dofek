import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";

import { createTestCallerFactory } from "./test-helpers.ts";

// Mock tRPC infrastructure
vi.mock("../../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const t = initTRPC.context<{ db: unknown; userId: string | null }>().create();
  return {
    router: t.router,
    protectedProcedure: t.procedure,
    cachedProtectedQuery: () => t.procedure,
    cachedProtectedQueryLight: () => t.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

import { activityRouter } from "../activity.ts";

const createCaller = createTestCallerFactory(activityRouter);

function makeCaller(rows: Record<string, unknown>[] = []) {
  return createCaller({
    // @ts-expect-error mock DB
    db: { execute: vi.fn().mockResolvedValue(rows) },
    userId: "user-1",
  });
}

describe("activityRouter", () => {
  describe("list", () => {
    it("returns rows from db", async () => {
      const rows = [{ id: "a1", started_at: "2024-01-01" }];
      const caller = makeCaller(rows);
      const result = await caller.list({ days: 30 });
      expect(result).toEqual(rows);
    });

    it("returns empty array when no activities", async () => {
      const caller = makeCaller([]);
      const result = await caller.list({ days: 30 });
      expect(result).toEqual([]);
    });
  });

  describe("byId", () => {
    it("returns mapped activity detail", async () => {
      const row = {
        id: "abc-123",
        activity_type: "cycling",
        started_at: "2024-01-01T10:00:00Z",
        ended_at: "2024-01-01T11:00:00Z",
        name: "Morning Ride",
        notes: null,
        provider_id: "wahoo",
        source_providers: ["wahoo"],
        avg_hr: 150,
        max_hr: 180,
        avg_power: 200,
        max_power: 350,
        avg_speed: 8.5,
        max_speed: 12.0,
        avg_cadence: 85,
        total_distance: 30000,
        elevation_gain_m: 300,
        elevation_loss_m: 280,
        sample_count: 3600,
      };
      const caller = makeCaller([row]);
      const result = await caller.byId({ id: "00000000-0000-0000-0000-000000000001" });

      expect(result.id).toBe("abc-123");
      expect(result.activityType).toBe("cycling");
      expect(result.avgHr).toBe(150);
      expect(result.maxPower).toBe(350);
      expect(result.elevationGain).toBe(300);
    });

    it("throws NOT_FOUND when activity does not exist", async () => {
      const caller = makeCaller([]);
      await expect(caller.byId({ id: "00000000-0000-0000-0000-000000000001" })).rejects.toThrow(
        TRPCError,
      );
    });

    it("handles null optional fields", async () => {
      const row = {
        id: "abc-123",
        activity_type: "running",
        started_at: "2024-01-01",
        ended_at: null,
        name: null,
        notes: null,
        provider_id: "manual",
        source_providers: null,
        avg_hr: null,
        max_hr: null,
        avg_power: null,
        max_power: null,
        avg_speed: null,
        max_speed: null,
        avg_cadence: null,
        total_distance: null,
        elevation_gain_m: null,
        elevation_loss_m: null,
        sample_count: null,
      };
      const caller = makeCaller([row]);
      const result = await caller.byId({ id: "00000000-0000-0000-0000-000000000001" });

      expect(result.endedAt).toBeNull();
      expect(result.name).toBeNull();
      expect(result.avgHr).toBeNull();
      expect(result.sourceProviders).toEqual([]);
    });
  });

  describe("stream", () => {
    it("returns mapped stream points", async () => {
      const rows = [
        {
          recorded_at: "2024-01-01T10:00:00Z",
          heart_rate: 150,
          power: 200,
          speed: 8.5,
          cadence: 85,
          altitude: 100,
          lat: 40.7128,
          lng: -74.006,
          distance: 1000,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.stream({
        id: "00000000-0000-0000-0000-000000000001",
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.recordedAt).toBe("2024-01-01T10:00:00Z");
      expect(result[0]?.heartRate).toBe(150);
      expect(result[0]?.power).toBe(200);
    });

    it("handles null values in stream points", async () => {
      const rows = [
        {
          recorded_at: "2024-01-01T10:00:00Z",
          heart_rate: null,
          power: null,
          speed: null,
          cadence: null,
          altitude: null,
          lat: null,
          lng: null,
          distance: null,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.stream({
        id: "00000000-0000-0000-0000-000000000001",
      });

      expect(result[0]?.heartRate).toBeNull();
      expect(result[0]?.power).toBeNull();
    });
  });

  describe("hrZones", () => {
    it("returns 5 zones with labels", async () => {
      const rows = [
        { zone: 1, seconds: 600 },
        { zone: 2, seconds: 1200 },
        { zone: 3, seconds: 900 },
        { zone: 4, seconds: 300 },
        { zone: 5, seconds: 60 },
      ];
      const caller = makeCaller(rows);
      const result = await caller.hrZones({
        id: "00000000-0000-0000-0000-000000000001",
      });

      expect(result).toHaveLength(5);
      expect(result[0]).toEqual({
        zone: 1,
        label: "Recovery",
        minPct: 50,
        maxPct: 60,
        seconds: 600,
      });
      expect(result[4]).toMatchObject({ zone: 5, label: "Anaerobic" });
    });

    it("defaults missing zones to 0 seconds", async () => {
      const rows = [{ zone: 2, seconds: 500 }];
      const caller = makeCaller(rows);
      const result = await caller.hrZones({
        id: "00000000-0000-0000-0000-000000000001",
      });

      expect(result[0]?.seconds).toBe(0);
      expect(result[1]?.seconds).toBe(500);
      expect(result[2]?.seconds).toBe(0);
    });
  });
});
