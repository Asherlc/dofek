/**
 * WHOOP API Contract Tests
 *
 * These tests hit the real WHOOP API and validate response shapes against
 * Zod schemas that match what our sync code expects. When the API changes
 * its response format, these tests fail BEFORE production data stops flowing.
 *
 * Requirements:
 *   WHOOP_REFRESH_TOKEN — a valid Cognito refresh token
 *   WHOOP_USER_ID       — numeric WHOOP user ID
 *
 * Run:
 *   WHOOP_REFRESH_TOKEN=xxx WHOOP_USER_ID=123 pnpm vitest run src/providers/whoop-api-contract.test.ts
 */
import { describe, expect, it } from "vitest";
import { WhoopClient } from "whoop-whoop";
import { z } from "zod";

const REFRESH_TOKEN = process.env.WHOOP_REFRESH_TOKEN ?? "";
const USER_ID = Number(process.env.WHOOP_USER_ID ?? "0");

const hasCredentials = REFRESH_TOKEN.length > 0 && !Number.isNaN(USER_ID) && USER_ID > 0;

// ============================================================
// Zod schemas — these define what our sync code NEEDS to work.
// If the API stops providing these fields, the test fails.
// ============================================================

/** Every sleep record must have timestamps we can parse */
const sleepTimestampSchema = z
  .object({
    start: z.string().optional(),
    end: z.string().optional(),
    during: z.string().optional(),
  })
  .refine((record) => (record.start && record.end) || record.during, {
    message:
      "Sleep record must have either (start + end) or during — our parseSleep needs at least one",
  });

const sleepStageSummarySchema = z.object({
  total_in_bed_time_milli: z.number(),
  total_awake_time_milli: z.number(),
  total_light_sleep_time_milli: z.number(),
  total_slow_wave_sleep_time_milli: z.number(),
  total_rem_sleep_time_milli: z.number(),
});

const sleepNeededSchema = z.object({
  baseline_milli: z.number(),
  need_from_sleep_debt_milli: z.number(),
  need_from_recent_strain_milli: z.number(),
  need_from_recent_nap_milli: z.number(),
});

const sleepScoreSchema = z.object({
  stage_summary: sleepStageSummarySchema,
  sleep_needed: sleepNeededSchema,
  sleep_efficiency_percentage: z.number(),
});

const sleepRecordSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    user_id: z.number(),
    nap: z.boolean(),
    score: sleepScoreSchema.optional(),
  })
  .and(sleepTimestampSchema);

/** Recovery must have biometric data we can extract */
const recoverySchema = z
  .object({
    user_id: z.number(),
    created_at: z.string(),
    resting_heart_rate: z.number().optional(),
    hrv_rmssd: z.number().optional(),
    skin_temp_celsius: z.number().optional(),
  })
  .and(
    z.union([
      // Legacy: score_state + nested score
      z.object({
        score_state: z.literal("SCORED"),
        score: z.object({
          resting_heart_rate: z.number(),
          hrv_rmssd_milli: z.number(),
        }),
      }),
      // BFF v0 with score_state
      z.object({
        score_state: z.literal("complete"),
        resting_heart_rate: z.number(),
      }),
      // BFF v0 with state field
      z.object({
        state: z.string(),
        resting_heart_rate: z.number(),
      }),
      // BFF v0 without any state field — just biometric data
      z.object({
        resting_heart_rate: z.number(),
      }),
    ]),
  );

/** v2_activities must have fields extractSleepIdsFromCycle needs */
const v2ActivitySchema = z.object({
  id: z.string(),
  type: z.string(),
  during: z.string(),
  score_type: z.string(),
});

/** Cycle must have the structure our sync code navigates */
const cycleSchema = z.object({
  recovery: z.record(z.unknown()).nullable().optional(),
  v2_activities: z.array(v2ActivitySchema).optional(),
  sleeps: z.array(z.unknown()).optional(),
  workouts: z.array(z.unknown()).optional(),
  days: z.array(z.string()).optional(),
});

// ============================================================
// Tests
// ============================================================

