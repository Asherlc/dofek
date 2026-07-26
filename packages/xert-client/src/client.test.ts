import {
  ProviderRateLimitError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import {
  DEFAULT_XERT_CLIENT_CREDENTIALS,
  refreshXertToken,
  signInToXert,
  XertApiError,
  XertAuthenticationError,
  XertClient,
} from "./client.ts";

type MockFetch = ReturnType<typeof vi.fn<typeof globalThis.fetch>> & typeof globalThis.fetch;

function responseFetch(body: unknown, status = 200): MockFetch {
  const fetchFn = vi.fn<typeof globalThis.fetch>();
  fetchFn.mockResolvedValue(
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
  );
  return fetchFn;
}

describe("signInToXert", () => {
  it("uses the observed public client credentials by default", async () => {
    const fetchFn = responseFetch({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
      token_type: "Bearer",
    });

    const token = await signInToXert("rider@example.com", "secret", fetchFn);

    const init = fetchFn.mock.calls[0]?.[1];
    expect(fetchFn.mock.calls[0]?.[0]).toBe("https://www.xertonline.com/oauth/token");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      `Basic ${btoa(
        `${DEFAULT_XERT_CLIENT_CREDENTIALS.clientId}:${DEFAULT_XERT_CLIENT_CREDENTIALS.clientSecret}`,
      )}`,
    );
    expect(new URLSearchParams(String(init?.body))).toEqual(
      new URLSearchParams({
        grant_type: "password",
        username: "rider@example.com",
        password: "secret",
      }),
    );
    expect(token.accessToken).toBe("access");
    expect(token.refreshToken).toBe("refresh");
    expect(token.expiresAt).toBeInstanceOf(Date);
  });

  it("accepts explicit client credentials without reading environment variables", async () => {
    const fetchFn = responseFetch({ access_token: "access", expires_in: 60 });

    await signInToXert("rider@example.com", "secret", fetchFn, {
      clientId: "custom-client",
      clientSecret: "custom-secret",
    });

    expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      `Basic ${btoa("custom-client:custom-secret")}`,
    );
  });

  it("throws a typed authentication error for rejected credentials", async () => {
    const error = await signInToXert(
      "rider@example.com",
      "wrong",
      responseFetch("invalid credentials", 401),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(XertAuthenticationError);
    expect(error).toMatchObject({ statusCode: 401, responseBody: "invalid credentials" });
  });

  it("validates token responses at runtime", async () => {
    await expect(
      signInToXert("rider@example.com", "secret", responseFetch({ expires_in: "3600" })),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("preserves provider-http rate-limit errors", async () => {
    const error = await signInToXert(
      "rider@example.com",
      "secret",
      responseFetch("slow down", 429),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error).toHaveProperty("providerId", "xert");
  });
});

describe("refreshXertToken", () => {
  it("uses the refresh-token grant and retains a non-rotated refresh token", async () => {
    const fetchFn = responseFetch({ access_token: "new-access", expires_in: 7200 });

    const token = await refreshXertToken("original-refresh", fetchFn);

    expect(new URLSearchParams(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "original-refresh",
      }),
    );
    expect(token).toMatchObject({
      accessToken: "new-access",
      refreshToken: "original-refresh",
    });
  });

  it("uses a rotated refresh token when returned", async () => {
    const token = await refreshXertToken(
      "original-refresh",
      responseFetch({
        access_token: "new-access",
        refresh_token: "rotated-refresh",
        expires_in: 7200,
      }),
    );

    expect(token.refreshToken).toBe("rotated-refresh");
  });
});

describe("XertClient", () => {
  it("lists a validated page of activities with bearer authentication", async () => {
    const fetchFn = responseFetch([
      {
        id: 42,
        name: "Morning Ride",
        sport: "Cycling",
        startTimestamp: 1_709_290_800,
        endTimestamp: 1_709_294_400,
        duration: 3600,
        distance: 30_000,
        power_avg: 200,
        power_max: 450,
        power_normalized: 220,
        heartrate_avg: 145,
        heartrate_max: 175,
        cadence_avg: 85,
        cadence_max: 110,
        elevation_gain: 300,
        elevation_loss: 280,
        xss: 85,
        focus: 120,
        difficulty: 3,
      },
    ]);
    const client = new XertClient("access-token", fetchFn);

    const activities = await client.listActivities({
      from: 1_709_000_000,
      page: 2,
      limit: 25,
    });

    expect(activities).toHaveLength(1);
    const requestUrl = new URL(String(fetchFn.mock.calls[0]?.[0]));
    expect(requestUrl.pathname).toBe("/oauth/activity/");
    expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
      from: "1709000000",
      page: "2",
      limit: "25",
    });
    expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer access-token",
    );
  });

  it("validates activity pages at runtime", async () => {
    const client = new XertClient(
      "access-token",
      responseFetch([{ id: "not-a-number", name: "Invalid" }]),
    );

    await expect(client.listActivities({ from: 0 })).rejects.toBeInstanceOf(ZodError);
  });

  it("throws a typed API error for unsuccessful activity requests", async () => {
    const client = new XertClient("access-token", responseFetch("unauthorized", 401));

    const error = await client.listActivities({ from: 0 }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(XertApiError);
    expect(error).toMatchObject({ statusCode: 401, responseBody: "unauthorized" });
  });

  it("preserves provider-http service availability errors", async () => {
    const client = new XertClient("access-token", responseFetch("offline", 503));

    const error = await client.listActivities({ from: 0 }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderServiceUnavailableError);
    expect(error).toHaveProperty("providerId", "xert");
  });
});
