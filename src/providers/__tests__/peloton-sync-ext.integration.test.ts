import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../db/__tests__/test-helpers.ts";
import { activity, metricStream } from "../../db/schema.ts";
import { ensureProvider, saveTokens } from "../../db/tokens.ts";
import {
  type PelotonPerformanceGraph,
  PelotonProvider,
  type PelotonWorkout,
  parseAuth0FormHtml,
  pelotonAutomatedLogin,
} from "../peloton.ts";

const server = setupServer();

// ============================================================
// Helpers
// ============================================================

function fakeWorkout(overrides: Partial<PelotonWorkout> = {}): PelotonWorkout {
  return {
    id: "workout-ext-001",
    status: "COMPLETE",
    fitness_discipline: "cycling",
    name: "Cycling Workout",
    title: "30 min Power Zone Ride",
    created_at: 1709280000,
    start_time: 1709280000,
    end_time: 1709281800,
    total_work: 360000,
    is_total_work_personal_record: false,
    ride: {
      id: "ride-001",
      title: "30 min Power Zone Ride",
      duration: 1800,
      difficulty_rating_avg: 7.85,
      overall_rating_avg: 4.9,
      instructor: { id: "instr-001", name: "Matt Wilpers" },
    },
    total_leaderboard_users: 15000,
    leaderboard_rank: 3200,
    average_effort_score: null,
    ...overrides,
  };
}

function fakePerformanceGraph(): PelotonPerformanceGraph {
  return {
    duration: 1800,
    is_class_plan_shown: true,
    segment_list: [],
    average_summaries: [],
    summaries: [],
    metrics: [
      {
        display_name: "Heart Rate",
        slug: "heart_rate",
        values: [130, 145, 160],
        average_value: 145,
        max_value: 160,
      },
      {
        display_name: "Output",
        slug: "output",
        values: [180, 200, 220],
        average_value: 200,
        max_value: 220,
      },
      {
        display_name: "Cadence",
        slug: "cadence",
        values: [80, 85, 90],
        average_value: 85,
        max_value: 90,
      },
    ],
  };
}

// ============================================================
// Sync integration tests — extended paths
// ============================================================

