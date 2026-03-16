import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mapFitnessDiscipline,
  PelotonClient,
  type PelotonPerformanceGraph,
  PelotonProvider,
  type PelotonWorkout,
  parseAuth0FormHtml,
  parsePerformanceGraph,
  parseWorkout,
  pelotonOAuthConfig,
} from "./peloton.ts";

// ============================================================
// Tests targeting uncovered paths in peloton.ts
// ============================================================

describe("mapFitnessDiscipline — all types", () => {
  it("maps all known disciplines", () => {
    expect(mapFitnessDiscipline("cycling")).toBe("cycling");
    expect(mapFitnessDiscipline("running")).toBe("running");
    expect(mapFitnessDiscipline("walking")).toBe("walking");
    expect(mapFitnessDiscipline("rowing")).toBe("rowing");
    expect(mapFitnessDiscipline("caesar")).toBe("rowing");
    expect(mapFitnessDiscipline("strength")).toBe("strength");
    expect(mapFitnessDiscipline("yoga")).toBe("yoga");
    expect(mapFitnessDiscipline("meditation")).toBe("meditation");
    expect(mapFitnessDiscipline("stretching")).toBe("stretching");
    expect(mapFitnessDiscipline("cardio")).toBe("cardio");
    expect(mapFitnessDiscipline("bike_bootcamp")).toBe("bootcamp");
    expect(mapFitnessDiscipline("tread_bootcamp")).toBe("bootcamp");
    expect(mapFitnessDiscipline("outdoor")).toBe("running");
  });

  it("returns other for unknown", () => {
    expect(mapFitnessDiscipline("unknown_sport")).toBe("other");
  });
});

describe("parseWorkout", () => {
  const sampleWorkout: PelotonWorkout = {
    id: "workout-123",
    status: "COMPLETE",
    fitness_discipline: "cycling",
    name: "HIIT Ride",
    title: "HIIT Ride",
    created_at: 1709200000,
    start_time: 1709200000,
    end_time: 1709203600,
    total_work: 150000,
    is_total_work_personal_record: true,
    ride: {
      id: "ride-456",
      title: "30 Min HIIT Ride",
      description: "A high intensity ride",
      duration: 1800,
      difficulty_rating_avg: 8.5,
      overall_rating_avg: 4.8,
      instructor: { id: "inst-1", name: "Alex Toussaint" },
    },
    total_leaderboard_users: 5000,
    leaderboard_rank: 150,
  };

  it("parses workout with all fields", () => {
    const parsed = parseWorkout(sampleWorkout);
    expect(parsed.externalId).toBe("workout-123");
    expect(parsed.activityType).toBe("cycling");
    expect(parsed.name).toBe("30 Min HIIT Ride");
    expect(parsed.startedAt).toEqual(new Date(1709200000 * 1000));
    expect(parsed.endedAt).toEqual(new Date(1709203600 * 1000));
    expect(parsed.raw.instructor).toBe("Alex Toussaint");
    expect(parsed.raw.classTitle).toBe("30 Min HIIT Ride");
    expect(parsed.raw.difficultyRating).toBe(8.5);
    expect(parsed.raw.overallRating).toBe(4.8);
    expect(parsed.raw.rideDescription).toBe("A high intensity ride");
    expect(parsed.raw.leaderboardRank).toBe(150);
    expect(parsed.raw.totalLeaderboardUsers).toBe(5000);
    expect(parsed.raw.totalWorkJoules).toBe(150000);
    expect(parsed.raw.isPersonalRecord).toBe(true);
    expect(parsed.raw.fitnessDiscipline).toBe("cycling");
    expect(parsed.raw.pelotonRideId).toBe("ride-456");
  });

  it("handles missing ride fields", () => {
    const minimal: PelotonWorkout = {
      id: "w-min",
      status: "COMPLETE",
      fitness_discipline: "strength",
      created_at: 1709200000,
      start_time: 1709200000,
      end_time: 0,
      total_work: 0,
      is_total_work_personal_record: false,
    };

    const parsed = parseWorkout(minimal);
    expect(parsed.externalId).toBe("w-min");
    expect(parsed.activityType).toBe("strength");
    expect(parsed.name).toBeUndefined();
    expect(parsed.endedAt).toBeUndefined();
    expect(parsed.raw.instructor).toBeUndefined();
    expect(parsed.raw.totalWorkJoules).toBeUndefined();
    expect(parsed.raw.isPersonalRecord).toBeUndefined();
  });
});

