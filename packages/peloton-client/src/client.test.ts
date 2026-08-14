import {
  ProviderRateLimitError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { describe, expect, it, vi } from "vitest";
import { PelotonClient } from "./client.ts";
import { PelotonAuthenticationError, PelotonResponseError, PelotonServiceError } from "./errors.ts";

describe("PelotonClient", () => {
  it("sends Peloton bearer and platform headers", async () => {
    const fetchFn = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ id: "user-123" }));

    const client = new PelotonClient("secret", fetchFn);
    await client.getUserId();

    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.onepeloton.com/api/me",
      expect.objectContaining({
        headers: {
          Authorization: "Bearer secret",
          "peloton-platform": "web",
        },
      }),
    );
  });

  it("caches the resolved user ID across workout requests", async () => {
    const fetchFn = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ id: "user-123" }))
      .mockResolvedValueOnce(
        Response.json({
          data: [],
          total: 0,
          count: 0,
          page: 2,
          limit: 50,
          page_count: 0,
          sort_by: "-created_at",
          show_next: false,
          show_previous: true,
        }),
      );

    const client = new PelotonClient("secret", fetchFn);
    await client.getUserId();
    await client.getWorkouts(2, 50);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(String(fetchFn.mock.calls[1]?.[0])).toContain(
      "/api/user/user-123/workouts?page=2&limit=50",
    );
  });

  it("uses a typed authentication error for unauthorized API responses", async () => {
    const client = new PelotonClient("expired", async () => new Response("no", { status: 401 }));

    await expect(client.getUserId()).rejects.toBeInstanceOf(PelotonAuthenticationError);
  });

  it("uses a typed service error for other failed API responses", async () => {
    const client = new PelotonClient("secret", async () => new Response("gone", { status: 404 }));

    const error = await client.getUserId().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PelotonServiceError);
    expect(error).not.toBeInstanceOf(PelotonAuthenticationError);
    expect(error).toMatchObject({ statusCode: 404, responseBody: "gone" });
  });

  it("validates successful API responses with Zod", async () => {
    const client = new PelotonClient("secret", async () => Response.json({ user_id: 123 }));

    await expect(client.getUserId()).rejects.toBeInstanceOf(PelotonResponseError);
  });

  it("uses provider-http rate-limit handling", async () => {
    const client = new PelotonClient(
      "secret",
      async () => new Response("slow down", { status: 429 }),
    );

    const error = await client.getUserId().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error).toMatchObject({ providerId: "peloton", statusCode: 429 });
  });

  it("uses provider-http service-unavailable handling", async () => {
    const client = new PelotonClient(
      "secret",
      async () => new Response("offline", { status: 503 }),
    );

    await expect(client.getUserId()).rejects.toBeInstanceOf(ProviderServiceUnavailableError);
  });

  it("validates workout responses and preserves upstream errors", async () => {
    const responses = [Response.json({ id: "user-123" }), Response.json({ invalid: true })];
    const client = new PelotonClient("secret", async () => responses.shift() ?? Response.error());
    await expect(client.getWorkouts()).rejects.toBeInstanceOf(PelotonResponseError);

    const unauthorized = new PelotonClient("secret", async (input) =>
      String(input).endsWith("/api/me")
        ? Response.json({ id: "user-123" })
        : new Response("expired", { status: 401 }),
    );
    await expect(unauthorized.getWorkouts()).rejects.toBeInstanceOf(PelotonAuthenticationError);

    const unavailable = new PelotonClient("secret", async (input) =>
      String(input).endsWith("/api/me")
        ? Response.json({ id: "user-123" })
        : new Response("gone", { status: 404 }),
    );
    await expect(unavailable.getWorkouts()).rejects.toBeInstanceOf(PelotonServiceError);
  });

  it("accepts observed nullable workout fields and missing instructor IDs", async () => {
    const response = {
      data: [
        {
          id: "workout-1",
          status: "COMPLETE",
          fitness_discipline: "cycling",
          title: null,
          created_at: 1_709_280_000,
          start_time: 1_709_280_000,
          end_time: null,
          total_work: null,
          is_total_work_personal_record: false,
          metrics_type: null,
          peloton_id: null,
          strava_id: null,
          ride: {
            id: "ride-1",
            title: "Recovery Ride",
            duration: 1_800,
            instructor: { name: "Coach" },
          },
        },
      ],
      total: 1,
      count: 1,
      page: 0,
      limit: 20,
      page_count: 1,
      sort_by: "-created_at",
      show_next: false,
      show_previous: false,
    };
    const responses = [Response.json({ id: "user-123" }), Response.json(response)];
    const client = new PelotonClient("secret", async () => responses.shift() ?? Response.error());

    await expect(client.getWorkouts()).resolves.toEqual(response);
  });

  it("accepts workouts where Peloton omits total work", async () => {
    const response = {
      data: [
        {
          id: "workout-2",
          status: "COMPLETE",
          fitness_discipline: "strength",
          created_at: 1_709_280_000,
          start_time: 1_709_280_000,
          end_time: 1_709_281_800,
          is_total_work_personal_record: false,
        },
      ],
      total: 1,
      count: 1,
      page: 0,
      limit: 20,
      page_count: 1,
      sort_by: "-created_at",
      show_next: false,
      show_previous: false,
    };
    const responses = [Response.json({ id: "user-123" }), Response.json(response)];
    const client = new PelotonClient("secret", async () => responses.shift() ?? Response.error());

    await expect(client.getWorkouts()).resolves.toEqual(response);
  });

  it("accepts numeric performance summaries (DOFEK-SERVER-5F)", async () => {
    const graph = {
      duration: 5,
      is_class_plan_shown: false,
      segment_list: [],
      average_summaries: [
        {
          display_name: "Avg Output",
          value: 118,
          slug: "avg_output",
        },
      ],
      summaries: [
        {
          display_name: "Total Output",
          value: 450,
          slug: "total_output",
        },
      ],
      metrics: [],
    };
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(graph));
    const client = new PelotonClient("secret", fetchFn);

    await expect(client.getPerformanceGraph("workout-1", 10)).resolves.toEqual(graph);
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain(
      "/api/workout/workout-1/performance_graph?every_n=10",
    );
  });

  it("validates performance graph errors", async () => {
    const malformed = new PelotonClient("secret", async () => Response.json({ invalid: true }));
    await expect(malformed.getPerformanceGraph("workout-1")).rejects.toBeInstanceOf(
      PelotonResponseError,
    );

    const unauthorized = new PelotonClient(
      "secret",
      async () => new Response("expired", { status: 401 }),
    );
    await expect(unauthorized.getPerformanceGraph("workout-1")).rejects.toBeInstanceOf(
      PelotonAuthenticationError,
    );

    const unavailable = new PelotonClient(
      "secret",
      async () => new Response("gone", { status: 404 }),
    );
    await expect(unavailable.getPerformanceGraph("workout-1")).rejects.toBeInstanceOf(
      PelotonServiceError,
    );
  });
});
