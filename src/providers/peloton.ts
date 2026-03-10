import type { Provider, SyncResult, SyncError } from "./types.js";
import type { Database } from "../db/index.js";
import { cardioActivity, metricStream } from "../db/schema.js";
import { withSyncLog } from "../db/sync-log.js";
import { ensureProvider } from "../db/tokens.js";

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

interface PelotonAuthResponse {
  session_id: string;
  user_id: string;
}

// ============================================================
// Activity type mapping
// ============================================================

const DISCIPLINE_MAP: Record<string, string> = {
  cycling: "cycling",
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

export function mapFitnessDiscipline(discipline: string): string {
  return DISCIPLINE_MAP[discipline] ?? "other";
}

// ============================================================
// Parsing (pure functions, easy to test)
// ============================================================

export interface ParsedPelotonWorkout {
  externalId: string;
  activityType: string;
  startedAt: Date;
  endedAt?: Date;
  durationSeconds?: number;
  calories?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  avgPower?: number;
  maxPower?: number;
  avgSpeed?: number;
  maxSpeed?: number;
  avgCadence?: number;
  raw: Record<string, unknown>;
}

export function parseWorkout(workout: PelotonWorkout): ParsedPelotonWorkout {
  const startedAt = new Date(workout.start_time * 1000);
  const endedAt = workout.end_time > 0 ? new Date(workout.end_time * 1000) : undefined;

  const durationSeconds = endedAt
    ? Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)
    : workout.ride?.duration;

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
  };

  return {
    externalId: workout.id,
    activityType: mapFitnessDiscipline(workout.fitness_discipline),
    startedAt,
    endedAt,
    durationSeconds,
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

// ============================================================
// Peloton API client
// ============================================================

const PELOTON_API_BASE = "https://api.onepeloton.com";

export class PelotonClient {
  private sessionId: string;
  private userId: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(sessionId: string, userId: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.sessionId = sessionId;
    this.userId = userId;
    this.fetchFn = fetchFn;
  }

  static async login(
    usernameOrEmail: string,
    password: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<PelotonClient> {
    const response = await fetchFn(`${PELOTON_API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username_or_email: usernameOrEmail, password }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Peloton login failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as PelotonAuthResponse;
    return new PelotonClient(data.session_id, data.user_id, fetchFn);
  }

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, PELOTON_API_BASE);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await this.fetchFn(url.toString(), {
      headers: {
        Cookie: `peloton_session_id=${this.sessionId}`,
        "peloton-platform": "web",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Peloton API error (${response.status}): ${text}`);
    }

    return response.json() as Promise<T>;
  }

  async getWorkouts(page = 0, limit = 20): Promise<PelotonWorkoutListResponse> {
    return this.get<PelotonWorkoutListResponse>(
      `/api/user/${this.userId}/workouts`,
      {
        page: String(page),
        limit: String(limit),
        sort_by: "-created_at",
        joins: "ride",
      },
    );
  }

  async getPerformanceGraph(workoutId: string, everyN = 5): Promise<PelotonPerformanceGraph> {
    return this.get<PelotonPerformanceGraph>(
      `/api/workout/${workoutId}/performance_graph`,
      { every_n: String(everyN) },
    );
  }
}

// ============================================================
// Provider implementation
// ============================================================

export class PelotonProvider implements Provider {
  readonly id = "peloton";
  readonly name = "Peloton";
  private fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.PELOTON_USERNAME) return "PELOTON_USERNAME is not set";
    if (!process.env.PELOTON_PASSWORD) return "PELOTON_PASSWORD is not set";
    return null;
  }

  async sync(db: Database, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    const username = process.env.PELOTON_USERNAME!;
    const password = process.env.PELOTON_PASSWORD!;

    let client: PelotonClient;
    try {
      client = await PelotonClient.login(username, password, this.fetchFn);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    await ensureProvider(db, this.id, this.name, PELOTON_API_BASE);

    // Sync workouts
    const workoutCount = await withSyncLog(db, this.id, "workouts", async () => {
      let count = 0;
      let page = 0;
      let hasMore = true;

      while (hasMore) {
        const response = await client.getWorkouts(page);

        for (const workout of response.data) {
          if (workout.status !== "COMPLETE") continue;

          const startedAt = new Date(workout.start_time * 1000);
          if (startedAt < since) {
            hasMore = false;
            break;
          }

          const parsed = parseWorkout(workout);

          try {
            await db
              .insert(cardioActivity)
              .values({
                providerId: this.id,
                externalId: parsed.externalId,
                activityType: parsed.activityType,
                startedAt: parsed.startedAt,
                endedAt: parsed.endedAt,
                durationSeconds: parsed.durationSeconds,
                calories: parsed.calories,
                avgHeartRate: parsed.avgHeartRate,
                maxHeartRate: parsed.maxHeartRate,
                avgPower: parsed.avgPower,
                maxPower: parsed.maxPower,
                avgSpeed: parsed.avgSpeed,
                maxSpeed: parsed.maxSpeed,
                avgCadence: parsed.avgCadence,
                raw: parsed.raw,
              })
              .onConflictDoUpdate({
                target: [cardioActivity.providerId, cardioActivity.externalId],
                set: {
                  activityType: parsed.activityType,
                  startedAt: parsed.startedAt,
                  endedAt: parsed.endedAt,
                  durationSeconds: parsed.durationSeconds,
                  calories: parsed.calories,
                  avgHeartRate: parsed.avgHeartRate,
                  maxHeartRate: parsed.maxHeartRate,
                  avgPower: parsed.avgPower,
                  maxPower: parsed.maxPower,
                  avgSpeed: parsed.avgSpeed,
                  maxSpeed: parsed.maxSpeed,
                  avgCadence: parsed.avgCadence,
                  raw: parsed.raw,
                },
              });

            count++;
          } catch (err) {
            errors.push({
              message: err instanceof Error ? err.message : String(err),
              externalId: parsed.externalId,
              cause: err,
            });
          }
        }

        hasMore = hasMore && response.show_next;
        page++;
      }

      return { recordCount: count, result: count };
    });

    recordsSynced += workoutCount;

    // Sync performance graphs (time-series metrics)
    const streamCount = await withSyncLog(db, this.id, "metric_streams", async () => {
      let count = 0;
      let page = 0;
      let hasMore = true;

      while (hasMore) {
        const response = await client.getWorkouts(page);

        for (const workout of response.data) {
          if (workout.status !== "COMPLETE") continue;

          const startedAt = new Date(workout.start_time * 1000);
          if (startedAt < since) {
            hasMore = false;
            break;
          }

          try {
            const everyN = 5;
            const graph = await client.getPerformanceGraph(workout.id, everyN);
            const series = parsePerformanceGraph(graph, everyN);

            const hrSeries = series.find((s) => s.slug === "heart_rate");
            const powerSeries = series.find((s) => s.slug === "output");
            const cadenceSeries = series.find((s) => s.slug === "cadence");
            const speedSeries = series.find((s) => s.slug === "speed");

            const sampleCount = hrSeries?.values.length
              ?? powerSeries?.values.length
              ?? cadenceSeries?.values.length
              ?? 0;

            if (sampleCount === 0) continue;

            const rows = [];
            for (let i = 0; i < sampleCount; i++) {
              const recordedAt = new Date(startedAt.getTime() + i * everyN * 1000);
              rows.push({
                providerId: this.id,
                recordedAt,
                heartRate: hrSeries?.values[i] ?? null,
                power: powerSeries?.values[i] ?? null,
                cadence: cadenceSeries?.values[i] ?? null,
                speed: speedSeries?.values[i] ?? null,
              });
            }

            // Batch insert in chunks of 500
            for (let j = 0; j < rows.length; j += 500) {
              const chunk = rows.slice(j, j + 500);
              await db.insert(metricStream).values(chunk).onConflictDoNothing();
            }

            count += rows.length;
          } catch (err) {
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

      return { recordCount: count, result: count };
    });

    recordsSynced += streamCount;

    return {
      provider: this.id,
      recordsSynced,
      errors,
      duration: Date.now() - start,
    };
  }
}
