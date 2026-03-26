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
    expect(mapFitnessDiscipline("cycling")).toBe("indoor_cycling");
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
    expect(parsed.activityType).toBe("indoor_cycling");
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

// ============================================================
// PelotonProvider.sync — NoCoverage / Survived mutant tests
// ============================================================

const VALID_TOKEN = {
  accessToken: "access-token-abc",
  refreshToken: "refresh-token-xyz",
  expiresAt: new Date(Date.now() + 3600 * 1000), // valid for 1 hour
  scopes: ["offline_access"],
};

const EXPIRED_TOKEN = {
  accessToken: "old-access-token",
  refreshToken: "refresh-token-xyz",
  expiresAt: new Date(Date.now() - 3600 * 1000), // expired 1 hour ago
  scopes: ["offline_access"],
};

function makeWorkout(
  overrides: Partial<{
    id: string;
    status: string;
    start_time: number;
    end_time: number;
  }> = {},
): PelotonWorkout {
  return {
    id: overrides.id ?? "workout-123",
    status: overrides.status ?? "COMPLETE",
    fitness_discipline: "cycling",
    name: "HIIT Ride",
    title: "HIIT Ride",
    created_at: overrides.start_time ?? 1709280000,
    start_time: overrides.start_time ?? 1709280000,
    end_time: overrides.end_time ?? 1709281800,
    total_work: 360000,
    is_total_work_personal_record: false,
    ride: {
      id: "ride-001",
      title: "30 min Power Zone Ride",
      description: "Build endurance",
      duration: 1800,
      difficulty_rating_avg: 7.85,
      overall_rating_avg: 4.9,
      instructor: { id: "instr-001", name: "Matt Wilpers" },
    },
  };
}

function makeWorkoutListResponse(workouts: PelotonWorkout[], showNext = false): object {
  return {
    data: workouts,
    total: workouts.length,
    count: workouts.length,
    page: 0,
    limit: 20,
    page_count: 1,
    sort_by: "-created_at",
    show_next: showNext,
    show_previous: false,
  };
}

function makePerformanceGraph(slugs: string[] = ["heart_rate"]): object {
  return {
    duration: 1800,
    is_class_plan_shown: false,
    segment_list: [],
    average_summaries: [],
    summaries: [],
    metrics: slugs.map((slug) => ({
      display_name: slug,
      slug,
      values: [130, 145, 160],
      average_value: 145,
      max_value: 160,
    })),
  };
}

function createMockDb(tokenRows: object[] = [VALID_TOKEN]) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(tokenRows),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation(() => {
        return Object.assign(Promise.resolve(), {
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "act-uuid" }]),
          }),
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        });
      }),
    }),
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    execute: vi.fn().mockResolvedValue([]),
  };
}

describe("PelotonProvider.sync — happy path", () => {
  it("syncs a single COMPLETE workout and inserts activity + metric stream rows", async () => {
    const workout = makeWorkout();

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "user-123" })) // /api/me
      .mockResolvedValueOnce(Response.json(makeWorkoutListResponse([workout]))) // page 0
      .mockResolvedValueOnce(Response.json(makePerformanceGraph(["heart_rate"]))); // perf graph

    const mockDb = createMockDb();

    const since = new Date((workout.start_time - 1000) * 1000); // before the workout
    const provider = new PelotonProvider(mockFetch);
    const result = await provider.sync(mockDb, since);

    expect(result.provider).toBe("peloton");
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThan(0);
    // insert called for: provider upsert, activity upsert, metric_stream batch
    expect(mockDb.insert).toHaveBeenCalled();
    // delete called for metric_stream cleanup
    expect(mockDb.delete).toHaveBeenCalled();
  });
});

