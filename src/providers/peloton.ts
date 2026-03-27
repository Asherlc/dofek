import type { CanonicalActivityType } from "@dofek/training/training";
import { and as sqlAnd, eq as sqlEq } from "drizzle-orm";
import { z } from "zod";
import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generateCodeChallenge,
  generateCodeVerifier,
} from "../auth/oauth.ts";
import { resolveOAuthTokens } from "../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../db/index.ts";
import { activity, metricStream } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider } from "../db/tokens.ts";
import { logger } from "../logger.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "./types.ts";

// ============================================================
// Peloton API types
// ============================================================

export interface PelotonInstructor {
  id: string;
  name: string;
  image_url?: string;
}

export interface PelotonRide {
  id: string;
  title: string;
  description?: string;
  duration: number; // seconds
  difficulty_rating_avg?: number;
  overall_rating_avg?: number;
  instructor?: PelotonInstructor;
}

export interface PelotonWorkout {
  id: string;
  status: string;
  fitness_discipline: string;
  name?: string;
  title?: string;
  created_at: number; // unix epoch seconds
  start_time: number; // unix epoch seconds
  end_time: number; // unix epoch seconds (0 if not finished)
  total_work: number; // joules
  is_total_work_personal_record: boolean;
  metrics_type?: string;
  device_type?: string; // e.g. "home_bike_v1", "iOS", "android"
  platform?: string; // e.g. "home_bike", "iOS_app", "android_app"
  peloton_id?: string; // scheduled class instance ID
  workout_type?: string; // e.g. "class", "freestyle"
  has_pedaling_metrics?: boolean;
  has_leaderboard_metrics?: boolean;
  timezone?: string; // e.g. "America/New_York"
  strava_id?: string; // Strava activity ID (e.g. "3456789012")
  ride?: PelotonRide;
  total_leaderboard_users?: number;
  leaderboard_rank?: number;
  average_effort_score?: number | null;
}

interface PelotonWorkoutListResponse {
  data: PelotonWorkout[];
  total: number;
  count: number;
  page: number;
  limit: number;
  page_count: number;
  sort_by: string;
  show_next: boolean;
  show_previous: boolean;
}

export interface PelotonMetric {
  display_name: string;
  slug: string;
  values: number[];
  average_value: number;
  max_value: number;
}

export interface PelotonPerformanceGraph {
  duration: number;
  is_class_plan_shown: boolean;
  segment_list: unknown[];
  average_summaries: { display_name: string; value: string; slug: string }[];
  summaries: { display_name: string; value: string; slug: string }[];
  metrics: PelotonMetric[];
}

// ============================================================
// Activity type mapping
// ============================================================

const DISCIPLINE_MAP: Record<string, CanonicalActivityType> = {
  cycling: "indoor_cycling",
  running: "running",
  walking: "walking",
  rowing: "rowing",
  caesar: "rowing", // Peloton's internal name for rowing
  strength: "strength",
  yoga: "yoga",
  meditation: "meditation",
  stretching: "stretching",
  cardio: "cardio",
  bike_bootcamp: "bootcamp",
  tread_bootcamp: "bootcamp",
  outdoor: "running",
};

export function mapFitnessDiscipline(discipline: string): CanonicalActivityType {
  return DISCIPLINE_MAP[discipline] ?? "other";
}

// ============================================================
// Parsing (pure functions, easy to test)
// ============================================================

export interface ParsedPelotonWorkout {
  externalId: string;
  activityType: CanonicalActivityType;
  name?: string;
  timezone?: string;
  stravaId?: string;
  startedAt: Date;
  endedAt?: Date;
  raw: Record<string, unknown>;
}

export function parseWorkout(workout: PelotonWorkout): ParsedPelotonWorkout {
  const startedAt = new Date(workout.start_time * 1000);
  const endedAt = workout.end_time > 0 ? new Date(workout.end_time * 1000) : undefined;

  const raw: Record<string, unknown> = {
    instructor: workout.ride?.instructor?.name,
    classTitle: workout.ride?.title,
    difficultyRating: workout.ride?.difficulty_rating_avg,
    overallRating: workout.ride?.overall_rating_avg,
    rideDescription: workout.ride?.description,
    leaderboardRank: workout.leaderboard_rank,
    totalLeaderboardUsers: workout.total_leaderboard_users,
    totalWorkJoules: workout.total_work || undefined,
    isPersonalRecord: workout.is_total_work_personal_record || undefined,
    fitnessDiscipline: workout.fitness_discipline,
    pelotonRideId: workout.ride?.id,
    deviceType: workout.device_type || undefined,
    platform: workout.platform || undefined,
    pelotonClassId: workout.peloton_id || undefined,
    workoutType: workout.workout_type || undefined,
    hasPedalingMetrics: workout.has_pedaling_metrics,
    timezone: workout.timezone || undefined,
  };

  // strava_id "-1" means "not linked to Strava"
  const stravaId = workout.strava_id && workout.strava_id !== "-1" ? workout.strava_id : undefined;

  return {
    externalId: workout.id,
    activityType: mapFitnessDiscipline(workout.fitness_discipline),
    name: workout.ride?.title,
    timezone: workout.timezone || undefined,
    stravaId,
    startedAt,
    endedAt,
    raw,
  };
}

