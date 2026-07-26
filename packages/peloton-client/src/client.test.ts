import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
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

    await expect(client.getUserId()).rejects.toBeInstanceOf(PelotonServiceError);
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

    await expect(client.getUserId()).rejects.toBeInstanceOf(ProviderRateLimitError);
  });
});
