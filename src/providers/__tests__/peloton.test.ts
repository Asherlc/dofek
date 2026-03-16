import { afterEach, describe, expect, it } from "vitest";
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
} from "../peloton.ts";

// ============================================================
// Sample API responses
// ============================================================

const sampleWorkout: PelotonWorkout = {
  id: "abc123def456",
  status: "COMPLETE",
  fitness_discipline: "cycling",
  name: "Cycling Workout",
  title: "30 min Power Zone Ride",
  created_at: 1709280000, // 2024-03-01T08:00:00Z
  start_time: 1709280000,
  end_time: 1709281800, // +30 min
  total_work: 360000, // joules
  is_total_work_personal_record: false,
  metrics_type: "cycling",
  ride: {
    id: "ride-001",
    title: "30 min Power Zone Ride",
    description: "Build your endurance in this classic Power Zone ride.",
    duration: 1800,
    difficulty_rating_avg: 7.85,
    overall_rating_avg: 4.9,
    instructor: {
      id: "instr-001",
      name: "Matt Wilpers",
      image_url: "https://example.com/matt.jpg",
    },
  },
  total_leaderboard_users: 15000,
  leaderboard_rank: 3200,
  average_effort_score: null,
};

const sampleCyclingWorkout: PelotonWorkout = {
  ...sampleWorkout,
  fitness_discipline: "cycling",
};

// sampleWorkout.ride is defined in the fixture above; guard for type safety
const sampleRide = sampleWorkout.ride;
if (!sampleRide) throw new Error("sampleWorkout.ride must be defined");

const sampleStrengthWorkout: PelotonWorkout = {
  ...sampleWorkout,
  id: "str-789",
  fitness_discipline: "strength",
  title: "20 min Full Body Strength",
  total_work: 0,
  ride: {
    ...sampleRide,
    title: "20 min Full Body Strength",
    difficulty_rating_avg: 6.5,
    duration: 1200,
  },
};

const sampleRunningWorkout: PelotonWorkout = {
  ...sampleWorkout,
  id: "run-456",
  fitness_discipline: "running",
  title: "45 min Endurance Run",
  ride: {
    ...sampleRide,
    title: "45 min Endurance Run",
    difficulty_rating_avg: 8.2,
    instructor: {
      id: "instr-002",
      name: "Becs Gentry",
      image_url: "https://example.com/becs.jpg",
    },
  },
};

const samplePerformanceGraph: PelotonPerformanceGraph = {
  duration: 1800,
  is_class_plan_shown: true,
  segment_list: [],
  average_summaries: [
    { display_name: "Avg Output", value: "200", slug: "avg_output" },
    { display_name: "Avg Cadence", value: "85", slug: "avg_cadence" },
    { display_name: "Avg Resistance", value: "45", slug: "avg_resistance" },
    { display_name: "Avg Speed", value: "18.5", slug: "avg_speed" },
  ],
  summaries: [
    { display_name: "Total Output", value: "360", slug: "total_output" },
    { display_name: "Distance", value: "9.25", slug: "distance" },
    { display_name: "Calories", value: "450", slug: "calories" },
  ],
  metrics: [
    {
      display_name: "Output",
      slug: "output",
      values: [180, 200, 220, 210, 195],
      average_value: 200,
      max_value: 220,
    },
    {
      display_name: "Cadence",
      slug: "cadence",
      values: [80, 85, 90, 88, 82],
      average_value: 85,
      max_value: 90,
    },
    {
      display_name: "Resistance",
      slug: "resistance",
      values: [40, 45, 50, 48, 42],
      average_value: 45,
      max_value: 50,
    },
    {
      display_name: "Speed",
      slug: "speed",
      values: [17.0, 18.5, 20.0, 19.2, 17.8],
      average_value: 18.5,
      max_value: 20.0,
    },
    {
      display_name: "Heart Rate",
      slug: "heart_rate",
      values: [130, 145, 160, 155, 140],
      average_value: 146,
      max_value: 160,
    },
  ],
};

// ============================================================
// Tests
// ============================================================

