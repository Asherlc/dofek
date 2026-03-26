/**
 * Provider API Contract Tests
 *
 * Hit real provider APIs and validate response shapes against Zod schemas.
 * These catch API drift before it breaks production sync.
 *
 * Run: source /tmp/contract-test-env.sh && pnpm vitest run src/providers/provider-api-contracts.test.ts
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ouraDailyActivitySchema,
  ouraDailyReadinessSchema,
  ouraHeartRateSchema,
  ouraSleepDocumentSchema,
  ouraWorkoutSchema,
} from "./oura.ts";

// ============================================================
// Helpers
// ============================================================

const oauthTokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
});

function envOrEmpty(key: string): string {
  return process.env[key] ?? "";
}

async function refreshOAuthToken(
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  extraBody?: Record<string, string>,
  authMethod: "body" | "basic" = "body",
): Promise<z.infer<typeof oauthTokenSchema>> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    ...(authMethod === "body" ? { client_id: clientId, client_secret: clientSecret } : {}),
    ...extraBody,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (authMethod === "basic") {
    headers.Authorization = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
  }

  const response = await fetch(tokenUrl, { method: "POST", headers, body });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${text.slice(0, 200)}`);
  }
  const data: unknown = await response.json();
  return oauthTokenSchema.parse(data);
}

async function fetchJson(url: string, accessToken: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API call failed (${response.status}): ${text.slice(0, 200)}`);
  }
  return response.json();
}

function assertSchema(schema: z.ZodSchema, data: unknown, label: string): void {
  const result = schema.safeParse(data);
  if (!result.success) {
    console.error(`${label} contract violation:`, JSON.stringify(result.error.issues, null, 2));
    if (data && typeof data === "object") {
      console.error(`${label} keys:`, Object.keys(data));
      console.error(`${label} sample:`, JSON.stringify(data, null, 2).slice(0, 500));
    }
  }
  expect(result.success, `${label} schema validation failed`).toBe(true);
}

// Paginated Oura response wrapper
const ouraPageSchema = (itemSchema: z.ZodSchema) =>
  z.object({
    data: z.array(itemSchema),
    next_token: z.string().nullable().optional(),
  });

// ============================================================
// Oura
// ============================================================

const hasOura =
  envOrEmpty("OURA_CLIENT_ID").length > 0 &&
  envOrEmpty("OURA_CLIENT_SECRET").length > 0 &&
  envOrEmpty("OURA_REFRESH_TOKEN").length > 0;

describe.skipIf(!hasOura)("Oura API contract", () => {
  let accessToken = "";

  it("can refresh access token", async () => {
    const tokens = await refreshOAuthToken(
      "https://api.ouraring.com/oauth/token",
      envOrEmpty("OURA_CLIENT_ID"),
      envOrEmpty("OURA_CLIENT_SECRET"),
      envOrEmpty("OURA_REFRESH_TOKEN"),
    );
    expect(tokens.access_token).toBeTruthy();
    accessToken = tokens.access_token;
  });

  it("sleep endpoint matches schema", async () => {
    const today = new Date().toISOString().split("T")[0];
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
    const data = await fetchJson(
      `https://api.ouraring.com/v2/usercollection/sleep?start_date=${weekAgo}&end_date=${today}`,
      accessToken,
    );
    assertSchema(ouraPageSchema(ouraSleepDocumentSchema), data, "Oura sleep");
  });

  it("daily_readiness endpoint matches schema", async () => {
    const today = new Date().toISOString().split("T")[0];
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
    const data = await fetchJson(
      `https://api.ouraring.com/v2/usercollection/daily_readiness?start_date=${weekAgo}&end_date=${today}`,
      accessToken,
    );
    assertSchema(ouraPageSchema(ouraDailyReadinessSchema), data, "Oura daily_readiness");
  });

  it("daily_activity endpoint matches schema", async () => {
    const today = new Date().toISOString().split("T")[0];
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
    const data = await fetchJson(
      `https://api.ouraring.com/v2/usercollection/daily_activity?start_date=${weekAgo}&end_date=${today}`,
      accessToken,
    );
    assertSchema(ouraPageSchema(ouraDailyActivitySchema), data, "Oura daily_activity");
  });

  it("workout endpoint matches schema", async () => {
    const today = new Date().toISOString().split("T")[0];
    const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
    const data = await fetchJson(
      `https://api.ouraring.com/v2/usercollection/workout?start_date=${monthAgo}&end_date=${today}`,
      accessToken,
    );
    assertSchema(ouraPageSchema(ouraWorkoutSchema), data, "Oura workout");
  });

  it("heart_rate endpoint matches schema", async () => {
    const now = new Date().toISOString();
    const dayAgo = new Date(Date.now() - 86400000).toISOString();
    const data = await fetchJson(
      `https://api.ouraring.com/v2/usercollection/heart_rate?start_datetime=${dayAgo}&end_datetime=${now}`,
      accessToken,
    );
    assertSchema(ouraPageSchema(ouraHeartRateSchema), data, "Oura heart_rate");
  });
});

// ============================================================
// Strava
// ============================================================

const hasStrava =
  envOrEmpty("STRAVA_CLIENT_ID").length > 0 &&
  envOrEmpty("STRAVA_CLIENT_SECRET").length > 0 &&
  envOrEmpty("STRAVA_REFRESH_TOKEN").length > 0;

const stravaActivitySchema = z.object({
  id: z.number(),
  name: z.string(),
  type: z.string(),
  sport_type: z.string(),
  start_date: z.string(),
  elapsed_time: z.number(),
  moving_time: z.number(),
  distance: z.number(),
  total_elevation_gain: z.number().optional(),
  average_speed: z.number().optional(),
  max_speed: z.number().optional(),
  average_heartrate: z.number().optional(),
  max_heartrate: z.number().optional(),
  average_watts: z.number().optional(),
  average_cadence: z.number().optional(),
  device_name: z.string().nullable().optional(),
});

describe.skipIf(!hasStrava)("Strava API contract", () => {
  let accessToken = "";

  it("can refresh access token", async () => {
    const tokens = await refreshOAuthToken(
      "https://www.strava.com/oauth/token",
      envOrEmpty("STRAVA_CLIENT_ID"),
      envOrEmpty("STRAVA_CLIENT_SECRET"),
      envOrEmpty("STRAVA_REFRESH_TOKEN"),
    );
    expect(tokens.access_token).toBeTruthy();
    accessToken = tokens.access_token;
  });

  it("athlete/activities endpoint matches schema", async () => {
    const weekAgo = Math.floor((Date.now() - 30 * 86400000) / 1000);
    const data = await fetchJson(
      `https://www.strava.com/api/v3/athlete/activities?after=${weekAgo}&per_page=5`,
      accessToken,
    );
    const activities = z.array(z.unknown()).parse(data);
    if (activities.length > 0) {
      for (const item of activities.slice(0, 3)) {
        assertSchema(stravaActivitySchema, item, "Strava activity");
      }
    }
  });
});

// ============================================================
// Wahoo
// ============================================================

const hasWahoo =
  envOrEmpty("WAHOO_CLIENT_ID").length > 0 &&
  envOrEmpty("WAHOO_CLIENT_SECRET").length > 0 &&
  envOrEmpty("WAHOO_REFRESH_TOKEN").length > 0;

const wahooWorkoutSchema = z.object({
  id: z.number(),
  name: z.string().nullable(),
  workout_token: z.string(),
  workout_type_id: z.number(),
  starts: z.string(),
  minutes: z.number(),
  workout_summary: z.object({
    heart_rate_avg: z.number().nullable().optional(),
    calories_accum: z.number().nullable().optional(),
    distance_accum: z.number().nullable().optional(),
    duration_active_accum: z.number().nullable().optional(),
    power_avg: z.number().nullable().optional(),
    speed_avg: z.number().nullable().optional(),
    cadence_avg: z.number().nullable().optional(),
    ascent_accum: z.number().nullable().optional(),
    file: z
      .object({
        url: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
  }),
});

describe.skipIf(!hasWahoo)("Wahoo API contract", () => {
  let accessToken = "";

  it("can refresh access token", async () => {
    const tokens = await refreshOAuthToken(
      "https://api.wahooligan.com/oauth/token",
      envOrEmpty("WAHOO_CLIENT_ID"),
      envOrEmpty("WAHOO_CLIENT_SECRET"),
      envOrEmpty("WAHOO_REFRESH_TOKEN"),
    );
    expect(tokens.access_token).toBeTruthy();
    accessToken = tokens.access_token;
  });

  it("workouts endpoint matches schema", async () => {
    const data = await fetchJson(
      "https://api.wahooligan.com/v1/workouts?per_page=5&page=1",
      accessToken,
    );
    const page = z
      .object({
        workouts: z.array(wahooWorkoutSchema),
        total: z.number(),
        page: z.number(),
        per_page: z.number(),
      })
      .safeParse(data);
    if (!page.success) {
      console.error("Wahoo workouts violation:", JSON.stringify(page.error.issues, null, 2));
      console.error("Wahoo sample:", JSON.stringify(data, null, 2).slice(0, 500));
    }
    expect(page.success, "Wahoo workouts schema").toBe(true);
  });
});

// ============================================================
// Withings
// ============================================================

const hasWithings =
  envOrEmpty("WITHINGS_CLIENT_ID").length > 0 &&
  envOrEmpty("WITHINGS_CLIENT_SECRET").length > 0 &&
  envOrEmpty("WITHINGS_REFRESH_TOKEN").length > 0;

const withingsMeasureSchema = z.object({
  status: z.number(),
  body: z.object({
    updatetime: z.number(),
    timezone: z.string().optional(),
    measuregrps: z.array(
      z.object({
        grpid: z.number(),
        date: z.number(),
        category: z.number(),
        measures: z.array(
          z.object({
            type: z.number(),
            value: z.number(),
            unit: z.number(),
          }),
        ),
      }),
    ),
    more: z.number().optional(),
    offset: z.number().optional(),
  }),
});

const withingsTokenSchema = z.object({
  status: z.number(),
  body: z.object({
    access_token: z.string(),
    refresh_token: z.string().optional(),
    expires_in: z.number().optional(),
  }),
});

describe.skipIf(!hasWithings)("Withings API contract", () => {
  let accessToken = "";

  it("can refresh access token", async () => {
    const body = new URLSearchParams({
      action: "requesttoken",
      grant_type: "refresh_token",
      refresh_token: envOrEmpty("WITHINGS_REFRESH_TOKEN"),
      client_id: envOrEmpty("WITHINGS_CLIENT_ID"),
      client_secret: envOrEmpty("WITHINGS_CLIENT_SECRET"),
    });

    const response = await fetch("https://wbsapi.withings.net/v2/oauth2", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(response.ok, `Withings token refresh: ${response.status}`).toBe(true);
    const data: unknown = await response.json();
    const parsed = withingsTokenSchema.parse(data);
    expect(parsed.body.access_token).toBeTruthy();
    accessToken = parsed.body.access_token;
  });

  it("measure/getmeas endpoint matches schema", async () => {
    const now = Math.floor(Date.now() / 1000);
    const monthAgo = now - 30 * 86400;
    const body = new URLSearchParams({
      action: "getmeas",
      meastype: "1,5,6,8,76,88",
      category: "1",
      startdate: String(monthAgo),
      enddate: String(now),
    });

    const response = await fetch("https://wbsapi.withings.net/measure", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    expect(response.ok).toBe(true);
    const data: unknown = await response.json();
    assertSchema(withingsMeasureSchema, data, "Withings measure");
  });
});

// ============================================================
// Polar
// ============================================================

const hasPolar =
  envOrEmpty("POLAR_CLIENT_ID").length > 0 &&
  envOrEmpty("POLAR_CLIENT_SECRET").length > 0 &&
  envOrEmpty("POLAR_REFRESH_TOKEN").length > 0;

describe.skipIf(!hasPolar)("Polar API contract", () => {
  it("can refresh access token", async () => {
    const tokens = await refreshOAuthToken(
      "https://polarremote.com/v2/oauth2/token",
      envOrEmpty("POLAR_CLIENT_ID"),
      envOrEmpty("POLAR_CLIENT_SECRET"),
      envOrEmpty("POLAR_REFRESH_TOKEN"),
      {},
      "basic",
    );
    expect(tokens.access_token).toBeTruthy();
  });
});

// ============================================================
// Peloton
// ============================================================

const hasPeloton = envOrEmpty("PELOTON_REFRESH_TOKEN").length > 0;

const pelotonWorkoutSchema = z.object({
  id: z.string(),
  status: z.string(),
  fitness_discipline: z.string(),
  name: z.string(),
  created_at: z.number(),
  start_time: z.number(),
  end_time: z.number(),
  total_work: z.number().optional(),
  is_total_work_personal_record: z.boolean().optional(),
});

const pelotonMeSchema = z.object({
  id: z.string(),
});

describe.skipIf(!hasPeloton)("Peloton API contract", () => {
  let accessToken = "";

  it("can refresh access token", async () => {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: envOrEmpty("PELOTON_REFRESH_TOKEN"),
      client_id: "WVoJxVDdPoFx4RNewvvg6ch2mZ7bwnsM",
    });

    const response = await fetch("https://auth.onepeloton.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(response.ok, `Peloton token refresh: ${response.status}`).toBe(true);
    const data: unknown = await response.json();
    const tokens = oauthTokenSchema.parse(data);
    expect(tokens.access_token).toBeTruthy();
    accessToken = tokens.access_token;
  });

  it("me endpoint returns user data", async () => {
    const data = await fetchJson("https://api.onepeloton.com/api/me", accessToken);
    assertSchema(pelotonMeSchema, data, "Peloton me");
  });

  it("workouts endpoint matches schema", async () => {
    const meData = pelotonMeSchema.parse(
      await fetchJson("https://api.onepeloton.com/api/me", accessToken),
    );

    const data = await fetchJson(
      `https://api.onepeloton.com/api/user/${meData.id}/workouts?limit=5&sort_by=-created&joins=ride`,
      accessToken,
    );
    const workoutsPage = z
      .object({
        data: z.array(pelotonWorkoutSchema),
      })
      .safeParse(data);
    if (!workoutsPage.success) {
      console.error(
        "Peloton workouts violation:",
        JSON.stringify(workoutsPage.error.issues, null, 2),
      );
    }
    expect(workoutsPage.success, "Peloton workouts schema").toBe(true);
  });
});
