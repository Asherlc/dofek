import { WhoopClient } from "@dofek/whoop/client";
import type {
  WhoopCycle,
  WhoopRecoveryRecord,
  WhoopSleepRecord,
  WhoopWeightliftingWorkoutResponse,
  WhoopWorkoutRecord,
} from "@dofek/whoop/types";
import { describe, expect, it } from "vitest";
import {
  buildV2ActivityTypeLookup,
  type InlineSleepRecord,
  parseHeartRateValues,
  parseInlineSleep,
  parseRecovery,
  parseSleepStages,
  parseStrainDeepDiveSteps,
  parseWeightliftingWorkout,
  parseWorkout,
  resolveActivityType,
  resolveInlineSleepExternalId,
} from "./whoop/parsing.ts";

// ============================================================
// Coverage tests for WHOOP pure parsing functions:
// - parseRecovery with non-SCORED state
// - parseWorkout without score (no distance, calories, etc.)
// - parseHeartRateValues with empty/large arrays
// - WhoopClient.authenticate MFA required path
// - WhoopClient._fetchUserId nested user object shapes
// - WhoopClient.refreshAccessToken success path
// ============================================================

describe("parseRecovery — edge cases", () => {
  it("returns undefined metrics when score_state is not SCORED", () => {
    const record: WhoopRecoveryRecord = {
      cycle_id: 100,
      sleep_id: 200,
      user_id: 10129,
      created_at: "2026-03-01T06:00:00Z",
      updated_at: "2026-03-01T06:30:00Z",
      score_state: "PENDING_MANUAL",
      score: {
        user_calibrating: false,
        recovery_score: 78,
        resting_heart_rate: 52,
        hrv_rmssd_milli: 65.5,
        spo2_percentage: 97.2,
        skin_temp_celsius: 33.7,
      },
    };

    const parsed = parseRecovery(record);
    expect(parsed.cycleId).toBe(100);
    expect(parsed.restingHr).toBeUndefined();
    expect(parsed.hrv).toBeUndefined();
    expect(parsed.spo2).toBeUndefined();
    expect(parsed.skinTemp).toBeUndefined();
  });

  it("returns undefined metrics when score is missing entirely", () => {
    const record: WhoopRecoveryRecord = {
      cycle_id: 101,
      sleep_id: 201,
      user_id: 10129,
      created_at: "2026-03-01T06:00:00Z",
      updated_at: "2026-03-01T06:30:00Z",
      score_state: "SCORED",
    };

    const parsed = parseRecovery(record);
    expect(parsed.restingHr).toBeUndefined();
    expect(parsed.hrv).toBeUndefined();
  });

  it("returns all metrics when SCORED with full score", () => {
    const record: WhoopRecoveryRecord = {
      cycle_id: 102,
      sleep_id: 202,
      user_id: 10129,
      created_at: "2026-03-01T06:00:00Z",
      updated_at: "2026-03-01T06:30:00Z",
      score_state: "SCORED",
      score: {
        user_calibrating: false,
        recovery_score: 85,
        resting_heart_rate: 48,
        hrv_rmssd_milli: 72.3,
        spo2_percentage: 98.1,
        skin_temp_celsius: 34.0,
      },
    };

    const parsed = parseRecovery(record);
    expect(parsed.restingHr).toBe(48);
    expect(parsed.hrv).toBe(72.3);
    expect(parsed.spo2).toBe(98.1);
    expect(parsed.skinTemp).toBe(34.0);
  });

  it("handles score without optional spo2 and skinTemp", () => {
    const record: WhoopRecoveryRecord = {
      cycle_id: 103,
      sleep_id: 203,
      user_id: 10129,
      created_at: "2026-03-01T06:00:00Z",
      updated_at: "2026-03-01T06:30:00Z",
      score_state: "SCORED",
      score: {
        user_calibrating: true,
        recovery_score: 60,
        resting_heart_rate: 55,
        hrv_rmssd_milli: 45.0,
      },
    };

    const parsed = parseRecovery(record);
    expect(parsed.restingHr).toBe(55);
    expect(parsed.hrv).toBe(45.0);
    expect(parsed.spo2).toBeUndefined();
    expect(parsed.skinTemp).toBeUndefined();
  });

  it("parses BFF v0 format with 'state' instead of 'score_state' and flat biometrics", () => {
    // Matches the actual production API response as of 2026-03-26:
    // keys: responded,state,recovery_score,resting_heart_rate,hrv_rmssd,
    //       calibrating,skin_temp_celsius,spo2,created_at,updated_at,activity_id,user_id
    const record: WhoopRecoveryRecord = {
      user_id: 10129,
      created_at: "2026-03-26T06:00:00Z",
      updated_at: "2026-03-26T06:30:00Z",
      state: "complete",
      recovery_score: 72,
      resting_heart_rate: 63,
      hrv_rmssd: 0.045, // seconds
      spo2: 96.5,
      skin_temp_celsius: 34.857,
      calibrating: false,
    };

    const parsed = parseRecovery(record);
    expect(parsed.restingHr).toBe(63);
    expect(parsed.hrv).toBe(45); // 0.045 * 1000 = 45ms
    expect(parsed.spo2).toBe(96.5);
    expect(parsed.skinTemp).toBe(34.857);
  });

  it("parses BFF v0 format without any state field when biometrics are present", () => {
    // API can return recovery with no score_state AND no state field
    const record: WhoopRecoveryRecord = {
      user_id: 10129,
      created_at: "2026-03-26T06:00:00Z",
      updated_at: "2026-03-26T06:30:00Z",
      recovery_score: 68,
      resting_heart_rate: 62,
      hrv_rmssd: 0.038,
      spo2: 97.0,
      skin_temp_celsius: 34.16,
      calibrating: false,
    };

    const parsed = parseRecovery(record);
    expect(parsed.restingHr).toBe(62);
    expect(parsed.hrv).toBe(38);
    expect(parsed.spo2).toBe(97.0);
    expect(parsed.skinTemp).toBe(34.16);
  });

  it("uses spo2 field when spo2_percentage is missing (BFF v0)", () => {
    const record: WhoopRecoveryRecord = {
      user_id: 10129,
      created_at: "2026-03-26T06:00:00Z",
      updated_at: "2026-03-26T06:30:00Z",
      state: "complete",
      resting_heart_rate: 55,
      hrv_rmssd: 0.06,
      spo2: 98.2,
      skin_temp_celsius: 33.5,
    };

    const parsed = parseRecovery(record);
    expect(parsed.spo2).toBe(98.2);
  });
});

