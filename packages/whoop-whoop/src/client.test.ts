import { describe, expect, it, vi } from "vitest";
import { WhoopClient, WhoopRateLimitError } from "./client.ts";
import { createMockFetch, createMockResponse, createTypedMockFetch } from "./test-helpers.ts";
import type { WhoopAuthToken } from "./types.ts";

function makeToken(overrides: Partial<WhoopAuthToken> = {}): WhoopAuthToken {
  return {
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    userId: 12345,
    ...overrides,
  };
}

// ============================================================
// WhoopClient constructor
// ============================================================

describe("WhoopClient constructor", () => {
  it("creates a client with the given token", () => {
    const token = makeToken();
    const client = new WhoopClient(token);
    expect(client).toBeInstanceOf(WhoopClient);
  });
});

// ============================================================
// WhoopClient.signIn
// ============================================================

describe("WhoopClient.signIn", () => {
  it("returns success with token when no MFA", async () => {
    const callCount = { value: 0 };

    const fetchFn = createTypedMockFetch();
    fetchFn.mockImplementation(() => {
      callCount.value++;

      // First call: InitiateAuth
      if (callCount.value === 1) {
        return Promise.resolve(
          createMockResponse({
            body: {
              AuthenticationResult: {
                AccessToken: "whoop-access-123",
                RefreshToken: "whoop-refresh-456",
                IdToken: "id-token",
              },
            },
          }),
        );
      }

      // Second call: _fetchUserId (bootstrap)
      return Promise.resolve(createMockResponse({ body: { user: { id: 999 } } }));
    });

    const result = await WhoopClient.signIn("user@example.com", "password123", fetchFn);

    expect(result.type).toBe("success");
    if (result.type === "success") {
      expect(result.token.accessToken).toBe("whoop-access-123");
      expect(result.token.refreshToken).toBe("whoop-refresh-456");
      expect(result.token.userId).toBe(999);
    }
  });

  it("returns verification_required when MFA challenge (SMS)", async () => {
    const fetchFn = createMockFetch({
      ok: true,
      status: 200,
      body: { ChallengeName: "SMS_MFA", Session: "session-abc" },
    });

    const result = await WhoopClient.signIn("user@example.com", "password123", fetchFn);

    expect(result.type).toBe("verification_required");
    if (result.type === "verification_required") {
      expect(result.session).toBe("session-abc");
      expect(result.method).toBe("sms");
    }
  });

  it("returns verification_required when MFA challenge (TOTP)", async () => {
    const fetchFn = createMockFetch({
      ok: true,
      status: 200,
      body: { ChallengeName: "SOFTWARE_TOKEN_MFA", Session: "session-xyz" },
    });

    const result = await WhoopClient.signIn("user@example.com", "password123", fetchFn);

    expect(result.type).toBe("verification_required");
    if (result.type === "verification_required") {
      expect(result.method).toBe("totp");
    }
  });

  it("throws when no tokens in response and no challenge", async () => {
    const fetchFn = createMockFetch({ ok: true, status: 200, body: {} });

    await expect(WhoopClient.signIn("user@example.com", "password123", fetchFn)).rejects.toThrow(
      "no tokens in response",
    );
  });

  it("throws when userId cannot be fetched", async () => {
    const callCount = { value: 0 };

    const fetchFn = createTypedMockFetch();
    fetchFn.mockImplementation(() => {
      callCount.value++;
      if (callCount.value === 1) {
        return Promise.resolve(
          createMockResponse({
            body: {
              AuthenticationResult: {
                AccessToken: "token",
                RefreshToken: "refresh",
              },
            },
          }),
        );
      }
      // Bootstrap fails
      return Promise.resolve(createMockResponse({ ok: false, status: 500, body: {} }));
    });

    await expect(WhoopClient.signIn("user@example.com", "password123", fetchFn)).rejects.toThrow(
      "could not determine user ID",
    );
  });

  it("throws on Cognito error response", async () => {
    const fetchFn = createMockFetch({
      ok: false,
      status: 400,
      body: {
        __type: "com.amazonaws.cognito#NotAuthorizedException",
        message: "Incorrect username or password.",
      },
    });

    await expect(WhoopClient.signIn("user@example.com", "bad-password", fetchFn)).rejects.toThrow(
      "NotAuthorizedException: Incorrect username or password.",
    );
  });

  it("throws on non-JSON error response", async () => {
    const fetchFn = createMockFetch({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      body: "not json",
    });

    await expect(WhoopClient.signIn("user@example.com", "password", fetchFn)).rejects.toThrow(
      "WHOOP auth failed (500)",
    );
  });
});