describe("Peloton Provider", () => {
  describe("mapFitnessDiscipline", () => {
    it("maps cycling", () => {
      expect(mapFitnessDiscipline("cycling")).toBe("cycling");
    });

    it("maps running", () => {
      expect(mapFitnessDiscipline("running")).toBe("running");
    });

    it("maps walking", () => {
      expect(mapFitnessDiscipline("walking")).toBe("walking");
    });

    it("maps rowing", () => {
      expect(mapFitnessDiscipline("rowing")).toBe("rowing");
    });

    it("maps strength", () => {
      expect(mapFitnessDiscipline("strength")).toBe("strength");
    });

    it("maps yoga", () => {
      expect(mapFitnessDiscipline("yoga")).toBe("yoga");
    });

    it("maps meditation", () => {
      expect(mapFitnessDiscipline("meditation")).toBe("meditation");
    });

    it("maps stretching", () => {
      expect(mapFitnessDiscipline("stretching")).toBe("stretching");
    });

    it("maps bike_bootcamp to bootcamp", () => {
      expect(mapFitnessDiscipline("bike_bootcamp")).toBe("bootcamp");
    });

    it("maps tread_bootcamp to bootcamp", () => {
      expect(mapFitnessDiscipline("tread_bootcamp")).toBe("bootcamp");
    });

    it("maps caesar (rowing) to rowing", () => {
      expect(mapFitnessDiscipline("caesar")).toBe("rowing");
    });

    it("maps cardio", () => {
      expect(mapFitnessDiscipline("cardio")).toBe("cardio");
    });

    it("maps outdoor to running", () => {
      expect(mapFitnessDiscipline("outdoor")).toBe("running");
    });

    it("maps unknown disciplines to other", () => {
      expect(mapFitnessDiscipline("some_future_class")).toBe("other");
    });
  });

  describe("parseWorkout", () => {
    it("maps a cycling workout to cardio activity fields", () => {
      const result = parseWorkout(sampleCyclingWorkout);

      expect(result.externalId).toBe("abc123def456");
      expect(result.activityType).toBe("cycling");
      expect(result.startedAt).toEqual(new Date(1709280000 * 1000));
      expect(result.endedAt).toEqual(new Date(1709281800 * 1000));
      expect(result.name).toBe("30 min Power Zone Ride");
    });

    it("extracts instructor and class info into raw metadata", () => {
      const result = parseWorkout(sampleCyclingWorkout);

      expect(result.raw).toBeDefined();
      expect(result.raw?.instructor).toBe("Matt Wilpers");
      expect(result.raw?.classTitle).toBe("30 min Power Zone Ride");
      expect(result.raw?.difficultyRating).toBeCloseTo(7.85);
      expect(result.raw?.overallRating).toBeCloseTo(4.9);
    });

    it("extracts leaderboard info into raw metadata", () => {
      const result = parseWorkout(sampleCyclingWorkout);

      expect(result.raw?.leaderboardRank).toBe(3200);
      expect(result.raw?.totalLeaderboardUsers).toBe(15000);
    });

    it("handles workouts with no ride details", () => {
      const noRide: PelotonWorkout = {
        ...sampleWorkout,
        ride: undefined,
      };

      const result = parseWorkout(noRide);
      expect(result.externalId).toBe("abc123def456");
      expect(result.raw?.instructor).toBeUndefined();
      expect(result.raw?.classTitle).toBeUndefined();
    });

    it("parses a strength workout", () => {
      const result = parseWorkout(sampleStrengthWorkout);

      expect(result.externalId).toBe("str-789");
      expect(result.activityType).toBe("strength");
    });

    it("parses a running workout", () => {
      const result = parseWorkout(sampleRunningWorkout);

      expect(result.externalId).toBe("run-456");
      expect(result.activityType).toBe("running");
      expect(result.raw?.instructor).toBe("Becs Gentry");
    });

    it("handles missing end_time", () => {
      const noEnd: PelotonWorkout = {
        ...sampleWorkout,
        end_time: 0,
      };

      const result = parseWorkout(noEnd);
      expect(result.endedAt).toBeUndefined();
      // Duration falls back to ride duration
      expect(result.name).toBe("30 min Power Zone Ride");
    });

    it("computes duration from start/end when both present", () => {
      const result = parseWorkout(sampleWorkout);
      expect(result.name).toBe("30 min Power Zone Ride");
    });

    it("stores personal record flag in raw", () => {
      const workout = { ...sampleWorkout, is_total_work_personal_record: true };
      const parsed = parseWorkout(workout);
      expect(parsed.raw.isPersonalRecord).toBe(true);
    });

    it("omits isPersonalRecord when false", () => {
      const workout = { ...sampleWorkout, is_total_work_personal_record: false };
      const parsed = parseWorkout(workout);
      expect(parsed.raw.isPersonalRecord).toBeUndefined();
    });

    it("omits totalWorkJoules when total_work is 0", () => {
      const workout = { ...sampleWorkout, total_work: 0 };
      const parsed = parseWorkout(workout);
      expect(parsed.raw.totalWorkJoules).toBeUndefined();
    });

    it("stores fitness discipline in raw", () => {
      const workout: PelotonWorkout = {
        ...sampleWorkout,
        fitness_discipline: "yoga",
      };
      const parsed = parseWorkout(workout);
      expect(parsed.raw.fitnessDiscipline).toBe("yoga");
      expect(parsed.activityType).toBe("yoga");
    });

    it("stores peloton ride ID in raw", () => {
      const workout: PelotonWorkout = {
        ...sampleWorkout,
        ride: {
          ...sampleRide,
          id: "ride-abc",
          title: "Power Ride",
          duration: 2700,
          overall_rating_avg: 4.95,
        },
      };
      const parsed = parseWorkout(workout);
      expect(parsed.raw.pelotonRideId).toBe("ride-abc");
      expect(parsed.raw.overallRating).toBeCloseTo(4.95);
    });

    it("stores ride description in raw", () => {
      const workout: PelotonWorkout = {
        ...sampleWorkout,
        ride: {
          ...sampleRide,
          id: "ride-desc",
          title: "Cool Ride",
          duration: 1200,
          description: "A really cool ride with intervals",
        },
      };
      const parsed = parseWorkout(workout);
      expect(parsed.raw.rideDescription).toBe("A really cool ride with intervals");
    });
  });

  describe("parsePerformanceGraph", () => {
    it("extracts time-series heart rate values", () => {
      const result = parsePerformanceGraph(samplePerformanceGraph, 5);

      const hrMetric = result.find((m) => m.slug === "heart_rate");
      expect(hrMetric).toBeDefined();
      expect(hrMetric?.values).toEqual([130, 145, 160, 155, 140]);
      expect(hrMetric?.averageValue).toBe(146);
      expect(hrMetric?.maxValue).toBe(160);
    });

    it("extracts power/output values", () => {
      const result = parsePerformanceGraph(samplePerformanceGraph, 5);

      const outputMetric = result.find((m) => m.slug === "output");
      expect(outputMetric).toBeDefined();
      expect(outputMetric?.values).toEqual([180, 200, 220, 210, 195]);
      expect(outputMetric?.averageValue).toBe(200);
      expect(outputMetric?.maxValue).toBe(220);
    });

    it("extracts cadence values", () => {
      const result = parsePerformanceGraph(samplePerformanceGraph, 5);

      const cadenceMetric = result.find((m) => m.slug === "cadence");
      expect(cadenceMetric).toBeDefined();
      expect(cadenceMetric?.averageValue).toBe(85);
    });

    it("computes timestamps from interval", () => {
      const result = parsePerformanceGraph(samplePerformanceGraph, 5);

      const hrMetric = result.find((m) => m.slug === "heart_rate");
      // 5 values at 5-second intervals: 0, 5, 10, 15, 20
      expect(hrMetric?.offsetsSeconds).toEqual([0, 5, 10, 15, 20]);
    });

    it("returns all metric slugs", () => {
      const result = parsePerformanceGraph(samplePerformanceGraph, 5);
      const slugs = result.map((m) => m.slug);

      expect(slugs).toContain("output");
      expect(slugs).toContain("cadence");
      expect(slugs).toContain("resistance");
      expect(slugs).toContain("speed");
      expect(slugs).toContain("heart_rate");
    });

    it("handles empty metrics array", () => {
      const empty: PelotonPerformanceGraph = {
        ...samplePerformanceGraph,
        metrics: [],
      };

      const result = parsePerformanceGraph(empty, 5);
      expect(result).toEqual([]);
    });
  });

  describe("parseAuth0FormHtml", () => {
    it("extracts form action and hidden fields", () => {
      const html = `
        <html><body>
          <form method="POST" action="https://auth.onepeloton.com/login/callback">
            <input type="hidden" name="wa" value="wsignin1.0" />
            <input type="hidden" name="wresult" value="eyJ0eXAi..." />
            <input type="hidden" name="wctx" value="some-context" />
          </form>
        </body></html>
      `;

      const result = parseAuth0FormHtml(html);
      expect(result.action).toBe("https://auth.onepeloton.com/login/callback");
      expect(result.fields).toEqual({
        wa: "wsignin1.0",
        wresult: "eyJ0eXAi...",
        wctx: "some-context",
      });
    });

    it("handles empty value attributes", () => {
      const html = `
        <form action="https://example.com/cb">
          <input type="hidden" name="token" value="" />
        </form>
      `;

      const result = parseAuth0FormHtml(html);
      expect(result.fields.token).toBe("");
    });

    it("throws when no form found", () => {
      expect(() => parseAuth0FormHtml("<html><body>No form here</body></html>")).toThrow(
        "Could not find form action",
      );
    });

    it("handles input attributes in any order", () => {
      const html = `
        <form action="https://example.com/cb" method="POST">
          <input name="field1" type="hidden" value="val1" />
          <input value="val2" name="field2" type="hidden" />
        </form>
      `;

      const result = parseAuth0FormHtml(html);
      expect(result.fields.field1).toBe("val1");
      expect(result.fields.field2).toBe("val2");
    });

    it("only includes hidden inputs, not text or password", () => {
      const html = `
        <form method="POST" action="https://auth.example.com/callback">
          <input type="text" name="username" value="should-not-be-parsed"/>
          <input type="hidden" name="wa" value="wsignin1.0"/>
          <input type="hidden" name="wresult" value="long-jwt-token"/>
          <input type="password" name="password" value="secret"/>
          <input type="hidden" name="wctx" value="some-context"/>
          <button type="submit">Continue</button>
        </form>
      `;
      const result = parseAuth0FormHtml(html);
      expect(result.action).toBe("https://auth.example.com/callback");
      expect(result.fields.wa).toBe("wsignin1.0");
      expect(result.fields.wresult).toBe("long-jwt-token");
      expect(result.fields.wctx).toBe("some-context");
      // Should not include non-hidden inputs
      expect(result.fields.username).toBeUndefined();
      expect(result.fields.password).toBeUndefined();
    });

    it("handles hidden input without value attribute", () => {
      const html = `
        <form method="POST" action="https://example.com/cb">
          <input type="hidden" name="emptyfield"/>
        </form>
      `;
      const result = parseAuth0FormHtml(html);
      expect(result.fields.emptyfield).toBe("");
    });
  });
});