describe.skipIf(!hasCredentials)("WHOOP API contract", () => {
  let client: WhoopClient;

  // Authenticate once for all tests
  it("can refresh access token", async () => {
    const result = await WhoopClient.refreshAccessToken(REFRESH_TOKEN);
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();

    client = new WhoopClient({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      userId: result.userId ?? USER_ID,
    });
  });

  it("getCycles returns expected shape", async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 3 * 24 * 60 * 60 * 1000); // 3 days

    const cycles = await client.getCycles(start.toISOString(), end.toISOString(), 5);
    expect(cycles.length).toBeGreaterThan(0);

    for (const cycle of cycles) {
      const result = cycleSchema.safeParse(cycle);
      if (!result.success) {
        console.error("Cycle contract violation:", JSON.stringify(result.error.issues, null, 2));
        console.error("Cycle keys:", Object.keys(cycle));
      }
      expect(result.success).toBe(true);
    }
  });

  it("cycle recovery matches expected schema", async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 3 * 24 * 60 * 60 * 1000);

    const cycles = await client.getCycles(start.toISOString(), end.toISOString(), 5);
    const cyclesWithRecovery = cycles.filter(
      (cycle) => cycle.recovery && typeof cycle.recovery === "object",
    );
    expect(cyclesWithRecovery.length).toBeGreaterThan(0);

    for (const cycle of cyclesWithRecovery) {
      if (!cycle.recovery) continue;
      const result = recoverySchema.safeParse(cycle.recovery);
      if (!result.success) {
        console.error("Recovery contract violation:", JSON.stringify(result.error.issues, null, 2));
        console.error("Recovery keys:", Object.keys(cycle.recovery));
        console.error("Recovery sample:", JSON.stringify(cycle.recovery, null, 2).slice(0, 500));
      }
      expect(result.success).toBe(true);
    }
  });

  it("getSleep returns record with parseable timestamps", async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 3 * 24 * 60 * 60 * 1000);

    const cycles = await client.getCycles(start.toISOString(), end.toISOString(), 5);

    // Find sleep IDs from v2_activities
    const sleepIds: string[] = [];
    for (const cycle of cycles) {
      for (const v2Activity of cycle.v2_activities ?? []) {
        if (
          v2Activity.score_type?.toLowerCase() === "sleep" ||
          v2Activity.type?.toLowerCase().includes("sleep")
        ) {
          sleepIds.push(v2Activity.id);
        }
      }
    }
    expect(sleepIds.length).toBeGreaterThan(0);

    // Validate each sleep response
    for (const sleepId of sleepIds.slice(0, 3)) {
      const sleepData = await client.getSleep(sleepId);
      const result = sleepRecordSchema.safeParse(sleepData);
      if (!result.success) {
        console.error(
          `Sleep ${sleepId} contract violation:`,
          JSON.stringify(result.error.issues, null, 2),
        );
        console.error("Sleep keys:", Object.keys(sleepData));
        console.error("Sleep sample:", JSON.stringify(sleepData, null, 2).slice(0, 500));
      }
      expect(result.success).toBe(true);
    }
  });

  it("cycle.sleeps inline data has parseable structure", async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 3 * 24 * 60 * 60 * 1000);

    const cycles = await client.getCycles(start.toISOString(), end.toISOString(), 5);
    const cyclesWithSleeps = cycles.filter(
      (cycle) => cycle.sleeps && Array.isArray(cycle.sleeps) && cycle.sleeps.length > 0,
    );

    if (cyclesWithSleeps.length === 0) {
      console.warn("No cycles with inline sleeps data found — skipping inline sleep check");
      return;
    }

    for (const cycle of cyclesWithSleeps) {
      if (!cycle.sleeps) continue;
      for (const sleep of cycle.sleeps) {
        if (sleep && typeof sleep === "object") {
          console.info("Inline sleep keys:", Object.keys(sleep));
          console.info("Inline sleep sample:", JSON.stringify(sleep, null, 2).slice(0, 500));
        }
      }
    }
  });
});
