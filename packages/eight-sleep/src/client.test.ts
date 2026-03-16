import { describe, expect, it } from "vitest";
import { EIGHT_SLEEP_CLIENT_ID, EIGHT_SLEEP_CLIENT_SECRET, EightSleepClient } from "./client.ts";
import { createMockFetch } from "./test-helpers.ts";
import type { EightSleepAuthResponse, EightSleepTrendsResponse } from "./types.ts";

describe("EightSleepClient constants", () => {
  it("exports EIGHT_SLEEP_CLIENT_ID as a non-empty string", () => {
    expect(EIGHT_SLEEP_CLIENT_ID).toBeTruthy();
    expect(typeof EIGHT_SLEEP_CLIENT_ID).toBe("string");
  });

  it("exports EIGHT_SLEEP_CLIENT_SECRET as a non-empty string", () => {
    expect(EIGHT_SLEEP_CLIENT_SECRET).toBeTruthy();
    expect(typeof EIGHT_SLEEP_CLIENT_SECRET).toBe("string");
  });
});

describe("EightSleepClient.signIn", () => {
  it("returns accessToken, expiresIn, and userId on success", async () => {
    const authResponse: EightSleepAuthResponse = {
      access_token: "test-access-token",
      expires_in: 3600,
      userId: "user-123",
    };

    const fetchFn = createMockFetch({ status: 200, ok: true, body: authResponse });

    const result = await EightSleepClient.signIn("test@example.com", "password123", fetchFn);

    expect(result).toEqual({
      accessToken: "test-access-token",
      expiresIn: 3600,
      userId: "user-123",
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, options] = fetchFn.mock.calls[0];
    expect(url).toBe("https://auth-api.8slp.net/v1/tokens");
    expect(options?.method).toBe("POST");
    const body: Record<string, string> = JSON.parse(String(options?.body));
    expect(body.client_id).toBe(EIGHT_SLEEP_CLIENT_ID);
    expect(body.client_secret).toBe(EIGHT_SLEEP_CLIENT_SECRET);
    expect(body.grant_type).toBe("password");
    expect(body.username).toBe("test@example.com");
    expect(body.password).toBe("password123");
  });

  it("throws on non-200 response", async () => {
    const fetchFn = createMockFetch({ status: 401, ok: false, body: "Unauthorized" });

    await expect(
      EightSleepClient.signIn("test@example.com", "wrong-password", fetchFn),
    ).rejects.toThrow("Eight Sleep sign-in failed (401)");
  });
});

describe("EightSleepClient.getTrends", () => {
  it("returns trends data on success", async () => {
    const trendsResponse: EightSleepTrendsResponse = {
      days: [
        {
          day: "2024-01-01",
          score: 85,
          tnt: 3,
          processing: false,
          presenceDuration: 28800,
          sleepDuration: 25200,
          lightDuration: 10000,
          deepDuration: 8000,
          remDuration: 7200,
          latencyAsleepSeconds: 600,
          latencyOutSeconds: 300,
          presenceStart: "2024-01-01T22:00:00Z",
          presenceEnd: "2024-01-02T06:00:00Z",
        },
      ],
    };

    const fetchFn = createMockFetch({ status: 200, ok: true, body: trendsResponse });
    const client = new EightSleepClient("test-token", "user-123", fetchFn);

    const result = await client.getTrends("America/New_York", "2024-01-01", "2024-01-02");

    expect(result).toEqual(trendsResponse);
    expect(fetchFn).toHaveBeenCalledOnce();

    const [url, options] = fetchFn.mock.calls[0];
    expect(url).toContain("https://client-api.8slp.net/v1/users/user-123/trends");
    expect(url).toContain("tz=America%2FNew_York");
    expect(url).toContain("from=2024-01-01");
    expect(url).toContain("to=2024-01-02");
    expect(url).toContain("include-main=false");
    expect(url).toContain("include-all-sessions=true");
    expect(url).toContain("model-version=v2");
    const headers = new Headers(options?.headers);
    expect(headers.get("Authorization")).toBe("Bearer test-token");
  });

  it("throws on non-200 response", async () => {
    const fetchFn = createMockFetch({ status: 500, ok: false, body: "Internal Server Error" });
    const client = new EightSleepClient("test-token", "user-123", fetchFn);

    await expect(client.getTrends("America/New_York", "2024-01-01", "2024-01-02")).rejects.toThrow(
      "Eight Sleep API error (500)",
    );
  });
});