export interface ParsedMetricSeries {
  slug: string;
  displayName: string;
  values: number[];
  offsetsSeconds: number[];
  averageValue: number;
  maxValue: number;
}

export function parsePerformanceGraph(
  graph: PelotonPerformanceGraph,
  everyN: number,
): ParsedMetricSeries[] {
  return graph.metrics.map((metric) => ({
    slug: metric.slug,
    displayName: metric.display_name,
    values: metric.values,
    offsetsSeconds: metric.values.map((_, i) => i * everyN),
    averageValue: metric.average_value,
    maxValue: metric.max_value,
  }));
}

// Aggregate enrichment removed — all metrics live in metric_stream rows.
// enrichWorkoutFromGraph() was here but violated the "no duplicate sources of truth" principle.

// ============================================================
// Peloton API client
// ============================================================

const PELOTON_API_BASE = "https://api.onepeloton.com";

export class PelotonClient {
  #accessToken: string;
  #userId: string | null = null;
  #fetchFn: typeof globalThis.fetch;

  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#accessToken = accessToken;
    this.#fetchFn = fetchFn;
  }

  async #get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, PELOTON_API_BASE);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await this.#fetchFn(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.#accessToken}`,
        "peloton-platform": "web",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Peloton API error (${response.status}): ${text}`);
    }

    return response.json();
  }

  async getUserId(): Promise<string> {
    if (this.#userId) return this.#userId;
    const me = await this.#get<{ id: string }>("/api/me");
    this.#userId = me.id;
    return me.id;
  }

  async getWorkouts(page = 0, limit = 20): Promise<PelotonWorkoutListResponse> {
    const userId = await this.getUserId();
    return this.#get<PelotonWorkoutListResponse>(`/api/user/${userId}/workouts`, {
      page: String(page),
      limit: String(limit),
      sort_by: "-created_at",
      joins: "ride",
    });
  }

  async getPerformanceGraph(workoutId: string, everyN = 5): Promise<PelotonPerformanceGraph> {
    return this.#get<PelotonPerformanceGraph>(`/api/workout/${workoutId}/performance_graph`, {
      every_n: String(everyN),
    });
  }
}

// ============================================================
// Provider implementation
// ============================================================

const PELOTON_AUTH_DOMAIN = "https://auth.onepeloton.com";
const PELOTON_CLIENT_ID = "WVoJxVDdPoFx4RNewvvg6ch2mZ7bwnsM";
const PELOTON_REDIRECT_URI = "https://members.onepeloton.com/callback";
const AUTH0_CLIENT = btoa(JSON.stringify({ name: "auth0.js-ulp", version: "9.14.3" }));

export function pelotonOAuthConfig(): OAuthConfig {
  return {
    clientId: PELOTON_CLIENT_ID,
    authorizeUrl: `${PELOTON_AUTH_DOMAIN}/authorize`,
    tokenUrl: `${PELOTON_AUTH_DOMAIN}/oauth/token`,
    redirectUri: PELOTON_REDIRECT_URI,
    scopes: ["offline_access", "openid", "peloton-api.members:default"],
    usePkce: true,
    audience: `${PELOTON_API_BASE}/`,
  };
}

// ============================================================
// Auth0 automated login flow
// ============================================================

/**
 * Extract hidden input fields from an Auth0 HTML form response.
 * Auth0 returns HTML with a form containing hidden inputs after successful login.
 */
export function parseAuth0FormHtml(html: string): {
  action: string;
  fields: Record<string, string>;
} {
  const actionMatch = html.match(/<form[^>]+action="([^"]+)"/);
  if (!actionMatch) {
    throw new Error("Could not find form action in Auth0 response");
  }

  const fields: Record<string, string> = {};
  const inputRegex = /<input[^>]+type="hidden"[^>]*>/gi;
  for (const match of html.matchAll(inputRegex)) {
    const tag = match[0];
    const nameMatch = tag.match(/name="([^"]+)"/);
    const valueMatch = tag.match(/value="([^"]*)"/);
    const nameVal = nameMatch?.[1];
    if (nameVal) {
      fields[nameVal] = valueMatch?.[1] ?? "";
    }
  }

  const action = actionMatch[1];
  if (!action) {
    throw new Error("Could not parse form action from Auth0 response");
  }
  return { action, fields };
}

function getSetCookieHeaders(headers: Headers): string[] {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const combined = headers.get("set-cookie");
  return combined ? combined.split(", ") : [];
}

/**
 * Simple cookie jar that tracks cookies per domain.
 */
class CookieJar {
  #cookies = new Map<string, Map<string, string>>();

  addFromResponse(url: string, headers: Headers): void {
    const domain = new URL(url).hostname;
    const existing = this.#cookies.get(domain) ?? new Map();
    for (const header of getSetCookieHeaders(headers)) {
      const match = header.match(/^([^=]+)=([^;]*)/);
      if (match) existing.set(match[1], match[2]);
    }
    this.#cookies.set(domain, existing);
  }

  getForUrl(url: string): string {
    const hostname = new URL(url).hostname;
    const parts: string[] = [];
    // Include cookies from matching domains (exact + parent domain)
    for (const [domain, cookies] of this.#cookies) {
      if (hostname === domain || hostname.endsWith(`.${domain}`)) {
        for (const [name, value] of cookies) {
          parts.push(`${name}=${value}`);
        }
      }
    }
    return parts.join("; ");
  }
}

/**
 * Drive Auth0's Universal Login Page programmatically to obtain tokens.
 * Simulates what a browser does: POST credentials, parse HTML form, follow redirects.
 */
/**
 * Helper to follow redirects manually, tracking cookies per-domain.
 * Returns the final response and the last redirect Location (if any).
 */
async function followRedirects(
  url: string,
  jar: CookieJar,
  fetchFn: typeof globalThis.fetch,
  init?: RequestInit,
): Promise<{ response: Response; location: string | null }> {
  const fullUrl = url.startsWith("http") ? url : `${PELOTON_AUTH_DOMAIN}${url}`;
  const resp = await fetchFn(fullUrl, {
    ...init,
    redirect: "manual",
    headers: { ...(init?.headers ?? {}), Cookie: jar.getForUrl(fullUrl) },
  });
  jar.addFromResponse(fullUrl, resp.headers);
  return { response: resp, location: resp.headers.get("location") };
}

export async function pelotonAutomatedLogin(
  email: string,
  password: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<TokenSet> {
  const config = pelotonOAuthConfig();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateCodeVerifier();
  const nonce = generateCodeVerifier();
  const jar = new CookieJar();

  // Step 1: GET /authorize → follow redirects to reach the login page
  const authorizeUrl = new URL(`${PELOTON_AUTH_DOMAIN}/authorize`);
  authorizeUrl.searchParams.set("client_id", PELOTON_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", PELOTON_REDIRECT_URI);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", config.scopes.join(" "));
  authorizeUrl.searchParams.set("audience", `${PELOTON_API_BASE}/`);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("nonce", nonce);

  logger.info("[peloton] Initiating Auth0 login flow...");
  let { response, location } = await followRedirects(authorizeUrl.toString(), jar, fetchFn);

  while (location) {
    ({ response, location } = await followRedirects(location, jar, fetchFn));
  }

  // Parse injectedConfig from login page (contains state, csrf, nonce)
  const loginPageHtml = await response.text();
  const configMatch = loginPageHtml.match(/window\.injectedConfig\s*=\s*[^"]*"([^"]+)"/);
  if (!configMatch) {
    throw new Error("Could not find injectedConfig in Auth0 login page");
  }

  const configBase64 = configMatch[1];
  if (!configBase64) {
    throw new Error("Could not extract injectedConfig value from Auth0 login page");
  }
  const auth0InjectedConfigSchema = z.object({
    extraParams: z.object({
      state: z.string().min(1),
      _csrf: z.string().min(1),
      nonce: z.string().optional(),
    }),
  });
  const injectedConfig = auth0InjectedConfigSchema.parse(
    JSON.parse(Buffer.from(configBase64, "base64").toString("utf-8")),
  );
  const extraParams = injectedConfig.extraParams;

  // Step 2: POST credentials to Auth0 login endpoint
  logger.info("[peloton] Submitting credentials...");
  const loginUrl = `${PELOTON_AUTH_DOMAIN}/usernamepassword/login`;
  const { response: loginResp } = await followRedirects(loginUrl, jar, fetchFn, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Auth0-Client": AUTH0_CLIENT,
    },
    body: JSON.stringify({
      client_id: PELOTON_CLIENT_ID,
      redirect_uri: PELOTON_REDIRECT_URI,
      tenant: "peloton-prod",
      response_type: "code",
      scope: config.scopes.join(" "),
      audience: `${PELOTON_API_BASE}/`,
      _csrf: extraParams._csrf,
      state: extraParams.state,
      nonce: extraParams.nonce ?? nonce,
      connection: "pelo-user-password",
      username: email,
      password,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }),
  });

  if (!loginResp.ok) {
    const errorText = await loginResp.text();
    throw new Error(`Auth0 login failed (${loginResp.status}): ${errorText}`);
  }

  // Step 3: Parse the hidden form from HTML response
  const loginHtml = await loginResp.text();
  const { action: formAction, fields } = parseAuth0FormHtml(loginHtml);
  // HTML-decode field values (Auth0 encodes entities like &#34; in the JWT)
  for (const [key, val] of Object.entries(fields)) {
    fields[key] = val
      .replace(/&#34;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }

  // Step 4: Submit form, then follow redirects until we find ?code= in a Location header
  logger.info("[peloton] Following Auth0 redirect chain...");
  let { location: redirectUrl } = await followRedirects(formAction, jar, fetchFn, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

  let maxRedirects = 15;
  while (redirectUrl && maxRedirects > 0) {
    // Stop before fetching the callback URL — just read the code from it
    if (redirectUrl.includes("code=") || redirectUrl.includes("error=")) break;
    ({ location: redirectUrl } = await followRedirects(redirectUrl, jar, fetchFn));
    maxRedirects--;
  }

  if (!redirectUrl) {
    throw new Error("Auth0 redirect chain ended without a Location header");
  }

  if (redirectUrl.includes("error=")) {
    const errorParams = new URL(redirectUrl).searchParams;
    throw new Error(
      `Auth0 returned error: ${errorParams.get("error_description") ?? errorParams.get("error")}`,
    );
  }

  const authCode = new URL(redirectUrl).searchParams.get("code");
  if (!authCode) {
    throw new Error("Authorization code not found in callback URL");
  }

  // Step 5: Exchange code for tokens
  logger.info("[peloton] Exchanging authorization code for tokens...");
  return exchangeCodeForTokens(config, authCode, fetchFn, { codeVerifier });
}

export class PelotonProvider implements SyncProvider {
  readonly id = "peloton";
  readonly name = "Peloton";
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.PELOTON_USERNAME || !process.env.PELOTON_PASSWORD) {
      return "PELOTON_USERNAME and PELOTON_PASSWORD are required for Peloton auth";
    }
    return null;
  }

  activityUrl(externalId: string): string {
    return `https://members.onepeloton.com/classes/cycling?modal=classDetailsModal&classId=${externalId}`;
  }

  authSetup(): ProviderAuthSetup {
    const config = pelotonOAuthConfig();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const fetchFn = this.#fetchFn;

    return {
      oauthConfig: config,
      authUrl: buildAuthorizationUrl(config, { codeChallenge }),
      exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn, { codeVerifier }),
      automatedLogin: (email, password) => pelotonAutomatedLogin(email, password, fetchFn),
      apiBaseUrl: PELOTON_API_BASE,
    };
  }

  async #resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    return resolveOAuthTokens({
      db,
      providerId: this.id,
      providerName: this.name,
      getOAuthConfig: () => pelotonOAuthConfig(),
      fetchFn: this.#fetchFn,
    });
  }

  async sync(
    db: SyncDatabase,
    since: Date,
    options?: import("./types.ts").SyncOptions,
  ): Promise<SyncResult> {
    const { onProgress, userId } = options ?? {};
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    let tokens: TokenSet;
    try {
      tokens = await this.#resolveTokens(db);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const client = new PelotonClient(tokens.accessToken, this.#fetchFn);
    await ensureProvider(db, this.id, this.name, PELOTON_API_BASE);

    // Single-pass: fetch workouts, then for each fetch performance graph,
    // enrich the activity with summary stats, and insert both activity + streams.
    const syncResult = await withSyncLog(
      db,
      this.id,
      "workouts",
      async () => {
        let workoutCount = 0;
        let streamCount = 0;
        let page = 0;
        let hasMore = true;

        while (hasMore) {
          const response = await client.getWorkouts(page);
          const totalWorkouts = response.total;

          for (const workout of response.data) {
            if (workout.status !== "COMPLETE") continue;

            const startedAt = new Date(workout.start_time * 1000);
            if (startedAt < since) {
              hasMore = false;
              break;
            }

            const parsed = parseWorkout(workout);

            // Upsert the activity first so we have an ID for metric_stream
            let activityId: string | null = null;
            try {
              const [row] = await db
                .insert(activity)
                .values({
                  providerId: this.id,
                  externalId: parsed.externalId,
                  activityType: parsed.activityType,
                  startedAt: parsed.startedAt,
                  endedAt: parsed.endedAt,
                  name: parsed.name,
                  timezone: parsed.timezone,
                  stravaId: parsed.stravaId,
                  raw: parsed.raw,
                })
                .onConflictDoUpdate({
                  target: [activity.providerId, activity.externalId],
                  set: {
                    activityType: parsed.activityType,
                    startedAt: parsed.startedAt,
                    endedAt: parsed.endedAt,
                    name: parsed.name,
                    timezone: parsed.timezone,
                    stravaId: parsed.stravaId,
                    raw: parsed.raw,
                  },
                })
                .returning({ id: activity.id });

              activityId = row?.id ?? null;
              workoutCount++;
              // no-mutate: Progress reporting is UX-only and can't fail in a testable way
              if (onProgress && totalWorkouts > 0) {
                // no-mutate
                onProgress(
                  Math.round((workoutCount / totalWorkouts) * 100),
                  `${workoutCount}/${totalWorkouts} workouts`,
                );
              }
            } catch (err) {
              errors.push({
                message: err instanceof Error ? err.message : String(err),
                externalId: parsed.externalId,
                cause: err,
              });
            }

            // Fetch performance graph for time-series + summary enrichment
            try {
              const everyN = 5;
              const graph = await client.getPerformanceGraph(workout.id, everyN);
              const series = parsePerformanceGraph(graph, everyN);

              // Insert time-series metric_stream rows linked to the activity
              const hrSeries = series.find((s) => s.slug === "heart_rate");
              // Discard pedaling metrics (power, cadence) when has_pedaling_metrics is false —
              // the user may still have HR data from a chest strap or watch
              const hasPedaling = workout.has_pedaling_metrics !== false;
              const powerSeries = hasPedaling ? series.find((s) => s.slug === "output") : undefined;
              const cadenceSeries = hasPedaling
                ? series.find((s) => s.slug === "cadence")
                : undefined;
              const sampleCount =
                hrSeries?.values.length ??
                powerSeries?.values.length ??
                cadenceSeries?.values.length ??
                0;

              if (sampleCount > 0 && activityId) {
                // Delete existing metric_stream rows for this activity to avoid duplicates
                await db
                  .delete(metricStream)
                  .where(
                    sqlAnd(
                      sqlEq(metricStream.activityId, activityId),
                      sqlEq(metricStream.providerId, this.id),
                    ),
                  );

                const rows = [];
                for (let i = 0; i < sampleCount; i++) {
                  const recordedAt = new Date(startedAt.getTime() + i * everyN * 1000);
                  rows.push({
                    providerId: this.id,
                    activityId,
                    recordedAt,
                    heartRate: hrSeries?.values[i] ?? null,
                    power: powerSeries?.values[i] ?? null,
                    cadence: cadenceSeries?.values[i] ?? null,
                    // Indoor rides have no meaningful speed — omit it
                  });
                }

                for (let j = 0; j < rows.length; j += 500) {
                  const chunk = rows.slice(j, j + 500);
                  await db.insert(metricStream).values(chunk);
                }

                streamCount += rows.length;
              }
            } catch (err) {
              // Performance graph failure is non-fatal — still save the workout
              errors.push({
                message: `Performance graph for ${workout.id}: ${err instanceof Error ? err.message : String(err)}`,
                externalId: workout.id,
                cause: err,
              });
            }
          }

          hasMore = hasMore && response.show_next;
          page++;
        }

        logger.info(`[peloton] ${workoutCount} workouts, ${streamCount} metric stream rows`);
        return { recordCount: workoutCount + streamCount, result: workoutCount + streamCount };
      },
      userId,
    );

    recordsSynced += syncResult;

    return {
      provider: this.id,
      recordsSynced,
      errors,
      duration: Date.now() - start,
    };
  }
}