// ============================================================
// WhoopClient.verifyCode
// ============================================================

describe("WhoopClient.verifyCode", () => {
  it("returns token on successful SMS verification", async () => {
    const callCount = { value: 0 };

    const fetchFn = createTypedMockFetch();
    fetchFn.mockImplementation(() => {
      callCount.value++;
      if (callCount.value === 1) {
        // SMS_MFA challenge response
        return Promise.resolve(
          createMockResponse({
            body: {
              AuthenticationResult: {
                AccessToken: "verified-token",
                RefreshToken: "verified-refresh",
              },
            },
          }),
        );
      }
      // Bootstrap to get userId
      return Promise.resolve(createMockResponse({ body: { id: 42 } }));
    });

    const result = await WhoopClient.verifyCode(
      "session-123",
      "123456",
      "user@example.com",
      fetchFn,
    );

    expect(result.accessToken).toBe("verified-token");
    expect(result.refreshToken).toBe("verified-refresh");
    expect(result.userId).toBe(42);
  });

  it("falls back to SOFTWARE_TOKEN_MFA when SMS_MFA fails", async () => {
    const callCount = { value: 0 };

    const fetchFn = createTypedMockFetch();
    fetchFn.mockImplementation(() => {
      callCount.value++;
      if (callCount.value === 1) {
        // SMS_MFA fails
        return Promise.resolve(
          createMockResponse({
            ok: false,
            status: 400,
            body: {
              __type: "com.amazonaws.cognito#CodeMismatchException",
              message: "Invalid code",
            },
          }),
        );
      }
      if (callCount.value === 2) {
        // SOFTWARE_TOKEN_MFA succeeds
        return Promise.resolve(
          createMockResponse({
            body: {
              AuthenticationResult: {
                AccessToken: "totp-token",
                RefreshToken: "totp-refresh",
              },
            },
          }),
        );
      }
      // Bootstrap
      return Promise.resolve(createMockResponse({ body: { user_id: 55 } }));
    });

    const result = await WhoopClient.verifyCode(
      "session-123",
      "654321",
      "user@example.com",
      fetchFn,
    );

    expect(result.accessToken).toBe("totp-token");
    expect(result.userId).toBe(55);
  });

  it("throws when no tokens in verification response", async () => {
    const fetchFn = createMockFetch({ ok: true, status: 200, body: {} });

    await expect(
      WhoopClient.verifyCode("session-123", "123456", "user@example.com", fetchFn),
    ).rejects.toThrow("no tokens in response");
  });

  it("throws when userId cannot be determined after verification", async () => {
    const callCount = { value: 0 };

    const fetchFn = createTypedMockFetch();
    fetchFn.mockImplementation(() => {
      callCount.value++;
      if (callCount.value === 1) {
        return Promise.resolve(
          createMockResponse({
            body: {
              AuthenticationResult: {
                AccessToken: "token",
                RefreshToken: "refresh",
              },
            },
          }),
        );
      }
      // Bootstrap returns no userId
      return Promise.resolve(createMockResponse({ body: { foo: "bar" } }));
    });

    await expect(
      WhoopClient.verifyCode("session-123", "123456", "user@example.com", fetchFn),
    ).rejects.toThrow("could not determine user ID");
  });
});