describe("PelotonProvider.sync — workout filtering", () => {
  it("skips workouts with status other than COMPLETE", async () => {
    const workout = makeWorkout({ status: "IN_PROGRESS" });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "user-123" }))
      .mockResolvedValueOnce(Response.json(makeWorkoutListResponse([workout])));

    const mockDb = createMockDb();

    const since = new Date((workout.start_time - 1000) * 1000);
    const provider = new PelotonProvider(mockFetch);
    const result = await provider.sync(mockDb, since);

    expect(result.errors).toHaveLength(0);
    // recordsSynced should be 0 because the only workout was skipped
    expect(result.recordsSynced).toBe(0);
    // performance graph should never be fetched
    expect(mockFetch).toHaveBeenCalledTimes(2); // /api/me + workouts page
  });

  it("skips workouts whose start_time is before the since date and stops pagination", async () => {
    const since = new Date("2024-03-10T00:00:00.000Z"); // cutoff
    const workout = makeWorkout({
      start_time: Math.floor(new Date("2024-03-01").getTime() / 1000),
    }); // before cutoff

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "user-123" }))
      .mockResolvedValueOnce(Response.json(makeWorkoutListResponse([workout], true))); // show_next=true but should stop

    const mockDb = createMockDb();

    const provider = new PelotonProvider(mockFetch);
    const result = await provider.sync(mockDb, since);

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(0);
    // Should only fetch page 0 (loop exits because startedAt < since sets hasMore=false)
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("PelotonProvider.sync — onProgress callback", () => {
  it("calls onProgress with percentage and message for each workout", async () => {
    const workout1 = makeWorkout({ id: "w-001", start_time: 1709280000 });
    const workout2 = makeWorkout({ id: "w-002", start_time: 1709290000 });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "user-123" }))
      .mockResolvedValueOnce(
        Response.json({
          data: [workout2, workout1], // sorted newest-first
          total: 2,
          count: 2,
          page: 0,
          limit: 20,
          page_count: 1,
          sort_by: "-created_at",
          show_next: false,
          show_previous: false,
        }),
      )
      .mockResolvedValueOnce(Response.json(makePerformanceGraph())) // graph for w-002
      .mockResolvedValueOnce(Response.json(makePerformanceGraph())); // graph for w-001

    const mockDb = createMockDb();

    const since = new Date((workout1.start_time - 1000) * 1000);
    const onProgress = vi.fn();

    const provider = new PelotonProvider(mockFetch);
    await provider.sync(mockDb, since, { onProgress });

    expect(onProgress).toHaveBeenCalledTimes(2);
    // First call: 1/2 workouts → 50%
    expect(onProgress).toHaveBeenNthCalledWith(1, 50, "1/2 workouts");
    // Second call: 2/2 workouts → 100%
    expect(onProgress).toHaveBeenNthCalledWith(2, 100, "2/2 workouts");
  });

  it("does not call onProgress when no workouts are found", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "user-123" }))
      .mockResolvedValueOnce(Response.json(makeWorkoutListResponse([])));

    const mockDb = createMockDb();
    const onProgress = vi.fn();

    const provider = new PelotonProvider(mockFetch);
    await provider.sync(mockDb, new Date("2026-01-01"), { onProgress });

    expect(onProgress).not.toHaveBeenCalled();
  });
});

describe("PelotonProvider.sync — performance graph error handling", () => {
  it("collects a non-fatal error and still counts the activity when graph fetch fails", async () => {
    const workout = makeWorkout();

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "user-123" }))
      .mockResolvedValueOnce(Response.json(makeWorkoutListResponse([workout])))
      .mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));

    const mockDb = createMockDb();

    const since = new Date((workout.start_time - 1000) * 1000);
    const provider = new PelotonProvider(mockFetch);
    const result = await provider.sync(mockDb, since);

    // Activity was still inserted (workoutCount incremented before graph fetch)
    expect(result.recordsSynced).toBeGreaterThan(0);
    // Error was captured, not thrown
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("Performance graph for workout-123");
    // delete should NOT have been called since graph fetch failed before any metric rows
    expect(mockDb.delete).not.toHaveBeenCalled();
  });
});

describe("PelotonProvider.sync — metric stream deletion and insertion", () => {
  it("deletes existing metric_stream rows and inserts new ones in batches", async () => {
    const workout = makeWorkout();

    // Build a graph with enough values to test batch logic (> 500 to force 2 batches)
    const values = Array.from({ length: 600 }, (_, i) => 100 + i);
    const graph = {
      duration: 3000,
      is_class_plan_shown: false,
      segment_list: [],
      average_summaries: [],
      summaries: [],
      metrics: [
        {
          display_name: "Heart Rate",
          slug: "heart_rate",
          values,
          average_value: 150,
          max_value: 200,
        },
      ],
    };

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "user-123" }))
      .mockResolvedValueOnce(Response.json(makeWorkoutListResponse([workout])))
      .mockResolvedValueOnce(Response.json(graph));

    const mockDb = createMockDb();

    const since = new Date((workout.start_time - 1000) * 1000);
    const provider = new PelotonProvider(mockFetch);
    const result = await provider.sync(mockDb, since);

    expect(result.errors).toHaveLength(0);
    // delete called once to wipe existing metric_stream rows for this activity
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    // insert called at least 3 times: provider upsert + activity upsert + 2 metric batches
    // (600 rows → 2 batches of 500 and 100)
    const insertCalls = mockDb.insert.mock.calls.length;
    expect(insertCalls).toBeGreaterThanOrEqual(4);
    // Total synced = workoutCount + streamCount = 1 + 600 = 601
    expect(result.recordsSynced).toBe(601);
  });

  it("skips metric_stream insertion when no metric data is present", async () => {
    const workout = makeWorkout();
    const emptyGraph = {
      duration: 1800,
      is_class_plan_shown: false,
      segment_list: [],
      average_summaries: [],
      summaries: [],
      metrics: [], // no metrics → sampleCount = 0
    };

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "user-123" }))
      .mockResolvedValueOnce(Response.json(makeWorkoutListResponse([workout])))
      .mockResolvedValueOnce(Response.json(emptyGraph));

    const mockDb = createMockDb();

    const since = new Date((workout.start_time - 1000) * 1000);
    const provider = new PelotonProvider(mockFetch);
    const result = await provider.sync(mockDb, since);

    expect(result.errors).toHaveLength(0);
    // delete should NOT have been called — no metric rows to clean up
    expect(mockDb.delete).not.toHaveBeenCalled();
    // workoutCount = 1, streamCount = 0
    expect(result.recordsSynced).toBe(1);
  });
});