describe("parseInlineSleep — BFF v0 cycle.sleeps format", () => {
  function inlineSleep(overrides: Partial<InlineSleepRecord> = {}): InlineSleepRecord {
    return {
      during: "['2026-03-26T06:28:43.510Z','2026-03-26T14:29:45.070Z')",
      state: "complete",
      time_in_bed: 28861560,
      wake_duration: 3063020,
      light_sleep_duration: 15647370,
      slow_wave_sleep_duration: 5298540,
      rem_sleep_duration: 4852630,
      in_sleep_efficiency: 89.4,
      significant: true,
      ...overrides,
    };
  }

  it("parses complete inline sleep with all fields", () => {
    const parsed = parseInlineSleep(inlineSleep(), 0);
    expect(parsed).not.toBeNull();
    expect(parsed?.startedAt).toEqual(new Date("2026-03-26T06:28:43.510Z"));
    expect(parsed?.endedAt).toEqual(new Date("2026-03-26T14:29:45.070Z"));
    expect(parsed?.durationMinutes).toBe(430); // (28861560 - 3063020) / 60000
    expect(parsed?.deepMinutes).toBe(88); // 5298540 / 60000
    expect(parsed?.remMinutes).toBe(81); // 4852630 / 60000
    expect(parsed?.lightMinutes).toBe(261); // 15647370 / 60000
    expect(parsed?.awakeMinutes).toBe(51); // 3063020 / 60000
    expect(parsed?.stagingAvailable).toBe(true);
    expect(parsed?.efficiencyPct).toBe(89.4);
    expect(parsed?.sleepType).toBe("sleep");
    expect(parsed?.isNap).toBe(false);
  });

  it("returns null for invalid during range", () => {
    const parsed = parseInlineSleep(inlineSleep({ during: "invalid" }), 0);
    expect(parsed).toBeNull();
  });

  it("marks non-significant sleeps as naps", () => {
    const parsed = parseInlineSleep(inlineSleep({ significant: false }), 0);
    expect(parsed?.sleepType).toBe("nap");
    expect(parsed?.isNap).toBe(true);
  });

  it("generates unique externalId from timestamp and index", () => {
    const parsed0 = parseInlineSleep(inlineSleep(), 0);
    const parsed1 = parseInlineSleep(inlineSleep(), 1);
    expect(parsed0?.externalId).not.toBe(parsed1?.externalId);
    expect(parsed0?.externalId).toContain("inline-");
  });

  it("resolveInlineSleepExternalId prefers WHOOP sleep ids for main sleeps", () => {
    const cycle = {
      sleep: { id: 12345 },
      recovery: {
        sleep_id: 12345,
        user_id: 10129,
        created_at: "2026-03-01T00:00:00Z",
        updated_at: "2026-03-01T00:00:00Z",
      },
    };
    expect(resolveInlineSleepExternalId(cycle, inlineSleep(), 0)).toBe("12345");
    expect(resolveInlineSleepExternalId(cycle, inlineSleep({ significant: false }), 1)).toContain(
      "inline-",
    );
  });

  it("handles missing optional fields", () => {
    const parsed = parseInlineSleep(
      inlineSleep({
        in_sleep_efficiency: undefined,
      }),
      0,
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.efficiencyPct).toBeUndefined();
  });

  it("normalizes fractional in_sleep_efficiency to percentage", () => {
    const parsed = parseInlineSleep(inlineSleep({ in_sleep_efficiency: 0.894 }), 0);
    expect(parsed?.efficiencyPct).toBeCloseTo(89.4, 1);
  });

  it("keeps percentage-scale in_sleep_efficiency as-is", () => {
    const parsed = parseInlineSleep(inlineSleep({ in_sleep_efficiency: 89.4 }), 0);
    expect(parsed?.efficiencyPct).toBe(89.4);
  });
});