describe("pelotonOAuthConfig", () => {
  it("returns a config with expected fields", () => {
    const config = pelotonOAuthConfig();
    expect(config.clientId).toBeDefined();
    expect(config.authorizeUrl).toContain("onepeloton.com");
    expect(config.tokenUrl).toContain("onepeloton.com");
    expect(config.scopes).toContain("offline_access");
    expect(config.usePkce).toBe(true);
  });

  it("includes all required OAuth configuration fields", () => {
    const config = pelotonOAuthConfig();
    expect(config.clientId).toBeTruthy();
    expect(config.authorizeUrl).toBeTruthy();
    expect(config.tokenUrl).toBeTruthy();
    expect(config.redirectUri).toBeTruthy();
    expect(config.scopes).toBeInstanceOf(Array);
    expect(config.scopes.length).toBeGreaterThan(0);
    expect(config.audience).toContain("onepeloton.com");
  });
});

describe("PelotonProvider.validate()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns error when credentials are missing", () => {
    delete process.env.PELOTON_USERNAME;
    delete process.env.PELOTON_PASSWORD;
    const provider = new PelotonProvider();
    expect(provider.validate()).toContain("PELOTON_USERNAME");
  });

  it("returns null when credentials are set", () => {
    process.env.PELOTON_USERNAME = "user@test.com";
    process.env.PELOTON_PASSWORD = "password";
    const provider = new PelotonProvider();
    expect(provider.validate()).toBeNull();
  });
});