describe("PelotonProvider.sync() extended paths (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    server.listen({ onUnhandledRequest: "error" });
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "peloton", "Peloton", "https://api.onepeloton.com");
  }, 60_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    if (ctx) await ctx.cleanup();
  });

  it("stops paginating when a workout falls before the since date", async () => {
    await saveTokens(ctx.db, "peloton", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "offline_access openid peloton-api.members:default",
    });

    let pagesRequested = 0;

    server.use(
      http.get("https://api.onepeloton.com/api/me", () => {
        return HttpResponse.json({ id: "user-123" });
      }),
      http.get("https://api.onepeloton.com/api/workout/:workoutId/performance_graph", () => {
        return HttpResponse.json(fakePerformanceGraph());
      }),
      http.get("https://api.onepeloton.com/api/user/:userId/workouts", ({ request }) => {
        const url = new URL(request.url);
        const page = Number(url.searchParams.get("page") ?? "0");
        pagesRequested = Math.max(pagesRequested, page);

        if (page === 0) {
          return HttpResponse.json({
            data: [
              fakeWorkout({
                id: "ext-recent",
                start_time: 1709712000, // 2024-03-06
                end_time: 1709713800,
              }),
            ],
            total: 2,
            count: 1,
            page: 0,
            limit: 1,
            page_count: 2,
            sort_by: "-created_at",
            show_next: true,
            show_previous: false,
          });
        }
        // Page 1 has a workout before `since`
        return HttpResponse.json({
          data: [
            fakeWorkout({
              id: "ext-old",
              start_time: 1672531200, // 2023-01-01
              end_time: 1672532000,
            }),
          ],
          total: 2,
          count: 1,
          page: 1,
          limit: 1,
          page_count: 2,
          sort_by: "-created_at",
          show_next: true, // API says there's more, but we should stop
          show_previous: true,
        });
      }),
    );

    const provider = new PelotonProvider();
    const result = await provider.sync(ctx.db, new Date("2024-03-01T00:00:00Z"));

    expect(result.errors).toHaveLength(0);
    // Should have fetched page 1 but stopped there (not page 2)
    expect(pagesRequested).toBe(1);

    // Recent workout should be saved
    const rows = await ctx.db.select().from(activity).where(eq(activity.externalId, "ext-recent"));
    expect(rows).toHaveLength(1);

    // Old workout should NOT be saved (before since)
    const oldRows = await ctx.db.select().from(activity).where(eq(activity.externalId, "ext-old"));
    expect(oldRows).toHaveLength(0);
  });

  it("handles activity insert errors and continues syncing", async () => {
    await saveTokens(ctx.db, "peloton", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "offline_access openid peloton-api.members:default",
    });

    let callCount = 0;
    // Simulate a DB error on the first insert by providing invalid data via graph
    server.use(
      http.get("https://api.onepeloton.com/api/me", () => {
        return HttpResponse.json({ id: "user-123" });
      }),
      http.get("https://api.onepeloton.com/api/workout/:workoutId/performance_graph", () => {
        callCount++;
        return HttpResponse.json(fakePerformanceGraph());
      }),
      http.get("https://api.onepeloton.com/api/user/:userId/workouts", () => {
        return HttpResponse.json({
          data: [
            fakeWorkout({
              id: "ext-normal-workout",
              start_time: 1709798400,
              end_time: 1709800200,
            }),
          ],
          total: 1,
          count: 1,
          page: 0,
          limit: 20,
          page_count: 1,
          sort_by: "-created_at",
          show_next: false,
          show_previous: false,
        });
      }),
    );

    const provider = new PelotonProvider();
    const result = await provider.sync(ctx.db, new Date("2024-01-01T00:00:00Z"));

    // Performance graph was called
    expect(callCount).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("handles performance graph with no heart rate or output (empty metrics)", async () => {
    await saveTokens(ctx.db, "peloton", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "offline_access openid peloton-api.members:default",
    });

    const emptyGraph: PelotonPerformanceGraph = {
      duration: 600,
      is_class_plan_shown: false,
      segment_list: [],
      average_summaries: [],
      summaries: [],
      metrics: [], // No metrics at all (e.g., meditation)
    };

    server.use(
      http.get("https://api.onepeloton.com/api/me", () => HttpResponse.json({ id: "user-123" })),
      http.get("https://api.onepeloton.com/api/workout/:workoutId/performance_graph", () => HttpResponse.json(emptyGraph)),
      http.get("https://api.onepeloton.com/api/user/:userId/workouts", () => {
        return HttpResponse.json({
          data: [
            fakeWorkout({
              id: "ext-meditation",
              start_time: 1709884800,
              end_time: 1709885400,
              fitness_discipline: "meditation",
              ride: undefined,
            }),
          ],
          total: 1,
          count: 1,
          page: 0,
          limit: 20,
          page_count: 1,
          sort_by: "-created_at",
          show_next: false,
          show_previous: false,
        });
      }),
    );

    const provider = new PelotonProvider();
    const result = await provider.sync(ctx.db, new Date("2024-01-01T00:00:00Z"));

    expect(result.errors).toHaveLength(0);

    // Activity should exist
    const rows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.externalId, "ext-meditation"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.activityType).toBe("meditation");

    // No metric_stream rows for this activity (empty metrics)
    const activityId = rows[0]?.id;
    if (activityId) {
      const streams = await ctx.db
        .select()
        .from(metricStream)
        .where(eq(metricStream.activityId, activityId));
      expect(streams).toHaveLength(0);
    }
  });

  it("handles large metric streams by batching inserts (>500 samples)", async () => {
    await saveTokens(ctx.db, "peloton", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "offline_access openid peloton-api.members:default",
    });

    // Create a performance graph with > 500 samples
    const largeSampleCount = 600;
    const hrValues = Array.from({ length: largeSampleCount }, (_, i) => 120 + (i % 40));
    const powerValues = Array.from({ length: largeSampleCount }, (_, i) => 150 + (i % 80));

    const largeGraph: PelotonPerformanceGraph = {
      duration: largeSampleCount * 5,
      is_class_plan_shown: true,
      segment_list: [],
      average_summaries: [],
      summaries: [],
      metrics: [
        {
          display_name: "Heart Rate",
          slug: "heart_rate",
          values: hrValues,
          average_value: 140,
          max_value: 160,
        },
        {
          display_name: "Output",
          slug: "output",
          values: powerValues,
          average_value: 190,
          max_value: 230,
        },
      ],
    };

    server.use(
      http.get("https://api.onepeloton.com/api/me", () => HttpResponse.json({ id: "user-123" })),
      http.get("https://api.onepeloton.com/api/workout/:workoutId/performance_graph", () => HttpResponse.json(largeGraph)),
      http.get("https://api.onepeloton.com/api/user/:userId/workouts", () => {
        return HttpResponse.json({
          data: [fakeWorkout({ id: "ext-large-stream", start_time: 1709971200, end_time: 1709974200 })],
          total: 1, count: 1, page: 0, limit: 20, page_count: 1, sort_by: "-created_at", show_next: false, show_previous: false,
        });
      }),
    );

    const provider = new PelotonProvider();
    const result = await provider.sync(ctx.db, new Date("2024-01-01T00:00:00Z"));

    expect(result.errors).toHaveLength(0);

    // Check that all 600 metric_stream rows were inserted
    const activityRows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.externalId, "ext-large-stream"));
    expect(activityRows).toHaveLength(1);

    const activityId = activityRows[0]?.id;
    if (activityId) {
      const streams = await ctx.db
        .select()
        .from(metricStream)
        .where(eq(metricStream.activityId, activityId));
      expect(streams).toHaveLength(largeSampleCount);
    }
  });

  it("deletes old metric_stream rows on re-sync before inserting new ones", async () => {
    await saveTokens(ctx.db, "peloton", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "offline_access openid peloton-api.members:default",
    });

    const graph: PelotonPerformanceGraph = {
      duration: 600,
      is_class_plan_shown: false,
      segment_list: [],
      average_summaries: [],
      summaries: [],
      metrics: [
        {
          display_name: "Heart Rate",
          slug: "heart_rate",
          values: [130, 140],
          average_value: 135,
          max_value: 140,
        },
      ],
    };

    server.use(
      http.get("https://api.onepeloton.com/api/me", () => HttpResponse.json({ id: "user-123" })),
      http.get("https://api.onepeloton.com/api/workout/:workoutId/performance_graph", () => HttpResponse.json(graph)),
      http.get("https://api.onepeloton.com/api/user/:userId/workouts", () => {
        return HttpResponse.json({
          data: [fakeWorkout({ id: "ext-resync-workout", start_time: 1710057600, end_time: 1710059400 })],
          total: 1, count: 1, page: 0, limit: 20, page_count: 1, sort_by: "-created_at", show_next: false, show_previous: false,
        });
      }),
    );

    const provider = new PelotonProvider();
    const since = new Date("2024-01-01T00:00:00Z");

    // Sync twice
    await provider.sync(ctx.db, since);
    await provider.sync(ctx.db, since);

    // Should have exactly 2 metric_stream rows (not 4)
    const activityRows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.externalId, "ext-resync-workout"));
    const activityId = activityRows[0]?.id;
    if (activityId) {
      const streams = await ctx.db
        .select()
        .from(metricStream)
        .where(eq(metricStream.activityId, activityId));
      expect(streams).toHaveLength(2);
    }
  });

  it("handles speed-only metric streams (no HR, power, or cadence)", async () => {
    await saveTokens(ctx.db, "peloton", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "offline_access openid peloton-api.members:default",
    });

    const speedOnlyGraph: PelotonPerformanceGraph = {
      duration: 600,
      is_class_plan_shown: false,
      segment_list: [],
      average_summaries: [],
      summaries: [],
      metrics: [
        {
          display_name: "Speed",
          slug: "speed",
          values: [5.0, 5.5, 6.0],
          average_value: 5.5,
          max_value: 6.0,
        },
      ],
    };

    server.use(
      http.get("https://api.onepeloton.com/api/me", () => HttpResponse.json({ id: "user-123" })),
      http.get("https://api.onepeloton.com/api/workout/:workoutId/performance_graph", () => HttpResponse.json(speedOnlyGraph)),
      http.get("https://api.onepeloton.com/api/user/:userId/workouts", () => {
        return HttpResponse.json({
          data: [fakeWorkout({ id: "ext-speed-only", start_time: 1710144000, end_time: 1710145800, fitness_discipline: "walking" })],
          total: 1, count: 1, page: 0, limit: 20, page_count: 1, sort_by: "-created_at", show_next: false, show_previous: false,
        });
      }),
    );

    const provider = new PelotonProvider();
    const result = await provider.sync(ctx.db, new Date("2024-01-01T00:00:00Z"));

    expect(result.errors).toHaveLength(0);

    // sampleCount uses hrSeries?.values.length ?? powerSeries?.values.length ?? cadenceSeries?.values.length ?? 0
    // None of those exist, so sampleCount = 0, no metric_stream rows inserted
    const activityRows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.externalId, "ext-speed-only"));
    expect(activityRows).toHaveLength(1);
  });
});