// ============================================================
// WhoopClient.refreshAccessToken
// ============================================================

describe("WhoopClient.refreshAccessToken", () => {
  it("returns refreshed tokens with userId", async () => {
    const callCount = { value: 0 };

    const fetchFn = createTypedMockFetch();
    fetchFn.mockImplementation(() => {
      callCount.value++;
      if (callCount.value === 1) {
        return Promise.resolve(
          createMockResponse({
            body: {
              AuthenticationResult: {
                AccessToken: "new-access",
                RefreshToken: "new-refresh",
              },
            },
          }),
        );
      }
      // Bootstrap
      return Promise.resolve(createMockResponse({ body: { id: 77 } }));
    });

    const result = await WhoopClient.refreshAccessToken("old-refresh-token", fetchFn);

    expect(result.accessToken).toBe("new-access");
    expect(result.refreshToken).toBe("new-refresh");
    expect(result.userId).toBe(77);
  });

  it("reuses old refresh token when Cognito does not return new one", async () => {
    const callCount = { value: 0 };

    const fetchFn = createTypedMockFetch();
    fetchFn.mockImplementation(() => {
      callCount.value++;
      if (callCount.value === 1) {
        return Promise.resolve(
          createMockResponse({
            body: {
              AuthenticationResult: {
                AccessToken: "new-access",
                // No RefreshToken
              },
            },
          }),
        );
      }
      return Promise.resolve(createMockResponse({ body: { id: 88 } }));
    });

    const result = await WhoopClient.refreshAccessToken("keep-this-refresh", fetchFn);

    expect(result.refreshToken).toBe("keep-this-refresh");
  });

  it("returns null userId when bootstrap fails", async () => {
    const callCount = { value: 0 };

    const fetchFn = createTypedMockFetch();
    fetchFn.mockImplementation(() => {
      callCount.value++;
      if (callCount.value === 1) {
        return Promise.resolve(
          createMockResponse({
            body: {
              AuthenticationResult: {
                AccessToken: "new-access",
              },
            },
          }),
        );
      }
      // Bootstrap fails
      return Promise.resolve(createMockResponse({ ok: false, status: 500, body: {} }));
    });

    const result = await WhoopClient.refreshAccessToken("refresh-token", fetchFn);

    expect(result.userId).toBeNull();
  });

  it("throws when no tokens in refresh response", async () => {
    const fetchFn = createMockFetch({ ok: true, status: 200, body: {} });

    await expect(WhoopClient.refreshAccessToken("refresh-token", fetchFn)).rejects.toThrow(
      "no tokens in response",
    );
  });
});

// ============================================================
// WhoopClient.authenticate
// ============================================================

describe("WhoopClient.authenticate", () => {
  it("returns token directly when no MFA", async () => {
    const callCount = { value: 0 };

    const fetchFn = createTypedMockFetch();
    fetchFn.mockImplementation(() => {
      callCount.value++;
      if (callCount.value === 1) {
        return Promise.resolve(
          createMockResponse({
            body: {
              AuthenticationResult: {
                AccessToken: "access",
                RefreshToken: "refresh",
              },
            },
          }),
        );
      }
      return Promise.resolve(createMockResponse({ body: { id: 100 } }));
    });

    const token = await WhoopClient.authenticate("user@example.com", "password", fetchFn);

    expect(token.accessToken).toBe("access");
    expect(token.userId).toBe(100);
  });

  it("throws when MFA is required", async () => {
    const fetchFn = createMockFetch({
      ok: true,
      status: 200,
      body: { ChallengeName: "SMS_MFA", Session: "session-abc" },
    });

    await expect(WhoopClient.authenticate("user@example.com", "password", fetchFn)).rejects.toThrow(
      "requires MFA",
    );
  });
});

// ============================================================
// WhoopClient._fetchUserId
// ============================================================