describe("parseWorkout — edge cases", () => {
  it("handles workout without score", () => {
    const record: WhoopWorkoutRecord = {
      activity_id: "uuid-400",
      during: "['2026-03-01T10:00:00Z','2026-03-01T11:00:00Z')",
      timezone_offset: "-05:00",
      sport_id: 0,
    };

    const parsed = parseWorkout(record);
    expect(parsed).not.toBeNull();
    expect(parsed?.externalId).toBe("uuid-400");
    expect(parsed?.activityType.canonicalType).toBe("running");
    expect(parsed?.durationSeconds).toBe(3600);
    expect(parsed?.distanceMeters).toBeUndefined();
    expect(parsed?.avgHeartRate).toBeUndefined();
    expect(parsed?.maxHeartRate).toBeUndefined();
    expect(parsed?.totalElevationGain).toBeUndefined();
  });

  it("maps unknown sport ID to other", () => {
    const record: WhoopWorkoutRecord = {
      activity_id: "uuid-401",
      during: "['2026-03-01T10:00:00Z','2026-03-01T11:00:00Z')",
      timezone_offset: "-05:00",
      sport_id: 9999,
      score: 5,
      average_heart_rate: 120,
      max_heart_rate: 140,
      kilojoules: 500,
    };

    const parsed = parseWorkout(record);
    expect(parsed).not.toBeNull();
    expect(parsed?.activityType.canonicalType).toBe("other");
  });

  it("handles score with zero kilojoule", () => {
    const record: WhoopWorkoutRecord = {
      activity_id: "uuid-403",
      during: "['2026-03-01T10:00:00Z','2026-03-01T10:30:00Z')",
      timezone_offset: "-05:00",
      sport_id: 70, // meditation
      score: 0,
      average_heart_rate: 60,
      max_heart_rate: 70,
      kilojoules: 0,
    };

    const parsed = parseWorkout(record);
    expect(parsed).not.toBeNull();
    expect(parsed?.activityType.canonicalType).toBe("meditation");
  });

  it("maps various sport IDs correctly", () => {
    const makeRecord = (sportId: number): WhoopWorkoutRecord => ({
      activity_id: `uuid-${sportId + 1000}`,
      during: "['2026-03-01T10:00:00Z','2026-03-01T11:00:00Z')",
      timezone_offset: "-05:00",
      sport_id: sportId,
      score: 5,
      average_heart_rate: 130,
      max_heart_rate: 160,
      kilojoules: 1000,
    });

    expect(parseWorkout(makeRecord(1))?.activityType.canonicalType).toBe("cycling");
    expect(parseWorkout(makeRecord(33))?.activityType.canonicalType).toBe("swimming");
    expect(parseWorkout(makeRecord(52))?.activityType.canonicalType).toBe("hiking");
    expect(parseWorkout(makeRecord(63))?.activityType.canonicalType).toBe("walking");
    expect(parseWorkout(makeRecord(45))?.activityType.canonicalType).toBe("strength");
    expect(parseWorkout(makeRecord(18))?.activityType.canonicalType).toBe("rowing");
    expect(parseWorkout(makeRecord(65))?.activityType.canonicalType).toBe("elliptical");
    expect(parseWorkout(makeRecord(29))?.activityType.canonicalType).toBe("skiing");
  });

  it("falls back to v2_activity type name when sport_id maps to other", () => {
    const record: WhoopWorkoutRecord = {
      activity_id: "uuid-walk-fallback",
      during: "['2026-03-01T10:00:00Z','2026-03-01T11:00:00Z')",
      timezone_offset: "-05:00",
      sport_id: 9999, // unknown sport_id → "other"
      score: 3,
      average_heart_rate: 100,
      max_heart_rate: 120,
      kilojoules: 500,
    };

    // Without v2 type name → "other"
    expect(parseWorkout(record)?.activityType.canonicalType).toBe("other");

    // With v2 type name "walk" → "walking"
    expect(parseWorkout(record, "walk")?.activityType.canonicalType).toBe("walking");
  });

  it("prefers sport_id mapping over v2_activity type when sport_id is known", () => {
    const record: WhoopWorkoutRecord = {
      activity_id: "uuid-sport-id-wins",
      during: "['2026-03-01T10:00:00Z','2026-03-01T11:00:00Z')",
      timezone_offset: "-05:00",
      sport_id: 63, // walking
      score: 3,
      average_heart_rate: 100,
      max_heart_rate: 120,
      kilojoules: 500,
    };

    // sport_id 63 → "walking" even if v2 type says something else
    expect(parseWorkout(record, "run")?.activityType.canonicalType).toBe("walking");
  });

  it("prefers an official developer sport name over a stale BFF sport ID", () => {
    const record: WhoopWorkoutRecord = {
      activity_id: "uuid-developer-sport-name-wins",
      during: "['2026-03-01T10:00:00Z','2026-03-01T11:00:00Z')",
      timezone_offset: "-05:00",
      sport_id: 0,
      score: 3,
      average_heart_rate: 100,
      max_heart_rate: 120,
      kilojoules: 500,
    };

    expect(parseWorkout(record, undefined, "Commuting")?.activityType).toMatchObject({
      canonicalType: "cycling",
      providerType: "Commuting",
    });
  });
});