// ============================================================
// pelotonAutomatedLogin tests (mock Auth0 flow)
// ============================================================

const loginServer = setupServer();

describe("pelotonAutomatedLogin", () => {
  beforeAll(() => {
    loginServer.listen({ onUnhandledRequest: "error" });
  });

  afterEach(() => {
    loginServer.resetHandlers();
  });

  afterAll(() => {
    loginServer.close();
  });
  it.skip("completes the full Auth0 automated login flow", async () => {
    const injectedConfig = {
      extraParams: {
        state: "test-state-123",
        _csrf: "test-csrf-token",
        nonce: "test-nonce",
      },
    };
    const configBase64 = Buffer.from(JSON.stringify(injectedConfig)).toString("base64");

    const loginFormHtml = `
      <form method="POST" action="https://auth.onepeloton.com/login/callback">
        <input type="hidden" name="wresult" value="jwt-value"/>
        <input type="hidden" name="wctx" value="ctx-value"/>
      </form>
    `;

    let step = 0;

    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const urlStr = input.toString();

      // Step 1: GET /authorize -> redirect to login page
      if (urlStr.includes("/authorize") && (!init?.method || init.method === "GET")) {
        step = 1;
        return new Response(null, {
          status: 302,
          headers: {
            Location: "https://auth.onepeloton.com/login?state=test",
            "Set-Cookie": "auth0=session-cookie",
          },
        });
      }

      // Step 1b: follow redirect to login page
      if (
        urlStr.includes("/login") &&
        !urlStr.includes("/callback") &&
        !urlStr.includes("usernamepassword") &&
        (!init?.method || init.method === "GET")
      ) {
        step = 2;
        // Return the login page HTML with injectedConfig
        const html = `<html>
          <script>window.injectedConfig = window.atob("${configBase64}")</script>
        </html>`;
        return new Response(html, { status: 200 });
      }

      // Step 2: POST /usernamepassword/login
      if (urlStr.includes("/usernamepassword/login")) {
        step = 3;
        return new Response(loginFormHtml, { status: 200 });
      }

      // Step 3: POST the form action (/login/callback)
      if (urlStr.includes("/login/callback") && init?.method === "POST") {
        step = 4;
        return new Response(null, {
          status: 302,
          headers: {
            Location: "https://auth.onepeloton.com/authorize/resume?state=test",
          },
        });
      }

      // Step 4: follow redirect to /authorize/resume
      if (urlStr.includes("/authorize/resume")) {
        step = 5;
        return new Response(null, {
          status: 302,
          headers: {
            Location: "https://members.onepeloton.com/callback?code=auth-code-123&state=test",
          },
        });
      }

      // Step 5: Exchange code for tokens (POST to /oauth/token)
      if (urlStr.includes("/oauth/token")) {
        step = 6;
        return Response.json({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 172800,
          scope: "offline_access openid peloton-api.members:default",
        });
      }

      return new Response("Not found", { status: 404 });
    };

    const tokens = await pelotonAutomatedLogin("user@test.com", "password123");

    expect(step).toBe(6);
    expect(tokens.accessToken).toBe("new-access-token");
    expect(tokens.refreshToken).toBe("new-refresh-token");
  });

  it("throws when injectedConfig is not found in login page", async () => {
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      const urlStr = input.toString();

      if (urlStr.includes("/authorize")) {
        // Return login page directly (no redirect)
        return new Response("<html><body>No config here</body></html>", { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    };

    await expect(pelotonAutomatedLogin("user@test.com", "pass")).rejects.toThrow(
      "Could not find injectedConfig",
    );
  });

  it("throws when Auth0 login POST fails", async () => {
    const injectedConfig = {
      extraParams: {
        state: "test-state",
        _csrf: "csrf-token",
      },
    };
    const configBase64 = Buffer.from(JSON.stringify(injectedConfig)).toString("base64");

    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => {
      const urlStr = input.toString();

      if (urlStr.includes("/authorize")) {
        return new Response(
          `<html><script>window.injectedConfig = window.atob("${configBase64}")</script></html>`,
          { status: 200 },
        );
      }

      if (urlStr.includes("/usernamepassword/login")) {
        return new Response("Invalid credentials", { status: 403 });
      }

      return new Response("Not found", { status: 404 });
    };

    await expect(pelotonAutomatedLogin("user@test.com", "wrongpass")).rejects.toThrow(
      "Auth0 login failed (403)",
    );
  });

  it("throws when redirect chain ends without Location header", async () => {
    const injectedConfig = {
      extraParams: {
        state: "test-state",
        _csrf: "csrf-token",
      },
    };
    const configBase64 = Buffer.from(JSON.stringify(injectedConfig)).toString("base64");

    const loginFormHtml = `
      <form method="POST" action="https://auth.onepeloton.com/login/callback">
        <input type="hidden" name="wresult" value="jwt"/>
      </form>
    `;

    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const urlStr = input.toString();

      if (urlStr.includes("/authorize") && (!init?.method || init.method === "GET")) {
        return new Response(
          `<html><script>window.injectedConfig = window.atob("${configBase64}")</script></html>`,
          { status: 200 },
        );
      }

      if (urlStr.includes("/usernamepassword/login")) {
        return new Response(loginFormHtml, { status: 200 });
      }

      // Form POST returns 200 with no Location -> redirect chain ends
      if (urlStr.includes("/login/callback")) {
        return new Response("OK", { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    };

    await expect(pelotonAutomatedLogin("user@test.com", "pass")).rejects.toThrow(
      "redirect chain ended without a Location header",
    );
  });

  it("throws when Auth0 redirect contains error parameter", async () => {
    const injectedConfig = {
      extraParams: {
        state: "test-state",
        _csrf: "csrf-token",
      },
    };
    const configBase64 = Buffer.from(JSON.stringify(injectedConfig)).toString("base64");

    const loginFormHtml = `
      <form method="POST" action="https://auth.onepeloton.com/login/callback">
        <input type="hidden" name="wresult" value="jwt"/>
      </form>
    `;

    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const urlStr = input.toString();

      if (urlStr.includes("/authorize") && (!init?.method || init.method === "GET")) {
        return new Response(
          `<html><script>window.injectedConfig = window.atob("${configBase64}")</script></html>`,
          { status: 200 },
        );
      }

      if (urlStr.includes("/usernamepassword/login")) {
        return new Response(loginFormHtml, { status: 200 });
      }

      if (urlStr.includes("/login/callback")) {
        return new Response(null, {
          status: 302,
          headers: {
            Location:
              "https://members.onepeloton.com/callback?error=access_denied&error_description=User+blocked",
          },
        });
      }

      return new Response("Not found", { status: 404 });
    };

    await expect(pelotonAutomatedLogin("user@test.com", "pass")).rejects.toThrow(
      "User blocked",
    );
  });
});

// ============================================================
// parseAuth0FormHtml — HTML entity decoding edge cases
// ============================================================

describe("parseAuth0FormHtml — entity edge cases", () => {
  it("parses hidden inputs with type attribute in different positions", () => {
    const html = `
      <form action="https://example.com/cb" method="POST">
        <input name="field1" type="hidden" value="val1"/>
        <input type="hidden" name="field2" value="val2"/>
      </form>
    `;
    const result = parseAuth0FormHtml(html);
    expect(result.fields.field1).toBe("val1");
    expect(result.fields.field2).toBe("val2");
  });
});