describe("WhoopClient._fetchUserId", () => {
  it("returns id from top-level id field", async () => {
    const fetchFn = createMockFetch({ status: 200, ok: true, body: { id: 42 } });
    const result = await WhoopClient._fetchUserId("token", fetchFn);
    expect(result).toBe(42);
  });

  it("returns id from top-level user_id field", async () => {
    const fetchFn = createMockFetch({ status: 200, ok: true, body: { user_id: 55 } });
    const result = await WhoopClient._fetchUserId("token", fetchFn);
    expect(result).toBe(55);
  });

  it("returns id from nested user.id field", async () => {
    const fetchFn = createMockFetch({ status: 200, ok: true, body: { user: { id: 66 } } });
    const result = await WhoopClient._fetchUserId("token", fetchFn);
    expect(result).toBe(66);
  });

  it("returns id from nested user.user_id field", async () => {
    const fetchFn = createMockFetch({
      status: 200,
      ok: true,
      body: { user: { user_id: 77 } },
    });
    const result = await WhoopClient._fetchUserId("token", fetchFn);
    expect(result).toBe(77);
  });

  it("returns null when response is not ok", async () => {
    const fetchFn = createMockFetch({ status: 500, ok: false, body: {} });
    const result = await WhoopClient._fetchUserId("token", fetchFn);
    expect(result).toBeNull();
  });

  it("returns null when no valid userId in response", async () => {
    const fetchFn = createMockFetch({ status: 200, ok: true, body: { foo: "bar" } });
    const result = await WhoopClient._fetchUserId("token", fetchFn);
    expect(result).toBeNull();
  });

  it("returns null when userId is not a number", async () => {
    const fetchFn = createMockFetch({
      status: 200,
      ok: true,
      body: { id: "not-a-number" },
    });
    const result = await WhoopClient._fetchUserId("token", fetchFn);
    expect(result).toBeNull();
  });
});

// ============================================================
// WhoopClient instance methods
// ============================================================

describe("WhoopClient.getHeartRate", () => {
  it("returns heart rate values", async () => {
    const hrValues = [
      { time: 1700000000000, data: 72 },
      { time: 1700000006000, data: 75 },
    ];

    const fetchFn = createMockFetch({ status: 200, ok: true, body: { values: hrValues } });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getHeartRate("2024-01-15T00:00:00Z", "2024-01-15T23:59:59Z");

    expect(result).toEqual(hrValues);
    const [url] = fetchFn.mock.calls[0];
    expect(String(url)).toContain("/metrics-service/v1/metrics/user/12345");
    expect(String(url)).toContain("name=heart_rate");
    expect(String(url)).toContain("step=6");
  });

  it("returns empty array when no values", async () => {
    const fetchFn = createMockFetch({ status: 200, ok: true, body: {} });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getHeartRate("2024-01-15T00:00:00Z", "2024-01-15T23:59:59Z");

    expect(result).toEqual([]);
  });

  it("uses custom step parameter", async () => {
    const fetchFn = createMockFetch({ status: 200, ok: true, body: { values: [] } });
    const client = new WhoopClient(makeToken(), fetchFn);

    await client.getHeartRate("2024-01-15T00:00:00Z", "2024-01-15T23:59:59Z", 60);

    const [url] = fetchFn.mock.calls[0];
    expect(String(url)).toContain("step=60");
  });
});

