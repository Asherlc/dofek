import { describe, expect, it } from "vitest";
import {
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
// Extended coverage tests for Peloton provider
// ============================================================

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

describe("parseWorkout — extended edge cases", () => {
  const baseWorkout: PelotonWorkout = {
    id: "workout-edge",
    status: "COMPLETE",
    fitness_discipline: "cycling",
    created_at: 1709280000,
    start_time: 1709280000,
    end_time: 1709281800,
    total_work: 360000,
    is_total_work_personal_record: false,
  };

  it("stores leaderboard stats in raw when present", () => {
    const workout: PelotonWorkout = {
      ...baseWorkout,
      leaderboard_rank: 500,
      total_leaderboard_users: 10000,
      ride: {
        id: "ride-1",
        title: "Test Ride",
        duration: 1800,
      },
    };
    const parsed = parseWorkout(workout);
    expect(parsed.raw.leaderboardRank).toBe(500);
    expect(parsed.raw.totalLeaderboardUsers).toBe(10000);
  });

  it("stores fitness discipline in raw", () => {
    const workout: PelotonWorkout = {
      ...baseWorkout,
      fitness_discipline: "yoga",
    };
    const parsed = parseWorkout(workout);
    expect(parsed.raw.fitnessDiscipline).toBe("yoga");
    expect(parsed.activityType).toBe("yoga");
  });

  it("stores peloton ride ID in raw", () => {
    const workout: PelotonWorkout = {
      ...baseWorkout,
      ride: {
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
      ...baseWorkout,
      ride: {
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

describe("parseAuth0FormHtml — extended", () => {
  it("parses form with multiple hidden inputs mixed with other inputs", () => {
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

describe("pelotonOAuthConfig — detailed", () => {
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

describe("PelotonProvider — provider info", () => {
  it("has correct id and name", () => {
    const provider = new PelotonProvider();
    expect(provider.id).toBe("peloton");
    expect(provider.name).toBe("Peloton");
  });

  it("authSetup authUrl is a string", () => {
    const provider = new PelotonProvider();
    const setup = provider.authSetup();
    expect(typeof setup.authUrl).toBe("string");
    expect(setup.authUrl).toContain("onepeloton.com");
  });
});
