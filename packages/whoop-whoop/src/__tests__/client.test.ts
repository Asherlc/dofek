import { describe, expect, it, vi } from "vitest";
import { WhoopClient } from "../client.ts";
import type { WhoopAuthToken } from "../types.ts";

function mockFetch(response: {
  status: number;
  ok: boolean;
  body: unknown;
}): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: () => Promise.resolve(response.body),
    text: () =>
      Promise.resolve(
        typeof response.body === "string" ? response.body : JSON.stringify(response.body),
      ),
  });
}

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

    const fetchFn = vi.fn().mockImplementation((_url: string) => {
      callCount.value++;

      // First call: InitiateAuth
      if (callCount.value === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                AuthenticationResult: {
                  AccessToken: "whoop-access-123",
                  RefreshToken: "whoop-refresh-456",
                  IdToken: "id-token",
                },
              }),
            ),
        });
      }

      // Second call: _fetchUserId (bootstrap)
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ user: { id: 999 } }),
      });
      // @ts-expect-error partial fetch mock
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
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            ChallengeName: "SMS_MFA",
            Session: "session-abc",
          }),
        ),
      // @ts-expect-error partial fetch mock
    });

    const result = await WhoopClient.signIn("user@example.com", "password123", fetchFn);

    expect(result.type).toBe("verification_required");
    if (result.type === "verification_required") {
      expect(result.session).toBe("session-abc");
      expect(result.method).toBe("sms");
    }
  });

  it("returns verification_required when MFA challenge (TOTP)", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            ChallengeName: "SOFTWARE_TOKEN_MFA",
            Session: "session-xyz",
          }),
        ),
      // @ts-expect-error partial fetch mock
    });

    const result = await WhoopClient.signIn("user@example.com", "password123", fetchFn);

    expect(result.type).toBe("verification_required");
    if (result.type === "verification_required") {
      expect(result.method).toBe("totp");
    }
  });

  it("throws when no tokens in response and no challenge", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({})),
      // @ts-expect-error partial fetch mock
    });

    await expect(WhoopClient.signIn("user@example.com", "password123", fetchFn)).rejects.toThrow(
      "no tokens in response",
    );
  });

  it("throws when userId cannot be fetched", async () => {
    const callCount = { value: 0 };

    const fetchFn = vi.fn().mockImplementation(() => {
      callCount.value++;
      if (callCount.value === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                AuthenticationResult: {
                  AccessToken: "token",
                  RefreshToken: "refresh",
                },
              }),
            ),
        });
      }
      // Bootstrap fails
      return Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      });
      // @ts-expect-error partial fetch mock
    });

    await expect(WhoopClient.signIn("user@example.com", "password123", fetchFn)).rejects.toThrow(
      "could not determine user ID",
    );
  });

  it("throws on Cognito error response", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            __type: "com.amazonaws.cognito#NotAuthorizedException",
            message: "Incorrect username or password.",
          }),
        ),
      // @ts-expect-error partial fetch mock
    });

    await expect(WhoopClient.signIn("user@example.com", "bad-password", fetchFn)).rejects.toThrow(
      "NotAuthorizedException: Incorrect username or password.",
    );
  });

  it("throws on non-JSON error response", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: () => Promise.resolve("not json"),
      // @ts-expect-error partial fetch mock
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

    const fetchFn = vi.fn().mockImplementation(() => {
      callCount.value++;
      if (callCount.value === 1) {
        // SMS_MFA challenge response
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                AuthenticationResult: {
                  AccessToken: "verified-token",
                  RefreshToken: "verified-refresh",
                },
              }),
            ),
        });
      }
      // Bootstrap to get userId
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 42 }),
      });
      // @ts-expect-error partial fetch mock
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

    const fetchFn = vi.fn().mockImplementation(() => {
      callCount.value++;
      if (callCount.value === 1) {
        // SMS_MFA fails
        return Promise.resolve({
          ok: false,
          status: 400,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                __type: "com.amazonaws.cognito#CodeMismatchException",
                message: "Invalid code",
              }),
            ),
        });
      }
      if (callCount.value === 2) {
        // SOFTWARE_TOKEN_MFA succeeds
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                AuthenticationResult: {
                  AccessToken: "totp-token",
                  RefreshToken: "totp-refresh",
                },
              }),
            ),
        });
      }
      // Bootstrap
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ user_id: 55 }),
      });
      // @ts-expect-error partial fetch mock
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
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({})),
      // @ts-expect-error partial fetch mock
    });

    await expect(
      WhoopClient.verifyCode("session-123", "123456", "user@example.com", fetchFn),
    ).rejects.toThrow("no tokens in response");
  });

  it("throws when userId cannot be determined after verification", async () => {
    const callCount = { value: 0 };

    const fetchFn = vi.fn().mockImplementation(() => {
      callCount.value++;
      if (callCount.value === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                AuthenticationResult: {
                  AccessToken: "token",
                  RefreshToken: "refresh",
                },
              }),
            ),
        });
      }
      // Bootstrap returns no userId
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ foo: "bar" }),
      });
      // @ts-expect-error partial fetch mock
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

    const fetchFn = vi.fn().mockImplementation(() => {
      callCount.value++;
      if (callCount.value === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                AuthenticationResult: {
                  AccessToken: "new-access",
                  RefreshToken: "new-refresh",
                },
              }),
            ),
        });
      }
      // Bootstrap
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 77 }),
      });
      // @ts-expect-error partial fetch mock
    });

    const result = await WhoopClient.refreshAccessToken("old-refresh-token", fetchFn);

    expect(result.accessToken).toBe("new-access");
    expect(result.refreshToken).toBe("new-refresh");
    expect(result.userId).toBe(77);
  });

  it("reuses old refresh token when Cognito does not return new one", async () => {
    const callCount = { value: 0 };

    const fetchFn = vi.fn().mockImplementation(() => {
      callCount.value++;
      if (callCount.value === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                AuthenticationResult: {
                  AccessToken: "new-access",
                  // No RefreshToken
                },
              }),
            ),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 88 }),
      });
      // @ts-expect-error partial fetch mock
    });

    const result = await WhoopClient.refreshAccessToken("keep-this-refresh", fetchFn);

    expect(result.refreshToken).toBe("keep-this-refresh");
  });

  it("returns null userId when bootstrap fails", async () => {
    const callCount = { value: 0 };

    const fetchFn = vi.fn().mockImplementation(() => {
      callCount.value++;
      if (callCount.value === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                AuthenticationResult: {
                  AccessToken: "new-access",
                },
              }),
            ),
        });
      }
      // Bootstrap fails
      return Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      });
      // @ts-expect-error partial fetch mock
    });

    const result = await WhoopClient.refreshAccessToken("refresh-token", fetchFn);

    expect(result.userId).toBeNull();
  });

  it("throws when no tokens in refresh response", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({})),
      // @ts-expect-error partial fetch mock
    });

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

    const fetchFn = vi.fn().mockImplementation(() => {
      callCount.value++;
      if (callCount.value === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                AuthenticationResult: {
                  AccessToken: "access",
                  RefreshToken: "refresh",
                },
              }),
            ),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 100 }),
      });
      // @ts-expect-error partial fetch mock
    });

    const token = await WhoopClient.authenticate("user@example.com", "password", fetchFn);

    expect(token.accessToken).toBe("access");
    expect(token.userId).toBe(100);
  });

  it("throws when MFA is required", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            ChallengeName: "SMS_MFA",
            Session: "session-abc",
          }),
        ),
      // @ts-expect-error partial fetch mock
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
    const fetchFn = mockFetch({ status: 200, ok: true, body: { id: 42 } });
    const result = await WhoopClient._fetchUserId("token", fetchFn);
    expect(result).toBe(42);
  });

  it("returns id from top-level user_id field", async () => {
    const fetchFn = mockFetch({ status: 200, ok: true, body: { user_id: 55 } });
    const result = await WhoopClient._fetchUserId("token", fetchFn);
    expect(result).toBe(55);
  });

  it("returns id from nested user.id field", async () => {
    const fetchFn = mockFetch({ status: 200, ok: true, body: { user: { id: 66 } } });
    const result = await WhoopClient._fetchUserId("token", fetchFn);
    expect(result).toBe(66);
  });

  it("returns id from nested user.user_id field", async () => {
    const fetchFn = mockFetch({ status: 200, ok: true, body: { user: { user_id: 77 } } });
    const result = await WhoopClient._fetchUserId("token", fetchFn);
    expect(result).toBe(77);
  });

  it("returns null when response is not ok", async () => {
    const fetchFn = mockFetch({ status: 500, ok: false, body: {} });
    const result = await WhoopClient._fetchUserId("token", fetchFn);
    expect(result).toBeNull();
  });

  it("returns null when no valid userId in response", async () => {
    const fetchFn = mockFetch({ status: 200, ok: true, body: { foo: "bar" } });
    const result = await WhoopClient._fetchUserId("token", fetchFn);
    expect(result).toBeNull();
  });

  it("returns null when userId is not a number", async () => {
    const fetchFn = mockFetch({ status: 200, ok: true, body: { id: "not-a-number" } });
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

    const fetchFn = mockFetch({ status: 200, ok: true, body: { values: hrValues } });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getHeartRate("2024-01-15T00:00:00Z", "2024-01-15T23:59:59Z");

    expect(result).toEqual(hrValues);
    // @ts-expect-error mock type
    const [url] = fetchFn.mock.calls[0];
    expect(url).toContain("/metrics-service/v1/metrics/user/12345");
    expect(url).toContain("name=heart_rate");
    expect(url).toContain("step=6");
  });

  it("returns empty array when no values", async () => {
    const fetchFn = mockFetch({ status: 200, ok: true, body: {} });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getHeartRate("2024-01-15T00:00:00Z", "2024-01-15T23:59:59Z");

    expect(result).toEqual([]);
  });

  it("uses custom step parameter", async () => {
    const fetchFn = mockFetch({ status: 200, ok: true, body: { values: [] } });
    const client = new WhoopClient(makeToken(), fetchFn);

    await client.getHeartRate("2024-01-15T00:00:00Z", "2024-01-15T23:59:59Z", 60);

    // @ts-expect-error mock type
    const [url] = fetchFn.mock.calls[0];
    expect(url).toContain("step=60");
  });
});

