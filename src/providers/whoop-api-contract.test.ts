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

import { WhoopClient } from "@dofek/whoop/client";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { inlineSleepSchema, parseInlineSleep } from "./whoop/parsing.ts";

const REFRESH_TOKEN = process.env.WHOOP_REFRESH_TOKEN ?? "";
const USER_ID = Number(process.env.WHOOP_USER_ID ?? "0");

const hasCredentials = REFRESH_TOKEN.length > 0 && !Number.isNaN(USER_ID) && USER_ID > 0;

// ============================================================
// Zod schemas — these define what our sync code NEEDS to work.
// If the API stops providing these fields, the test fails.
// ============================================================

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
  recovery: z.record(z.string(), z.unknown()).nullable().optional(),
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
      expiresInSeconds: result.expiresInSeconds,
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

  it("cycle.sleeps inline data matches inlineSleepSchema and parses correctly", async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 3 * 24 * 60 * 60 * 1000);

    const cycles = await client.getCycles(start.toISOString(), end.toISOString(), 5);
    const cyclesWithSleeps = cycles.filter(
      (cycle) => cycle.sleeps && Array.isArray(cycle.sleeps) && cycle.sleeps.length > 0,
    );
    expect(cyclesWithSleeps.length).toBeGreaterThan(0);

    let parsedCount = 0;
    for (const cycle of cyclesWithSleeps) {
      if (!cycle.sleeps) continue;
      for (const [index, sleep] of cycle.sleeps.entries()) {
        const schemaResult = inlineSleepSchema.safeParse(sleep);
        if (!schemaResult.success) {
          console.error(
            "Inline sleep schema violation:",
            JSON.stringify(schemaResult.error.issues, null, 2),
          );
          if (sleep && typeof sleep === "object") {
            console.error("Inline sleep keys:", Object.keys(sleep));
            console.error("Inline sleep sample:", JSON.stringify(sleep, null, 2).slice(0, 500));
          }
        }
        expect(schemaResult.success, "Inline sleep matches inlineSleepSchema").toBe(true);
        if (!schemaResult.success) continue;

        // Also verify our parser produces valid output
        const parsed = parseInlineSleep(schemaResult.data, index);
        if (schemaResult.data.state === "complete") {
          expect(parsed, "parseInlineSleep returns non-null for complete sleeps").not.toBeNull();
          expect(parsed?.durationMinutes).toBeGreaterThan(0);
          parsedCount++;
        }
      }
    }
    expect(parsedCount).toBeGreaterThan(0);
  });
});