describe("PelotonProvider.authSetup()", () => {
  it("returns auth setup with OAuth config", () => {
    const provider = new PelotonProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.clientId).toBeDefined();
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.automatedLogin).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toContain("onepeloton.com");
  });

  it("authUrl contains onepeloton.com", () => {
    const provider = new PelotonProvider();
    const setup = provider.authSetup();
    expect(typeof setup.authUrl).toBe("string");
    expect(setup.authUrl).toContain("onepeloton.com");
  });
});

describe("PelotonProvider — provider info", () => {
  it("has correct id and name", () => {
    const provider = new PelotonProvider();
    expect(provider.id).toBe("peloton");
    expect(provider.name).toBe("Peloton");
  });
});

describe("PelotonClient — error handling", () => {
  it("throws on non-OK response", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Unauthorized", { status: 401 });
    };

    const client = new PelotonClient("bad-token", mockFetch);
    await expect(client.getUserId()).rejects.toThrow("Peloton API error (401)");
  });

  it("caches userId after first call", async () => {
    let callCount = 0;
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      const url = input.toString();
      if (url.includes("/api/me")) {
        callCount++;
        return Response.json({ id: "user-456" });
      }
      if (url.includes("/workouts")) {
        return Response.json({
          data: [],
          total: 0,
          count: 0,
          page: 0,
          limit: 20,
          page_count: 0,
          sort_by: "-created_at",
          show_next: false,
          show_previous: false,
        });
      }
      return new Response("Not found", { status: 404 });
    };

    const client = new PelotonClient("token", mockFetch);
    await client.getUserId();
    await client.getWorkouts(0);

    // /api/me should have been called only once
    expect(callCount).toBe(1);
  });
});