describe("WhoopClient.getCycles", () => {
  it("returns cycles from array response", async () => {
    const cycles = [{ id: 1, user_id: 12345 }];
    const fetchFn = mockFetch({ status: 200, ok: true, body: cycles });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getCycles("2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z");

    expect(result).toEqual(cycles);
  });

  it("returns cycles from wrapped response with cycles key", async () => {
    const cycles = [{ id: 2 }];
    const fetchFn = mockFetch({ status: 200, ok: true, body: { cycles } });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getCycles("2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z");

    expect(result).toEqual(cycles);
  });

  it("returns cycles from wrapped response with records key", async () => {
    const records = [{ id: 3 }];
    const fetchFn = mockFetch({ status: 200, ok: true, body: { records } });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getCycles("2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z");

    expect(result).toEqual(records);
  });

  it("returns cycles from wrapped response with data key", async () => {
    const data = [{ id: 4 }];
    const fetchFn = mockFetch({ status: 200, ok: true, body: { data } });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getCycles("2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z");

    expect(result).toEqual(data);
  });

  it("returns cycles from wrapped response with results key", async () => {
    const results = [{ id: 5 }];
    const fetchFn = mockFetch({ status: 200, ok: true, body: { results } });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getCycles("2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z");

    expect(result).toEqual(results);
  });

  it("returns empty array for object without known wrapper keys", async () => {
    const fetchFn = mockFetch({ status: 200, ok: true, body: { unknown: "value" } });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getCycles("2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z");

    expect(result).toEqual([]);
  });

  it("returns empty array for null/primitive response", async () => {
    const fetchFn = mockFetch({ status: 200, ok: true, body: null });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getCycles("2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z");

    expect(result).toEqual([]);
  });

  it("uses default limit parameter", async () => {
    const fetchFn = mockFetch({ status: 200, ok: true, body: [] });
    const client = new WhoopClient(makeToken(), fetchFn);

    await client.getCycles("2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z");

    // @ts-expect-error mock type
    const [url] = fetchFn.mock.calls[0];
    expect(url).toContain("limit=26");
  });

  it("uses custom limit parameter", async () => {
    const fetchFn = mockFetch({ status: 200, ok: true, body: [] });
    const client = new WhoopClient(makeToken(), fetchFn);

    await client.getCycles("2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z", 50);

    // @ts-expect-error mock type
    const [url] = fetchFn.mock.calls[0];
    expect(url).toContain("limit=50");
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

    const fetchFn = mockFetch({ status: 200, ok: true, body: sleepRecord });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getSleep(1001);

    expect(result).toEqual(sleepRecord);
    // @ts-expect-error mock type
    const [url] = fetchFn.mock.calls[0];
    expect(url).toContain("/sleep-service/v1/sleep-events");
    expect(url).toContain("activityId=1001");
  });
});