describe("WhoopClient.getCycles", () => {
  it("returns cycles from array response", async () => {
    const cycles = [{ id: 1, user_id: 12345 }];
    const fetchFn = createMockFetch({ status: 200, ok: true, body: cycles });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getCycles("2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z");

    expect(result).toEqual(cycles);
  });

  it("returns cycles from wrapped response with cycles key", async () => {
    const cycles = [{ id: 2 }];
    const fetchFn = createMockFetch({ status: 200, ok: true, body: { cycles } });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getCycles("2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z");

    expect(result).toEqual(cycles);
  });

  it("returns cycles from wrapped response with records key", async () => {
    const records = [{ id: 3 }];
    const fetchFn = createMockFetch({ status: 200, ok: true, body: { records } });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getCycles("2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z");

    expect(result).toEqual(records);
  });

  it("returns cycles from wrapped response with data key", async () => {
    const data = [{ id: 4 }];
    const fetchFn = createMockFetch({ status: 200, ok: true, body: { data } });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getCycles("2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z");

    expect(result).toEqual(data);
  });

  it("returns cycles from wrapped response with results key", async () => {
    const results = [{ id: 5 }];
    const fetchFn = createMockFetch({ status: 200, ok: true, body: { results } });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getCycles("2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z");

    expect(result).toEqual(results);
  });

  it("throws when response is object without recognizable cycle data", async () => {
    const fetchFn = createMockFetch({ status: 200, ok: true, body: { unknown: "value" } });
    const client = new WhoopClient(makeToken(), fetchFn);

    await expect(client.getCycles("2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z")).rejects.toThrow(
      "Unrecognized WHOOP cycles response",
    );
  });

  it("throws when response is null/primitive", async () => {
    const fetchFn = createMockFetch({ status: 200, ok: true, body: null });
    const client = new WhoopClient(makeToken(), fetchFn);

    await expect(client.getCycles("2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z")).rejects.toThrow(
      "Unrecognized WHOOP cycles response",
    );
  });

  it("extracts cycles from any array-valued key in wrapped response", async () => {
    const items = [{ id: 10, user_id: 12345 }];
    const fetchFn = createMockFetch({
      status: 200,
      ok: true,
      body: { someNewKey: items },
    });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getCycles("2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z");

    expect(result).toEqual(items);
  });

  it("uses default limit parameter", async () => {
    const fetchFn = createMockFetch({ status: 200, ok: true, body: [] });
    const client = new WhoopClient(makeToken(), fetchFn);

    await client.getCycles("2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z");

    const [url] = fetchFn.mock.calls[0];
    expect(String(url)).toContain("limit=26");
  });

  it("uses custom limit parameter", async () => {
    const fetchFn = createMockFetch({ status: 200, ok: true, body: [] });
    const client = new WhoopClient(makeToken(), fetchFn);

    await client.getCycles("2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z", 50);

    const [url] = fetchFn.mock.calls[0];
    expect(String(url)).toContain("limit=50");
  });
});

describe("WhoopClient.getSleep", () => {
  it("returns sleep record", async () => {
    const sleepRecord = {
      id: 1001,
      user_id: 12345,
      created_at: "2024-01-15T08:00:00Z",
      updated_at: "2024-01-15T08:00:00Z",
      start: "2024-01-14T22:00:00Z",
      end: "2024-01-15T06:00:00Z",
      timezone_offset: "-05:00",
      nap: false,
      score_state: "SCORED",
    };

    const fetchFn = createMockFetch({ status: 200, ok: true, body: sleepRecord });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getSleep(1001);

    expect(result).toEqual(sleepRecord);
    const [url] = fetchFn.mock.calls[0];
    expect(String(url)).toContain("/sleep-service/v1/sleep-events");
    expect(String(url)).toContain("activityId=1001");
  });
});

describe("WhoopClient.getJournal", () => {
  it("returns journal data", async () => {
    const journalData = { impacts: [] };

    const fetchFn = createMockFetch({ status: 200, ok: true, body: journalData });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getJournal("2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z");

    expect(result).toEqual(journalData);
    const [url] = fetchFn.mock.calls[0];
    expect(String(url)).toContain("/behavior-impact-service/v1/impact");
  });
});

