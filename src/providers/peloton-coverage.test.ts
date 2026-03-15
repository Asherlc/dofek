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
} from "./peloton.ts";

// ============================================================
// Coverage tests for uncovered Peloton paths:
// - mapFitnessDiscipline with various disciplines
// - parseWorkout with different workout types
// - parsePerformanceGraph metric mapping
// - pelotonOAuthConfig structure
// - PelotonProvider.validate()
// - PelotonProvider.authSetup()
// - PelotonClient error handling
// - parseAuth0FormHtml edge cases
// ============================================================

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

  it("maps caesar (Peloton rowing) to rowing", () => {
    expect(mapFitnessDiscipline("caesar")).toBe("rowing");
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

  it("maps cardio", () => {
    expect(mapFitnessDiscipline("cardio")).toBe("cardio");
  });

  it("maps bike_bootcamp to bootcamp", () => {
    expect(mapFitnessDiscipline("bike_bootcamp")).toBe("bootcamp");
  });

  it("maps tread_bootcamp to bootcamp", () => {
    expect(mapFitnessDiscipline("tread_bootcamp")).toBe("bootcamp");
  });

  it("maps outdoor to running", () => {
    expect(mapFitnessDiscipline("outdoor")).toBe("running");
  });

  it("maps unknown discipline to other", () => {
    expect(mapFitnessDiscipline("unknown_discipline")).toBe("other");
  });
});

describe("parseWorkout", () => {
  const baseWorkout: PelotonWorkout = {
    id: "workout-001",
    status: "COMPLETE",
    fitness_discipline: "cycling",
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
      instructor: { id: "instr-001", name: "Matt Wilpers" },
    },
  };

  it("parses basic workout fields", () => {
    const parsed = parseWorkout(baseWorkout);
    expect(parsed.externalId).toBe("workout-001");
    expect(parsed.activityType).toBe("cycling");
    expect(parsed.name).toBe("30 min Power Zone Ride");
    expect(parsed.startedAt).toEqual(new Date(1709280000 * 1000));
    expect(parsed.endedAt).toEqual(new Date(1709281800 * 1000));
  });

  it("stores instructor in raw metadata", () => {
    const parsed = parseWorkout(baseWorkout);
    expect(parsed.raw.instructor).toBe("Matt Wilpers");
    expect(parsed.raw.classTitle).toBe("30 min Power Zone Ride");
  });

  it("sets endedAt to undefined when end_time is 0", () => {
    const workout = { ...baseWorkout, end_time: 0 };
    const parsed = parseWorkout(workout);
    expect(parsed.endedAt).toBeUndefined();
  });

  it("handles workout without ride", () => {
    const workout = { ...baseWorkout, ride: undefined };
    const parsed = parseWorkout(workout);
    expect(parsed.name).toBeUndefined();
    expect(parsed.raw.instructor).toBeUndefined();
  });

  it("stores personal record flag in raw", () => {
    const workout = { ...baseWorkout, is_total_work_personal_record: true };
    const parsed = parseWorkout(workout);
    expect(parsed.raw.isPersonalRecord).toBe(true);
  });

  it("omits totalWorkJoules when total_work is 0", () => {
    const workout = { ...baseWorkout, total_work: 0 };
    const parsed = parseWorkout(workout);
    expect(parsed.raw.totalWorkJoules).toBeUndefined();
  });

  it("maps strength discipline", () => {
    const workout = { ...baseWorkout, fitness_discipline: "strength" };
    const parsed = parseWorkout(workout);
    expect(parsed.activityType).toBe("strength");
  });
});

describe("parsePerformanceGraph", () => {
  const graph: PelotonPerformanceGraph = {
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
    ],
  };

  it("maps metrics to series with correct slugs", () => {
    const series = parsePerformanceGraph(graph, 5);
    expect(series).toHaveLength(2);
    expect(series[0]?.slug).toBe("heart_rate");
    expect(series[1]?.slug).toBe("output");
  });

  it("computes offset seconds based on everyN", () => {
    const series = parsePerformanceGraph(graph, 5);
    expect(series[0]?.offsetsSeconds).toEqual([0, 5, 10]);
  });

  it("preserves average and max values", () => {
    const series = parsePerformanceGraph(graph, 5);
    expect(series[0]?.averageValue).toBe(145);
    expect(series[0]?.maxValue).toBe(160);
  });

  it("handles empty metrics array", () => {
    const emptyGraph = { ...graph, metrics: [] };
    const series = parsePerformanceGraph(emptyGraph, 5);
    expect(series).toHaveLength(0);
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
});

describe("PelotonClient — error handling", () => {
  it("throws on non-OK response", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return new Response("Unauthorized", { status: 401 });
    }) as typeof globalThis.fetch;

    const client = new PelotonClient("bad-token", mockFetch);
    await expect(client.getUserId()).rejects.toThrow("Peloton API error (401)");
  });

  it("caches userId after first call", async () => {
    let callCount = 0;
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
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
    }) as typeof globalThis.fetch;

    const client = new PelotonClient("token", mockFetch);
    await client.getUserId();
    await client.getWorkouts(0);

    // /api/me should have been called only once
    expect(callCount).toBe(1);
  });
});

describe("parseAuth0FormHtml", () => {
  it("parses form action and hidden inputs", () => {
    const html = `
      <html>
        <form method="POST" action="https://auth.onepeloton.com/login/callback">
          <input type="hidden" name="wresult" value="jwt-token-here"/>
          <input type="hidden" name="wctx" value="context-value"/>
          <input type="submit" value="Submit"/>
        </form>
      </html>
    `;
    const result = parseAuth0FormHtml(html);
    expect(result.action).toBe("https://auth.onepeloton.com/login/callback");
    expect(result.fields.wresult).toBe("jwt-token-here");
    expect(result.fields.wctx).toBe("context-value");
  });

  it("throws when no form action is found", () => {
    const html = "<html><body>No form here</body></html>";
    expect(() => parseAuth0FormHtml(html)).toThrow("Could not find form action");
  });

  it("handles hidden inputs with empty values", () => {
    const html = `
      <form method="POST" action="https://example.com/callback">
        <input type="hidden" name="state" value=""/>
      </form>
    `;
    const result = parseAuth0FormHtml(html);
    expect(result.fields.state).toBe("");
  });
});