describe("WhoopClient.getJournal", () => {
  it("returns journal data", async () => {
    const journalData = { impacts: [] };

    const fetchFn = mockFetch({ status: 200, ok: true, body: journalData });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getJournal("2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z");

    expect(result).toEqual(journalData);
    // @ts-expect-error mock type
    const [url] = fetchFn.mock.calls[0];
    expect(url).toContain("/behavior-impact-service/v1/impact");
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

    const fetchFn = mockFetch({ status: 200, ok: true, body: workoutData });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getWeightliftingWorkout("abc-123");

    expect(result).toEqual(workoutData);
    // @ts-expect-error mock type
    const [url] = fetchFn.mock.calls[0];
    expect(url).toContain("/weightlifting-service/v2/weightlifting-workout/abc-123");
  });

  it("returns null on 404", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      // @ts-expect-error partial fetch mock
    });

    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getWeightliftingWorkout("nonexistent");

    expect(result).toBeNull();
  });

  it("throws on non-404 error", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Server Error"),
      // @ts-expect-error partial fetch mock
    });

    const client = new WhoopClient(makeToken(), fetchFn);

    await expect(client.getWeightliftingWorkout("abc-123")).rejects.toThrow(
      "WHOOP weightlifting API error (500)",
    );
  });
});

describe("WhoopClient API error handling", () => {
  it("throws on non-200 response from get method", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve("Forbidden"),
      // @ts-expect-error partial fetch mock
    });

    const client = new WhoopClient(makeToken(), fetchFn);

    await expect(
      client.getHeartRate("2024-01-15T00:00:00Z", "2024-01-15T23:59:59Z"),
    ).rejects.toThrow("WHOOP API error (403): Forbidden");
  });
});

describe("cognitoCall error handling", () => {
  // @ts-expect-error mock type assertion
  it("includes Message field", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            __type: "SomeError",
            Message: "Fallback message",
          }),
        ),
      // @ts-expect-error partial fetch mock
    });

    await expect(WhoopClient.signIn("user@example.com", "password", fetchFn)).rejects.toThrow(
      "Fallback message",
    );
  });

  it("defaults to Auth failed when no message fields", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            __type: "com.amazonaws.cognito#SomeError",
          }),
        ),
      // @ts-expect-error partial fetch mock
    });

    await expect(WhoopClient.signIn("user@example.com", "password", fetchFn)).rejects.toThrow(
      "SomeError: Auth failed",
    );
  });

  it("includes empty body text when response body is empty", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: () => Promise.resolve(""),
      // @ts-expect-error partial fetch mock
    });

    await expect(WhoopClient.signIn("user@example.com", "password", fetchFn)).rejects.toThrow(
      "WHOOP auth failed (500): Internal Server Error",
    );
  });
});