describe("WhoopClient.getWeightliftingWorkout", () => {
  it("returns weightlifting workout data", async () => {
    const workoutData = {
      activity_id: "abc-123",
      zone_durations: {},
      workout_groups: [],
      total_effective_volume_kg: 1500,
      raw_msk_strain_score: 5.2,
      scaled_msk_strain_score: 6.1,
      cardio_strain_score: 3.4,
      cardio_strain_contribution_percent: 40,
      msk_strain_contribution_percent: 60,
    };

    const fetchFn = createMockFetch({ status: 200, ok: true, body: workoutData });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getWeightliftingWorkout("abc-123");

    expect(result).toEqual(workoutData);
    const [url] = fetchFn.mock.calls[0];
    expect(String(url)).toContain("/weightlifting-service/v2/weightlifting-workout/abc-123");
  });

  it("returns null on 404", async () => {
    const fetchFn = createMockFetch({ ok: false, status: 404, body: "" });

    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getWeightliftingWorkout("nonexistent");

    expect(result).toBeNull();
  });

  it("throws on non-404 error", async () => {
    const fetchFn = createMockFetch({
      ok: false,
      status: 500,
      body: "Server Error",
    });

    const client = new WhoopClient(makeToken(), fetchFn);

    await expect(client.getWeightliftingWorkout("abc-123")).rejects.toThrow(
      "WHOOP weightlifting API error (500)",
    );
  });
});

describe("WhoopClient API error handling", () => {
  it("throws on non-200 response from get method", async () => {
    const fetchFn = createMockFetch({
      ok: false,
      status: 403,
      body: "Forbidden",
    });

    const client = new WhoopClient(makeToken(), fetchFn);

    await expect(
      client.getHeartRate("2024-01-15T00:00:00Z", "2024-01-15T23:59:59Z"),
    ).rejects.toThrow("WHOOP API error (403): Forbidden");
  });
});

// ============================================================
// Rate limit retry behavior
// ============================================================