describe("resolveActivityType", () => {
  it("returns sport_id mapping when it is not other", () => {
    expect(resolveActivityType(63).canonicalType).toBe("walking");
    expect(resolveActivityType(0).canonicalType).toBe("running");
    expect(resolveActivityType(1).canonicalType).toBe("cycling");
  });

  it("falls back to v2 type name when sport_id maps to other", () => {
    expect(resolveActivityType(9999, "walk").canonicalType).toBe("walking");
    expect(resolveActivityType(9999, "dog-walk").canonicalType).toBe("walking");
    expect(resolveActivityType(9999, "spin").canonicalType).toBe("cycling");
    expect(resolveActivityType(9999, "functional-fitness").canonicalType).toBe("strength");
    expect(resolveActivityType(9999, "functional-fitness").modality).toBe("functional");
  });

  it("returns other when both sport_id and v2 type are unknown", () => {
    expect(resolveActivityType(9999).canonicalType).toBe("other");
    expect(resolveActivityType(9999, "unknown-activity").canonicalType).toBe("other");
  });

  it("is case-insensitive for v2 type names", () => {
    expect(resolveActivityType(9999, "Walk").canonicalType).toBe("walking");
    expect(resolveActivityType(9999, "WALK").canonicalType).toBe("walking");
    expect(resolveActivityType(9999, "Dog-Walk").canonicalType).toBe("walking");
  });
});

describe("buildV2ActivityTypeLookup", () => {
  it("builds a map from activity ID to type name", () => {
    const cycles: WhoopCycle[] = [
      {
        v2_activities: [
          {
            id: "activity-1",
            type: "walk",
            during: "['2026-03-01T10:00:00Z','2026-03-01T11:00:00Z')",
            score_state: "SCORED",
            score_type: "CARDIO",
          },
          {
            id: "activity-2",
            type: "spin",
            during: "['2026-03-01T12:00:00Z','2026-03-01T13:00:00Z')",
            score_state: "SCORED",
            score_type: "CARDIO",
          },
        ],
      },
    ];

    const lookup = buildV2ActivityTypeLookup(cycles);
    expect(lookup.get("activity-1")).toBe("walk");
    expect(lookup.get("activity-2")).toBe("spin");
    expect(lookup.size).toBe(2);
  });

  it("returns empty map for cycles without v2_activities", () => {
    const cycles: WhoopCycle[] = [{}];
    const lookup = buildV2ActivityTypeLookup(cycles);
    expect(lookup.size).toBe(0);
  });
});

describe("parseHeartRateValues — edge cases", () => {
  it("returns empty array for empty input", () => {
    expect(parseHeartRateValues([])).toHaveLength(0);
  });

  it("parses heart rate values with correct dates", () => {
    const values = [
      { time: 1709280000000, data: 72 },
      { time: 1709280006000, data: 75 },
    ];

    const parsed = parseHeartRateValues(values);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.recordedAt).toEqual(new Date(1709280000000));
    expect(parsed[0]?.heartRate).toBe(72);
    expect(parsed[1]?.recordedAt).toEqual(new Date(1709280006000));
    expect(parsed[1]?.heartRate).toBe(75);
  });
});