describe("parsePerformanceGraph", () => {
  it("transforms metrics with correct offsets", () => {
    const graph: PelotonPerformanceGraph = {
      duration: 1800,
      is_class_plan_shown: false,
      segment_list: [],
      average_summaries: [],
      summaries: [],
      metrics: [
        {
          display_name: "Heart Rate",
          slug: "heart_rate",
          values: [130, 135, 140, 145],
          average_value: 137.5,
          max_value: 145,
        },
        {
          display_name: "Output",
          slug: "output",
          values: [100, 120, 110, 130],
          average_value: 115,
          max_value: 130,
        },
      ],
    };

    const series = parsePerformanceGraph(graph, 5);
    expect(series).toHaveLength(2);
    expect(series[0]?.slug).toBe("heart_rate");
    expect(series[0]?.values).toEqual([130, 135, 140, 145]);
    expect(series[0]?.offsetsSeconds).toEqual([0, 5, 10, 15]);
    expect(series[0]?.averageValue).toBe(137.5);
    expect(series[0]?.maxValue).toBe(145);
    expect(series[1]?.slug).toBe("output");
    expect(series[1]?.offsetsSeconds).toEqual([0, 5, 10, 15]);
  });

  it("handles empty metrics array", () => {
    const graph: PelotonPerformanceGraph = {
      duration: 0,
      is_class_plan_shown: false,
      segment_list: [],
      average_summaries: [],
      summaries: [],
      metrics: [],
    };

    const series = parsePerformanceGraph(graph, 5);
    expect(series).toHaveLength(0);
  });
});

describe("parseAuth0FormHtml", () => {
  it("extracts action and hidden fields from HTML form", () => {
    const html = `
      <form method="post" action="https://auth.onepeloton.com/login/callback">
        <input type="hidden" name="wresult" value="jwt-token-here"/>
        <input type="hidden" name="wctx" value="some-context"/>
      </form>
    `;

    const result = parseAuth0FormHtml(html);
    expect(result.action).toBe("https://auth.onepeloton.com/login/callback");
    expect(result.fields.wresult).toBe("jwt-token-here");
    expect(result.fields.wctx).toBe("some-context");
  });

  it("throws when no form action found", () => {
    expect(() => parseAuth0FormHtml("<div>no form here</div>")).toThrow(
      "Could not find form action",
    );
  });

  it("handles hidden inputs without value attribute", () => {
    const html = `
      <form method="post" action="https://example.com/callback">
        <input type="hidden" name="csrf"/>
      </form>
    `;
    const result = parseAuth0FormHtml(html);
    expect(result.fields.csrf).toBe("");
  });
});

describe("pelotonOAuthConfig", () => {
  it("returns correct OAuth config", () => {
    const config = pelotonOAuthConfig();
    expect(config.clientId).toBe("WVoJxVDdPoFx4RNewvvg6ch2mZ7bwnsM");
    expect(config.authorizeUrl).toContain("auth.onepeloton.com");
    expect(config.tokenUrl).toContain("auth.onepeloton.com");
    expect(config.scopes).toContain("offline_access");
    expect(config.usePkce).toBe(true);
  });
});

describe("PelotonClient", () => {
  it("getUserId fetches and caches user ID", async () => {
    const mockFetch = vi.fn().mockResolvedValue(Response.json({ id: "user-abc" }));
    const client = new PelotonClient("test-token", mockFetch);

    const id1 = await client.getUserId();
    expect(id1).toBe("user-abc");

    // Second call should use cache
    const id2 = await client.getUserId();
    expect(id2).toBe("user-abc");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("throws on API error", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 }));

    const client = new PelotonClient("bad-token", mockFetch);
    await expect(client.getUserId()).rejects.toThrow("Peloton API error (401)");
  });

  it("getWorkouts calls correct endpoint", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "user-123" }))
      .mockResolvedValueOnce(
        Response.json({
          data: [],
          total: 0,
          count: 0,
          page: 0,
          limit: 20,
          page_count: 0,
          sort_by: "-created_at",
          show_next: false,
          show_previous: false,
        }),
      );

    const client = new PelotonClient("token", mockFetch);
    const result = await client.getWorkouts(0, 20);
    expect(result.data).toEqual([]);
    const secondUrl = String(mockFetch.mock.calls[1]?.[0]);
    expect(secondUrl).toContain("/api/user/user-123/workouts");
  });

  it("getPerformanceGraph calls correct endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      Response.json({
        duration: 1800,
        is_class_plan_shown: false,
        segment_list: [],
        average_summaries: [],
        summaries: [],
        metrics: [],
      }),
    );

    const client = new PelotonClient("token", mockFetch);
    const result = await client.getPerformanceGraph("w-123", 5);
    expect(result.metrics).toEqual([]);
    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain("/api/workout/w-123/performance_graph");
    expect(url).toContain("every_n=5");
  });
});

describe("PelotonProvider", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("validate returns error when credentials missing", () => {
    delete process.env.PELOTON_USERNAME;
    delete process.env.PELOTON_PASSWORD;
    const provider = new PelotonProvider();
    expect(provider.validate()).toContain("PELOTON_USERNAME");
  });

  it("validate returns null when credentials set", () => {
    process.env.PELOTON_USERNAME = "test@test.com";
    process.env.PELOTON_PASSWORD = "pass123";
    const provider = new PelotonProvider();
    expect(provider.validate()).toBeNull();
  });

  it("authSetup returns correct configuration", () => {
    const provider = new PelotonProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.clientId).toBe("WVoJxVDdPoFx4RNewvvg6ch2mZ7bwnsM");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.automatedLogin).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toContain("onepeloton.com");
  });

  it("sync returns token error when no tokens stored", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: vi.fn(),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const provider = new PelotonProvider();
    const result = await provider.sync(mockDb, new Date("2026-01-01"));
    expect(result.provider).toBe("peloton");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("No OAuth tokens");
  });
});