describe("WhoopClient rate limit retry", () => {
  it("retries on 429 and succeeds on second attempt", async () => {
    vi.useFakeTimers();
    const callCount = { value: 0 };

    const fetchFn = createTypedMockFetch();
    fetchFn.mockImplementation(() => {
      callCount.value++;
      if (callCount.value === 1) {
        return Promise.resolve(
          createMockResponse({ ok: false, status: 429, body: "Rate Limit Exceeded" }),
        );
      }
      return Promise.resolve(createMockResponse({ body: { values: [{ time: 1, data: 72 }] } }));
    });

    const client = new WhoopClient(makeToken(), fetchFn);
    const resultPromise = client.getHeartRate("2024-01-15T00:00:00Z", "2024-01-15T23:59:59Z");

    // Advance past the first retry delay
    await vi.advanceTimersByTimeAsync(2000);

    const result = await resultPromise;
    expect(result).toEqual([{ time: 1, data: 72 }]);
    expect(callCount.value).toBe(2);

    vi.useRealTimers();
  });

  it("respects Retry-After header when present", async () => {
    vi.useFakeTimers();
    const callCount = { value: 0 };

    const fetchFn = createTypedMockFetch();
    fetchFn.mockImplementation(() => {
      callCount.value++;
      if (callCount.value === 1) {
        const response = createMockResponse({
          ok: false,
          status: 429,
          body: "Rate Limit Exceeded",
        });
        response.headers.set("Retry-After", "5");
        return Promise.resolve(response);
      }
      return Promise.resolve(createMockResponse({ body: { values: [] } }));
    });

    const client = new WhoopClient(makeToken(), fetchFn);
    const resultPromise = client.getHeartRate("2024-01-15T00:00:00Z", "2024-01-15T23:59:59Z");

    // Should not have retried yet at 4s (Retry-After is 5s)
    await vi.advanceTimersByTimeAsync(4000);
    expect(callCount.value).toBe(1);

    // Advance past the 5s Retry-After
    await vi.advanceTimersByTimeAsync(2000);

    const result = await resultPromise;
    expect(result).toEqual([]);
    expect(callCount.value).toBe(2);

    vi.useRealTimers();
  });

  it("throws WhoopRateLimitError after exhausting retries", async () => {
    vi.useFakeTimers();
    const fetchFn = createMockFetch({
      ok: false,
      status: 429,
      body: "Rate Limit Exceeded",
    });

    const client = new WhoopClient(makeToken(), fetchFn);
    const resultPromise = client
      .getHeartRate("2024-01-15T00:00:00Z", "2024-01-15T23:59:59Z")
      .catch((error: unknown) => error);

    // Advance through all retry delays (1s + 2s + 4s = 7s with 3 retries)
    await vi.advanceTimersByTimeAsync(30_000);

    const error = await resultPromise;
    expect(error).toBeInstanceOf(WhoopRateLimitError);
    if (error instanceof WhoopRateLimitError) {
      expect(error.message).toContain("429");
    }
    // Initial call + 3 retries = 4 total calls
    expect(fetchFn).toHaveBeenCalledTimes(4);

    vi.useRealTimers();
  });

  it("WhoopRateLimitError has correct name", () => {
    const error = new WhoopRateLimitError("rate limited");
    expect(error.name).toBe("WhoopRateLimitError");
    expect(error).toBeInstanceOf(Error);
  });

  it("calls onRequest for every API response including successes", async () => {
    const events: Array<{ status: number; endpoint: string; attempt: number }> = [];
    const fetchFn = createMockFetch({ status: 200, ok: true, body: { values: [] } });
    const client = new WhoopClient(makeToken(), fetchFn, (event) => {
      events.push({ status: event.status, endpoint: event.endpoint, attempt: event.attempt });
    });

    await client.getHeartRate("2024-01-15T00:00:00Z", "2024-01-15T23:59:59Z");

    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe(200);
    expect(events[0]?.attempt).toBe(0);
    expect(events[0]?.endpoint).toContain("/metrics-service");
  });

  it("calls onRequest for each 429 retry and the final success", async () => {
    vi.useFakeTimers();
    const events: Array<{ status: number; attempt: number }> = [];
    const callCount = { value: 0 };

    const fetchFn = createTypedMockFetch();
    fetchFn.mockImplementation(() => {
      callCount.value++;
      if (callCount.value <= 2) {
        return Promise.resolve(
          createMockResponse({ ok: false, status: 429, body: "Rate Limit Exceeded" }),
        );
      }
      return Promise.resolve(createMockResponse({ body: { values: [] } }));
    });

    const client = new WhoopClient(makeToken(), fetchFn, (event) => {
      events.push({ status: event.status, attempt: event.attempt });
    });

    const resultPromise = client.getHeartRate("2024-01-15T00:00:00Z", "2024-01-15T23:59:59Z");
    await vi.advanceTimersByTimeAsync(10_000);
    await resultPromise;

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ status: 429, attempt: 0 });
    expect(events[1]).toEqual({ status: 429, attempt: 1 });
    expect(events[2]).toEqual({ status: 200, attempt: 2 });

    vi.useRealTimers();
  });
});

describe("cognitoCall error handling", () => {
  it("includes Message field", async () => {
    const fetchFn = createMockFetch({
      ok: false,
      status: 400,
      body: { __type: "SomeError", Message: "Fallback message" },
    });

    await expect(WhoopClient.signIn("user@example.com", "password", fetchFn)).rejects.toThrow(
      "Fallback message",
    );
  });

  it("defaults to Auth failed when no message fields", async () => {
    const fetchFn = createMockFetch({
      ok: false,
      status: 400,
      body: { __type: "com.amazonaws.cognito#SomeError" },
    });

    await expect(WhoopClient.signIn("user@example.com", "password", fetchFn)).rejects.toThrow(
      "SomeError: Auth failed",
    );
  });

  it("includes empty body text when response body is empty", async () => {
    const fetchFn = createMockFetch({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      body: "",
    });

    await expect(WhoopClient.signIn("user@example.com", "password", fetchFn)).rejects.toThrow(
      "WHOOP auth failed (500): Internal Server Error",
    );
  });
});