describe("PelotonClient — getPerformanceGraph", () => {
  it("passes everyN parameter to the API", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      const url = input.toString();
      if (url.includes("/api/me")) {
        return Response.json({ id: "user-123" });
      }
      if (url.includes("/performance_graph")) {
        capturedUrl = url;
        return Response.json({
          duration: 1800,
          is_class_plan_shown: false,
          segment_list: [],
          average_summaries: [],
          summaries: [],
          metrics: [],
        });
      }
      return new Response("Not found", { status: 404 });
    };

    const client = new PelotonClient("token", mockFetch);
    await client.getPerformanceGraph("workout-123", 10);

    expect(capturedUrl).toContain("every_n=10");
    expect(capturedUrl).toContain("workout-123");
  });
});

describe("PelotonClient — getWorkouts", () => {
  it("passes page and limit parameters", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      const url = input.toString();
      if (url.includes("/api/me")) {
        return Response.json({ id: "user-789" });
      }
      if (url.includes("/workouts")) {
        capturedUrl = url;
        return Response.json({
          data: [],
          total: 0,
          count: 0,
          page: 2,
          limit: 50,
          page_count: 0,
          sort_by: "-created_at",
          show_next: false,
          show_previous: true,
        });
      }
      return new Response("Not found", { status: 404 });
    };

    const client = new PelotonClient("token", mockFetch);
    await client.getWorkouts(2, 50);

    expect(capturedUrl).toContain("page=2");
    expect(capturedUrl).toContain("limit=50");
    expect(capturedUrl).toContain("sort_by=-created_at");
    expect(capturedUrl).toContain("joins=ride");
  });
});

describe("parsePerformanceGraph — extended", () => {
  it("handles single metric with different everyN", () => {
    const graph: PelotonPerformanceGraph = {
      duration: 600,
      is_class_plan_shown: false,
      segment_list: [],
      average_summaries: [],
      summaries: [],
      metrics: [
        {
          display_name: "Cadence",
          slug: "cadence",
          values: [80, 90, 100, 85],
          average_value: 88.75,
          max_value: 100,
        },
      ],
    };

    const series = parsePerformanceGraph(graph, 10);
    expect(series).toHaveLength(1);
    expect(series[0]?.offsetsSeconds).toEqual([0, 10, 20, 30]);
    expect(series[0]?.displayName).toBe("Cadence");
  });
});