describe("PelotonProvider.sync — pagination", () => {
  it("fetches the next page when show_next is true on the first page", async () => {
    const workout1 = makeWorkout({ id: "w-page1", start_time: 1709290000 });
    const workout2 = makeWorkout({ id: "w-page2", start_time: 1709280000 });

    const page0Response = {
      data: [workout1],
      total: 2,
      count: 1,
      page: 0,
      limit: 20,
      page_count: 2,
      sort_by: "-created_at",
      show_next: true,
      show_previous: false,
    };
    const page1Response = {
      data: [workout2],
      total: 2,
      count: 1,
      page: 1,
      limit: 20,
      page_count: 2,
      sort_by: "-created_at",
      show_next: false,
      show_previous: true,
    };

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "user-123" })) // /api/me
      .mockResolvedValueOnce(Response.json(page0Response))
      .mockResolvedValueOnce(Response.json(makePerformanceGraph())) // graph for workout1
      .mockResolvedValueOnce(Response.json(page1Response))
      .mockResolvedValueOnce(Response.json(makePerformanceGraph())); // graph for workout2

    const mockDb = createMockDb();

    const since = new Date((workout2.start_time - 1000) * 1000);
    const provider = new PelotonProvider(mockFetch);
    const result = await provider.sync(mockDb, since);

    expect(result.errors).toHaveLength(0);
    // workout page fetched twice (page=0 and page=1)
    const workoutFetchUrls = mockFetch.mock.calls
      .map((args) => String(args[0]))
      .filter((url) => url.includes("/workouts"));
    expect(workoutFetchUrls).toHaveLength(2);
    expect(workoutFetchUrls[0]).toContain("page=0");
    expect(workoutFetchUrls[1]).toContain("page=1");
  });
});

describe("PelotonProvider.sync — token refresh", () => {
  it("refreshes an expired token before syncing", async () => {
    const workout = makeWorkout();

    const refreshedTokenResponse = {
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_in: 3600,
      token_type: "Bearer",
      scope: "offline_access",
    };

    const mockFetch = vi
      .fn()
      // Token refresh call to auth.onepeloton.com/oauth/token
      .mockResolvedValueOnce(Response.json(refreshedTokenResponse))
      // /api/me with new token
      .mockResolvedValueOnce(Response.json({ id: "user-123" }))
      // workouts page
      .mockResolvedValueOnce(Response.json(makeWorkoutListResponse([workout])))
      // performance graph
      .mockResolvedValueOnce(Response.json(makePerformanceGraph()));

    // DB returns expired tokens on token load, then handles saves for refresh + ensureProvider
    const mockDb = createMockDb([EXPIRED_TOKEN]);

    const since = new Date((workout.start_time - 1000) * 1000);
    const provider = new PelotonProvider(mockFetch);
    const result = await provider.sync(mockDb, since);

    // Should have called the token refresh endpoint
    const refreshCall = mockFetch.mock.calls.find((args) =>
      String(args[0]).includes("oauth/token"),
    );
    expect(refreshCall).toBeDefined();

    // Sync should complete successfully with the refreshed token
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThan(0);
  });
});

describe("PelotonProvider.sync — duration", () => {
  it("returns a positive duration in the sync result", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "user-123" }))
      .mockResolvedValueOnce(Response.json(makeWorkoutListResponse([])));

    const mockDb = createMockDb();

    const provider = new PelotonProvider(mockFetch);
    const result = await provider.sync(mockDb, new Date("2026-01-01"));

    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("duration is measured as elapsed time (not negative or zero for fast syncs)", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "user-123" }))
      .mockResolvedValueOnce(Response.json(makeWorkoutListResponse([])));

    const mockDb = createMockDb();

    const before = Date.now();
    const provider = new PelotonProvider(mockFetch);
    const result = await provider.sync(mockDb, new Date("2026-01-01"));
    const after = Date.now();

    // duration must be non-negative and not exceed the wall-clock elapsed time by more than 100ms
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.duration).toBeLessThanOrEqual(after - before + 100);
  });
});