describe("parseStrainDeepDiveSteps", () => {
  function makeStrainDeepDiveRaw(
    overrides: {
      contributorsId?: string;
      itemType?: string;
      metrics?: unknown;
      nestedSections?: boolean;
    } = {},
  ) {
    const tile = {
      type: overrides.itemType ?? "CONTRIBUTORS_TILE",
      content: {
        id: overrides.contributorsId ?? "STRAIN_CONTRIBUTORS_TILE",
        metrics: overrides.metrics ?? [{ id: "CONTRIBUTORS_TILE_STEPS", status: "4,880" }],
      },
    };
    if (overrides.nestedSections) {
      return { sections: [[{ items: [tile] }]] };
    }
    return { sections: [{ items: [tile] }] };
  }

  it("extracts comma-formatted step counts from strain contributors", () => {
    const raw = {
      sections: [
        {
          items: [
            {
              type: "CONTRIBUTORS_TILE",
              content: {
                id: "STRAIN_CONTRIBUTORS_TILE",
                metrics: [
                  {
                    id: "CONTRIBUTORS_TILE_STEPS",
                    status: "10,616",
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    expect(parseStrainDeepDiveSteps(raw)).toBe(10616);
  });

  it("returns null when the strain contributors tile is missing", () => {
    expect(parseStrainDeepDiveSteps({ sections: [] })).toBeNull();
  });

  it("returns null for non-object raw payloads", () => {
    expect(parseStrainDeepDiveSteps(null)).toBeNull();
    expect(parseStrainDeepDiveSteps("steps")).toBeNull();
  });

  it("walks nested arrays in the BFF response", () => {
    expect(parseStrainDeepDiveSteps(makeStrainDeepDiveRaw({ nestedSections: true }))).toBe(4880);
  });

  it("returns null when contributors tile id does not match strain", () => {
    expect(
      parseStrainDeepDiveSteps(
        makeStrainDeepDiveRaw({ contributorsId: "RECOVERY_CONTRIBUTORS_TILE" }),
      ),
    ).toBeNull();
    expect(parseStrainDeepDiveSteps(makeStrainDeepDiveRaw({ itemType: "OTHER_TILE" }))).toBeNull();
  });

  it("returns null when metrics are missing or malformed", () => {
    expect(parseStrainDeepDiveSteps(makeStrainDeepDiveRaw({ metrics: "not-an-array" }))).toBeNull();
    expect(
      parseStrainDeepDiveSteps(
        makeStrainDeepDiveRaw({
          metrics: [{ id: "CONTRIBUTORS_TILE_HR_ZONES_1_3", status: "1:00" }],
        }),
      ),
    ).toBeNull();
  });

  it("skips invalid metric entries before reading steps", () => {
    expect(
      parseStrainDeepDiveSteps(
        makeStrainDeepDiveRaw({
          metrics: [
            "bad-entry",
            { id: "CONTRIBUTORS_TILE_HR_ZONES_1_3", status: "1:00" },
            { id: "CONTRIBUTORS_TILE_STEPS", status: "2,500" },
          ],
        }),
      ),
    ).toBe(2500);
  });

  it("returns null when step status is not a string or not parseable", () => {
    expect(
      parseStrainDeepDiveSteps(
        makeStrainDeepDiveRaw({ metrics: [{ id: "CONTRIBUTORS_TILE_STEPS", status: 123 }] }),
      ),
    ).toBeNull();
    expect(
      parseStrainDeepDiveSteps(
        makeStrainDeepDiveRaw({ metrics: [{ id: "CONTRIBUTORS_TILE_STEPS", status: "abc" }] }),
      ),
    ).toBeNull();
    expect(
      parseStrainDeepDiveSteps(
        makeStrainDeepDiveRaw({ metrics: [{ id: "CONTRIBUTORS_TILE_STEPS", status: "-5" }] }),
      ),
    ).toBeNull();
  });

  it("trims whitespace around step counts and accepts zero", () => {
    expect(
      parseStrainDeepDiveSteps(
        makeStrainDeepDiveRaw({ metrics: [{ id: "CONTRIBUTORS_TILE_STEPS", status: " 4,880 " }] }),
      ),
    ).toBe(4880);
    expect(
      parseStrainDeepDiveSteps(
        makeStrainDeepDiveRaw({ metrics: [{ id: "CONTRIBUTORS_TILE_STEPS", status: "0" }] }),
      ),
    ).toBe(0);
  });
});

describe("WhoopClient.authenticate — MFA required path", () => {
  it("throws when MFA is required", async () => {
    const mockFetch: typeof globalThis.fetch = (_input: RequestInfo | URL) => {
      const url = _input.toString();
      if (url.includes("auth-service/v3/whoop")) {
        return Promise.resolve(
          Response.json({
            ChallengeName: "SMS_MFA",
            Session: "mfa-session",
          }),
        );
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };

    await expect(WhoopClient.authenticate("user@test.com", "pass", mockFetch)).rejects.toThrow(
      /MFA/,
    );
  });

  it("returns token when no MFA required", async () => {
    const mockFetch: typeof globalThis.fetch = (_input: RequestInfo | URL) => {
      const url = _input.toString();
      if (url.includes("auth-service/v3/whoop")) {
        return Promise.resolve(
          Response.json({
            AuthenticationResult: {
              AccessToken: "my-tok",
              RefreshToken: "my-ref",
              ExpiresIn: 3600,
            },
          }),
        );
      }
      if (url.includes("users-service/v2/bootstrap")) {
        return Promise.resolve(Response.json({ id: 42 }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };

    const token = await WhoopClient.authenticate("user@test.com", "pass", mockFetch);
    expect(token.accessToken).toBe("my-tok");
    expect(token.refreshToken).toBe("my-ref");
    expect(token.userId).toBe(42);
  });

  it("throws when signIn gets token but no userId from bootstrap", async () => {
    const mockFetch: typeof globalThis.fetch = (_input: RequestInfo | URL) => {
      const url = _input.toString();
      if (url.includes("auth-service/v3/whoop")) {
        return Promise.resolve(
          Response.json({
            AuthenticationResult: { AccessToken: "tok", RefreshToken: "ref", ExpiresIn: 3600 },
          }),
        );
      }
      if (url.includes("users-service/v2/bootstrap")) {
        return Promise.resolve(Response.json({ profile: {} }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };

    await expect(WhoopClient.authenticate("user@test.com", "pass", mockFetch)).rejects.toThrow(
      /user ID/i,
    );
  });
});

describe("WhoopClient._fetchUserId — various response shapes", () => {
  it("extracts user_id from top level", async () => {
    const mockFetch: typeof globalThis.fetch = (_input: RequestInfo | URL) => {
      const url = _input.toString();
      if (url.includes("users-service/v2/bootstrap")) {
        return Promise.resolve(Response.json({ user_id: 123 }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };

    const userId = await WhoopClient._fetchUserId("token", mockFetch);
    expect(userId).toBe(123);
  });

  it("extracts id from nested user object", async () => {
    const mockFetch: typeof globalThis.fetch = (_input: RequestInfo | URL) => {
      const url = _input.toString();
      if (url.includes("users-service/v2/bootstrap")) {
        return Promise.resolve(Response.json({ user: { id: 456 } }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };

    const userId = await WhoopClient._fetchUserId("token", mockFetch);
    expect(userId).toBe(456);
  });

  it("extracts user_id from nested user object", async () => {
    const mockFetch: typeof globalThis.fetch = (_input: RequestInfo | URL) => {
      const url = _input.toString();
      if (url.includes("users-service/v2/bootstrap")) {
        return Promise.resolve(Response.json({ user: { user_id: 789 } }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };

    const userId = await WhoopClient._fetchUserId("token", mockFetch);
    expect(userId).toBe(789);
  });

  it("returns null when no user ID can be extracted", async () => {
    const mockFetch: typeof globalThis.fetch = (_input: RequestInfo | URL) => {
      const url = _input.toString();
      if (url.includes("users-service/v2/bootstrap")) {
        return Promise.resolve(Response.json({ something: "else" }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };

    const userId = await WhoopClient._fetchUserId("token", mockFetch);
    expect(userId).toBeNull();
  });
});

describe("WhoopClient.refreshAccessToken — success path", () => {
  it("returns new access token and reuses old refresh token", async () => {
    const mockFetch: typeof globalThis.fetch = (_input: RequestInfo | URL) => {
      const url = _input.toString();
      if (url.includes("auth-service/v3/whoop")) {
        return Promise.resolve(
          Response.json({
            AuthenticationResult: { AccessToken: "new-access", ExpiresIn: 3600 },
          }),
        );
      }
      if (url.includes("users-service/v2/bootstrap")) {
        return Promise.resolve(Response.json({ id: 99 }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };

    const result = await WhoopClient.refreshAccessToken("old-refresh", mockFetch);
    expect(result.accessToken).toBe("new-access");
    // Should reuse old refresh token since Cognito doesn't return a new one
    expect(result.refreshToken).toBe("old-refresh");
    expect(result.userId).toBe(99);
  });

  it("returns new refresh token when Cognito provides one", async () => {
    const mockFetch: typeof globalThis.fetch = (_input: RequestInfo | URL) => {
      const url = _input.toString();
      if (url.includes("auth-service/v3/whoop")) {
        return Promise.resolve(
          Response.json({
            AuthenticationResult: {
              AccessToken: "new-access",
              RefreshToken: "new-refresh",
              ExpiresIn: 3600,
            },
          }),
        );
      }
      if (url.includes("users-service/v2/bootstrap")) {
        return Promise.resolve(Response.json({ id: 88 }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };

    const result = await WhoopClient.refreshAccessToken("old-refresh", mockFetch);
    expect(result.refreshToken).toBe("new-refresh");
  });
});

// ============================================================
// parseWorkout — legacy fallback (no `during` field)
// ============================================================

describe("parseWorkout — legacy fallback without during", () => {
  it("falls back to start/end when during is missing", () => {
    const record: WhoopWorkoutRecord = {
      activity_id: "uuid-legacy-1",
      timezone_offset: "-05:00",
      sport_id: 0,
      start: "2026-03-01T10:00:00Z",
      end: "2026-03-01T11:00:00Z",
    };

    const parsed = parseWorkout(record);
    expect(parsed).not.toBeNull();
    expect(parsed?.startedAt).toEqual(new Date("2026-03-01T10:00:00Z"));
    expect(parsed?.endedAt).toEqual(new Date("2026-03-01T11:00:00Z"));
    expect(parsed?.durationSeconds).toBe(3600);
  });

  it("falls back to created_at/updated_at when during and start/end are missing", () => {
    const record: WhoopWorkoutRecord = {
      activity_id: "uuid-legacy-2",
      timezone_offset: "-05:00",
      sport_id: 1,
      created_at: "2026-03-01T09:00:00Z",
      updated_at: "2026-03-01T10:30:00Z",
    };

    const parsed = parseWorkout(record);
    expect(parsed).not.toBeNull();
    expect(parsed?.startedAt).toEqual(new Date("2026-03-01T09:00:00Z"));
    expect(parsed?.endedAt).toEqual(new Date("2026-03-01T10:30:00Z"));
    expect(parsed?.durationSeconds).toBe(5400);
  });

  it("uses id as externalId when activity_id is missing", () => {
    const record: WhoopWorkoutRecord = {
      id: 12345,
      timezone_offset: "-05:00",
      sport_id: 0,
      during: "['2026-03-01T10:00:00Z','2026-03-01T11:00:00Z')",
    };

    const parsed = parseWorkout(record);
    expect(parsed).not.toBeNull();
    expect(parsed?.externalId).toBe("12345");
  });

  it("falls back to id when activity_id is blank", () => {
    const record: WhoopWorkoutRecord = {
      activity_id: "   ",
      id: 67890,
      timezone_offset: "-05:00",
      sport_id: 0,
      during: "['2026-03-01T10:00:00Z','2026-03-01T11:00:00Z')",
    };

    const parsed = parseWorkout(record);
    expect(parsed).not.toBeNull();
    expect(parsed?.externalId).toBe("67890");
  });
});

// ============================================================
// parseWeightliftingWorkout — MSK strain and strap location
// ============================================================

describe("parseWeightliftingWorkout — MSK strain breakdown", () => {
  it("extracts MSK strain scores from response", () => {
    const response: WhoopWeightliftingWorkoutResponse = {
      activity_id: "test-msk",
      user_id: 1,
      zone_durations: {},
      workout_groups: [],
      total_effective_volume_kg: 2047,
      raw_msk_strain_score: 0.0288,
      scaled_msk_strain_score: 2.856,
      cardio_strain_score: 1.549,
      cardio_strain_contribution_percent: 0.329,
      msk_strain_contribution_percent: 0.671,
    };

    const result = parseWeightliftingWorkout(response);
    expect(result.rawMskStrainScore).toBe(0.0288);
    expect(result.scaledMskStrainScore).toBe(2.856);
    expect(result.cardioStrainScore).toBe(1.549);
    expect(result.cardioStrainContributionPercent).toBe(0.329);
    expect(result.mskStrainContributionPercent).toBe(0.671);
  });
});

describe("parseWeightliftingWorkout — strap location", () => {
  it("extracts strap location from sets", () => {
    const response: WhoopWeightliftingWorkoutResponse = {
      activity_id: "test-strap",
      user_id: 1,
      zone_durations: {},
      workout_groups: [
        {
          workout_exercises: [
            {
              sets: [
                {
                  weight_kg: 20,
                  number_of_reps: 10,
                  msk_total_volume_kg: 200,
                  time_in_seconds: 0,
                  during: "['2026-03-12T21:37:00.000Z','2026-03-12T21:37:00.001Z')",
                  complete: true,
                  strap_location: "BICEP",
                  strap_location_laterality: "LEFT",
                },
              ],
              exercise_details: {
                exercise_id: "CURL",
                name: "Bicep Curl",
                equipment: "DUMBBELL",
                exercise_type: "STRENGTH",
                muscle_groups: ["BICEPS"],
                volume_input_format: "REPS_AND_WEIGHT",
              },
            },
          ],
        },
      ],
      total_effective_volume_kg: 200,
      raw_msk_strain_score: 0.01,
      scaled_msk_strain_score: 1.0,
      cardio_strain_score: 0.5,
      cardio_strain_contribution_percent: 0.3,
      msk_strain_contribution_percent: 0.7,
    };

    const result = parseWeightliftingWorkout(response);
    expect(result.exercises[0]?.sets[0]?.strapLocation).toBe("BICEP");
    expect(result.exercises[0]?.sets[0]?.strapLocationLaterality).toBe("LEFT");
  });

  it("returns null strap location for manually-logged sets", () => {
    const response: WhoopWeightliftingWorkoutResponse = {
      activity_id: "test-no-strap",
      user_id: 1,
      zone_durations: {},
      workout_groups: [
        {
          workout_exercises: [
            {
              sets: [
                {
                  weight_kg: 50,
                  number_of_reps: 8,
                  msk_total_volume_kg: 400,
                  time_in_seconds: 0,
                  during: "['2026-03-12T22:00:00.000Z','2026-03-12T22:00:00.001Z')",
                  complete: true,
                  strap_location: null,
                  strap_location_laterality: null,
                },
              ],
              exercise_details: {
                exercise_id: "BENCHPRESS",
                name: "Bench Press",
                equipment: "BARBELL",
                exercise_type: "STRENGTH",
                muscle_groups: ["CHEST"],
                volume_input_format: "REPS_AND_WEIGHT",
              },
            },
          ],
        },
      ],
      total_effective_volume_kg: 400,
      raw_msk_strain_score: 0,
      scaled_msk_strain_score: 0,
      cardio_strain_score: 0,
      cardio_strain_contribution_percent: 0,
      msk_strain_contribution_percent: 0,
    };

    const result = parseWeightliftingWorkout(response);
    expect(result.exercises[0]?.sets[0]?.strapLocation).toBeNull();
    expect(result.exercises[0]?.sets[0]?.strapLocationLaterality).toBeNull();
  });
});

// ============================================================
// parseWeightliftingWorkout — exercise metadata
// ============================================================

describe("parseWeightliftingWorkout — exercise metadata", () => {
  it("extracts muscle groups and exercise type", () => {
    const response: WhoopWeightliftingWorkoutResponse = {
      activity_id: "test-metadata",
      user_id: 1,
      zone_durations: {},
      workout_groups: [
        {
          workout_exercises: [
            {
              sets: [
                {
                  weight_kg: 50,
                  number_of_reps: 8,
                  msk_total_volume_kg: 400,
                  time_in_seconds: 0,
                  during: "['2026-03-12T22:00:00.000Z','2026-03-12T22:00:00.001Z')",
                  complete: true,
                  strap_location: null,
                  strap_location_laterality: null,
                },
              ],
              exercise_details: {
                exercise_id: "BENCHPRESS",
                name: "Bench Press",
                equipment: "BARBELL",
                exercise_type: "STRENGTH",
                muscle_groups: ["CHEST", "TRICEPS"],
                volume_input_format: "REPS_AND_WEIGHT",
              },
            },
          ],
        },
      ],
      total_effective_volume_kg: 400,
      raw_msk_strain_score: 0,
      scaled_msk_strain_score: 0,
      cardio_strain_score: 0,
      cardio_strain_contribution_percent: 0,
      msk_strain_contribution_percent: 0,
    };

    const result = parseWeightliftingWorkout(response);
    expect(result.exercises[0]?.muscleGroups).toEqual(["CHEST", "TRICEPS"]);
    expect(result.exercises[0]?.exerciseType).toBe("STRENGTH");
  });
});

// ============================================================
// parseWeightliftingWorkout — additional edge cases
// ============================================================

describe("parseWeightliftingWorkout — additional edge cases", () => {
  it("returns null duration for TIME format with zero time_in_seconds", () => {
    const response: WhoopWeightliftingWorkoutResponse = {
      activity_id: "test-time-zero",
      user_id: 1,
      zone_durations: {
        zone0_to10_duration: 0,
        zone10_to20_duration: 0,
        zone20_to30_duration: 0,
        zone30_to40_duration: 0,
        zone40_to50_duration: 0,
        zone50_to60_duration: 0,
        zone60_to70_duration: 0,
        zone70_to80_duration: 0,
        zone80_to90_duration: 0,
        zone90_to100_duration: 0,
      },
      workout_groups: [
        {
          workout_exercises: [
            {
              sets: [
                {
                  weight_kg: 0,
                  number_of_reps: 0,
                  msk_total_volume_kg: 0,
                  time_in_seconds: 0,
                  during: "['2026-03-12T21:37:00.000Z','2026-03-12T21:37:00.001Z')",
                  complete: true,
                  strap_location: null,
                  strap_location_laterality: null,
                },
              ],
              exercise_details: {
                exercise_id: "PLANK",
                name: "Plank",
                equipment: "BODY",
                exercise_type: "STRENGTH",
                muscle_groups: ["CORE"],
                volume_input_format: "TIME",
              },
            },
          ],
        },
      ],
      total_effective_volume_kg: 0,
      raw_msk_strain_score: 0,
      scaled_msk_strain_score: 0,
      cardio_strain_score: 0,
      cardio_strain_contribution_percent: 0,
      msk_strain_contribution_percent: 0,
    };

    const result = parseWeightliftingWorkout(response);
    expect(result.exercises[0]?.sets[0]?.durationSeconds).toBeNull();
  });

  it("sets equipment to null when empty string", () => {
    const response: WhoopWeightliftingWorkoutResponse = {
      activity_id: "test-no-equip",
      user_id: 1,
      zone_durations: {
        zone0_to10_duration: 0,
        zone10_to20_duration: 0,
        zone20_to30_duration: 0,
        zone30_to40_duration: 0,
        zone40_to50_duration: 0,
        zone50_to60_duration: 0,
        zone60_to70_duration: 0,
        zone70_to80_duration: 0,
        zone80_to90_duration: 0,
        zone90_to100_duration: 0,
      },
      workout_groups: [
        {
          workout_exercises: [
            {
              sets: [
                {
                  weight_kg: 20,
                  number_of_reps: 10,
                  msk_total_volume_kg: 200,
                  time_in_seconds: 0,
                  during: "['2026-03-12T21:37:00.000Z','2026-03-12T21:37:00.001Z')",
                  complete: true,
                  strap_location: null,
                  strap_location_laterality: null,
                },
              ],
              exercise_details: {
                exercise_id: "PUSHUP",
                name: "Push Up",
                equipment: "",
                exercise_type: "STRENGTH",
                muscle_groups: ["CHEST"],
                volume_input_format: "REPS_AND_WEIGHT",
              },
            },
          ],
        },
      ],
      total_effective_volume_kg: 200,
      raw_msk_strain_score: 0,
      scaled_msk_strain_score: 0,
      cardio_strain_score: 0,
      cardio_strain_contribution_percent: 0,
      msk_strain_contribution_percent: 0,
    };

    const result = parseWeightliftingWorkout(response);
    expect(result.exercises[0]?.equipment).toBeNull();
  });
});

describe("parseSleepStages", () => {
  it("maps WHOOP stage names to canonical stages", () => {
    const record: WhoopSleepRecord = {
      id: 101,
      user_id: 1,
      created_at: "2026-03-01T08:00:00Z",
      updated_at: "2026-03-01T08:00:00Z",
      timezone_offset: "Z",
      nap: false,
      stages: [
        { stage: "awake", during: "['2026-03-01T00:00:00Z','2026-03-01T00:15:00Z')" },
        { stage: "light", during: "['2026-03-01T00:15:00Z','2026-03-01T01:00:00Z')" },
        { stage: "rem", during: "['2026-03-01T01:00:00Z','2026-03-01T01:30:00Z')" },
        { stage: "deep", during: "['2026-03-01T01:30:00Z','2026-03-01T02:00:00Z')" },
        { stage: "slow_wave", during: "['2026-03-01T02:00:00Z','2026-03-01T02:30:00Z')" },
        { stage: "unknown", during: "['2026-03-01T02:30:00Z','2026-03-01T02:45:00Z')" },
      ],
    };

    const parsed = parseSleepStages(record);
    expect(parsed).toHaveLength(5);
    expect(parsed[0]).toEqual({
      stage: "awake",
      startedAt: new Date("2026-03-01T00:00:00Z"),
      endedAt: new Date("2026-03-01T00:15:00Z"),
    });
    expect(parsed[1]?.stage).toBe("light");
    expect(parsed[2]?.stage).toBe("rem");
    expect(parsed[3]?.stage).toBe("deep");
    expect(parsed[4]?.stage).toBe("deep"); // slow_wave -> deep
  });

  it("handles empty or missing stages", () => {
    const record: WhoopSleepRecord = {
      id: 102,
      user_id: 1,
      created_at: "2026-03-01T08:00:00Z",
      updated_at: "2026-03-01T08:00:00Z",
      timezone_offset: "Z",
      nap: false,
    };
    expect(parseSleepStages(record)).toHaveLength(0);
    expect(parseSleepStages({ ...record, stages: [] })).toHaveLength(0);
  });

  it("skips stages with unparseable during ranges", () => {
    const record: WhoopSleepRecord = {
      id: 103,
      user_id: 1,
      created_at: "2026-03-01T08:00:00Z",
      updated_at: "2026-03-01T08:00:00Z",
      timezone_offset: "Z",
      nap: false,
      stages: [
        { stage: "light", during: "not-a-range" },
        { stage: "rem", during: "['2026-03-01T01:00:00Z','2026-03-01T01:30:00Z')" },
      ],
    };

    const parsed = parseSleepStages(record);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.stage).toBe("rem");
  });
});
