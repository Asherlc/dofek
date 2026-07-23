import { ProviderServiceUnavailableError } from "@dofek/provider-http/rate-limit";
import { describe, expect, it, vi } from "vitest";
import { WhoopClient, WhoopMetricUnavailableError, WhoopRateLimitError } from "./client.ts";
import { createMockFetch, createMockResponse, createTypedMockFetch } from "./test-helpers.ts";
import type { WhoopAuthToken } from "./types.ts";

function makeToken(overrides: Partial<WhoopAuthToken> = {}): WhoopAuthToken {
  return {
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    userId: 12345,
    expiresInSeconds: 3600,
    ...overrides,
  };
}

function getFirstRequestUrl(fetchFn: ReturnType<typeof createMockFetch>): string {
  const firstCall = fetchFn.mock.calls[0];
  if (!firstCall) throw new Error("Expected request");
  const [requestUrl] = firstCall;
  return String(requestUrl);
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
  it("sends the WHOOP browser Cognito request envelope", async () => {
    const fetchFn = createMockFetch({
      ok: true,
      status: 200,
      body: { ChallengeName: "SMS_MFA", Session: "session-abc" },
    });

    await WhoopClient.signIn("user@example.com", "password123", fetchFn);

    const firstCall = fetchFn.mock.calls[0];
    if (!firstCall) throw new Error("Expected auth request");
    const init = firstCall[1];
    if (!init) throw new Error("Expected request init");
    const headers = init.headers;
    if (!headers || Array.isArray(headers) || headers instanceof Headers) {
      throw new Error("Expected plain request headers");
    }
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;

    expect(headers).toMatchObject({
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      Origin: "https://id.whoop.com",
      Referer: "https://id.whoop.com/",
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
      "amz-sdk-request": "attempt=1; max=3",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-site",
    });
    expect(headers["User-Agent"]).toContain("Firefox/150.0");
    expect(headers["x-amz-user-agent"]).toContain("api/cognito-identity-provider#3.848.0");
    expect(headers["amz-sdk-invocation-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(body).toMatchObject({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: "37365lrcda1js3fapqfe2n40eh",
      AuthParameters: {
        USERNAME: "user@example.com",
        PASSWORD: "password123",
      },
    });
  });

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
                ExpiresIn: 3600,
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
      expect(result.token.expiresInSeconds).toBe(3600);
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
                ExpiresIn: 3600,
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

  it("throws when Cognito response is missing ExpiresIn", async () => {
    const callCount = { value: 0 };
    const fetchFn = createTypedMockFetch();
    fetchFn.mockImplementation(() => {
      callCount.value++;
      if (callCount.value === 1) {
        return Promise.resolve(
          createMockResponse({
            body: {
              AuthenticationResult: {
                AccessToken: "whoop-access-123",
                RefreshToken: "whoop-refresh-456",
              },
            },
          }),
        );
      }
      return Promise.resolve(createMockResponse({ body: { user: { id: 999 } } }));
    });

    await expect(WhoopClient.signIn("user@example.com", "password123", fetchFn)).rejects.toThrow(
      "missing valid ExpiresIn",
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
                ExpiresIn: 3600,
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
      "sms",
      fetchFn,
    );

    expect(result.accessToken).toBe("verified-token");
    expect(result.refreshToken).toBe("verified-refresh");
    expect(result.userId).toBe(42);
    expect(result.expiresInSeconds).toBe(3600);
  });

  it("submits SOFTWARE_TOKEN_MFA when the challenge method is totp", async () => {
    const requestBodies: unknown[] = [];
    let callCount = 0;

    const fetchFn = createTypedMockFetch();
    fetchFn.mockImplementation((_input, init) => {
      callCount++;
      if (typeof init?.body === "string") {
        requestBodies.push(JSON.parse(init.body));
      }

      if (callCount === 1) {
        return Promise.resolve(
          createMockResponse({
            body: {
              AuthenticationResult: {
                AccessToken: "totp-token",
                RefreshToken: "totp-refresh",
                ExpiresIn: 3600,
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
      "totp",
      fetchFn,
    );

    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).toMatchObject({
      ChallengeName: "SOFTWARE_TOKEN_MFA",
      ChallengeResponses: {
        USERNAME: "user@example.com",
        SOFTWARE_TOKEN_MFA_CODE: "654321",
      },
    });
    expect(result.accessToken).toBe("totp-token");
    expect(result.userId).toBe(55);
    expect(result.expiresInSeconds).toBe(3600);
  });

  it("throws when no tokens in verification response", async () => {
    const fetchFn = createMockFetch({ ok: true, status: 200, body: {} });

    await expect(
      WhoopClient.verifyCode("session-123", "123456", "user@example.com", "sms", fetchFn),
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
                ExpiresIn: 3600,
              },
            },
          }),
        );
      }
      // Bootstrap returns no userId
      return Promise.resolve(createMockResponse({ body: { foo: "bar" } }));
    });

    await expect(
      WhoopClient.verifyCode("session-123", "123456", "user@example.com", "sms", fetchFn),
    ).rejects.toThrow("could not determine user ID");
  });

  it("throws when Cognito response is missing ExpiresIn", async () => {
    const callCount = { value: 0 };
    const fetchFn = createTypedMockFetch();
    fetchFn.mockImplementation(() => {
      callCount.value++;
      if (callCount.value === 1) {
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
      return Promise.resolve(createMockResponse({ body: { id: 42 } }));
    });

    await expect(
      WhoopClient.verifyCode("session-123", "123456", "user@example.com", "sms", fetchFn),
    ).rejects.toThrow("missing valid ExpiresIn");
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
                ExpiresIn: 3600,
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
    expect(result.expiresInSeconds).toBe(3600);
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
                ExpiresIn: 3600,
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
                ExpiresIn: 3600,
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

  it("throws when Cognito response is missing ExpiresIn", async () => {
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
      return Promise.resolve(createMockResponse({ body: { id: 77 } }));
    });

    await expect(WhoopClient.refreshAccessToken("refresh-token", fetchFn)).rejects.toThrow(
      "missing valid ExpiresIn",
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
                ExpiresIn: 3600,
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
    expect(token.expiresInSeconds).toBe(3600);
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
    const url = getFirstRequestUrl(fetchFn);
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

    const url = getFirstRequestUrl(fetchFn);
    expect(String(url)).toContain("step=60");
  });
});

describe("WhoopClient.getSteps", () => {
  it("requests steps metric with default step interval", async () => {
    const stepValues = [{ time: 1700000000000, data: 8123 }];
    const fetchFn = createMockFetch({ status: 200, ok: true, body: { values: stepValues } });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getSteps("2024-01-15T00:00:00Z", "2024-01-15T23:59:59Z");

    expect(result).toEqual(stepValues);
    const url = getFirstRequestUrl(fetchFn);
    expect(String(url)).toContain("name=steps");
    expect(String(url)).toContain("step=300");
  });

  it("throws WhoopMetricUnavailableError when steps metric is rejected", async () => {
    const fetchFn = createMockFetch({
      status: 400,
      ok: false,
      body: '{"code":400,"message":"query param name must be one of [heart_rate]"}',
    });
    const client = new WhoopClient(makeToken(), fetchFn);

    await expect(
      client.getSteps("2024-01-15T00:00:00Z", "2024-01-15T23:59:59Z"),
    ).rejects.toBeInstanceOf(WhoopMetricUnavailableError);
  });
});

describe("WhoopClient.getStrainDeepDive", () => {
  it("requests the strain deep-dive BFF for a calendar date", async () => {
    const body = {
      sections: [
        {
          items: [
            {
              type: "CONTRIBUTORS_TILE",
              content: {
                id: "STRAIN_CONTRIBUTORS_TILE",
                metrics: [{ id: "CONTRIBUTORS_TILE_STEPS", status: "7,421" }],
              },
            },
          ],
        },
      ],
    };
    const fetchFn = createMockFetch({ status: 200, ok: true, body });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getStrainDeepDive("2026-03-01");

    expect(result).toEqual(body);
    const url = getFirstRequestUrl(fetchFn);
    expect(String(url)).toContain("/home-service/v1/deep-dive/strain");
    expect(String(url)).toContain("date=2026-03-01");
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

  it("returns empty array for object without known wrapper keys", async () => {
    const fetchFn = createMockFetch({ status: 200, ok: true, body: { unknown: "value" } });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getCycles("2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z");

    expect(result).toEqual([]);
  });

  it("returns empty array for null/primitive response", async () => {
    const fetchFn = createMockFetch({ status: 200, ok: true, body: null });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.getCycles("2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z");

    expect(result).toEqual([]);
  });

  it("uses default limit parameter", async () => {
    const fetchFn = createMockFetch({ status: 200, ok: true, body: [] });
    const client = new WhoopClient(makeToken(), fetchFn);

    await client.getCycles("2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z");

    const url = getFirstRequestUrl(fetchFn);
    expect(String(url)).toContain("limit=200");
  });

  it("uses custom limit parameter", async () => {
    const fetchFn = createMockFetch({ status: 200, ok: true, body: [] });
    const client = new WhoopClient(makeToken(), fetchFn);

    await client.getCycles("2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z", 50);

    const url = getFirstRequestUrl(fetchFn);
    expect(String(url)).toContain("limit=50");
  });
});

describe("WhoopClient.listDeveloperWorkouts", () => {
  it("returns paginated developer workout records", async () => {
    const body = {
      records: [
        {
          id: "workout-uuid-1",
          start: "2024-01-15T10:00:00Z",
          end: "2024-01-15T11:00:00Z",
        },
      ],
      next_token: null,
    };
    const fetchFn = createMockFetch({ status: 200, ok: true, body });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.listDeveloperWorkouts({ limit: 25 });

    expect(result).toEqual(body);
    const url = getFirstRequestUrl(fetchFn);
    expect(String(url)).toContain("/developer/v2/activity/workout");
    expect(String(url)).toContain("limit=25");
  });

  it("passes next_token and parses developer workout records", async () => {
    const fetchFn = createMockFetch({
      status: 200,
      ok: true,
      body: {
        records: [
          {
            id: "valid-workout",
            start: "2024-01-15T10:00:00Z",
            end: "2024-01-15T11:00:00Z",
            timezone_offset: "+00:00",
            sport_name: "Running",
            sport_id: 1,
            score_state: "SCORED",
          },
        ],
        next_token: "page-3",
      },
    });
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.listDeveloperWorkouts({ limit: 10, nextToken: "page-2" });

    expect(result.records.map((record) => record.id)).toEqual(["valid-workout"]);
    expect(result.next_token).toBe("page-3");
    const url = getFirstRequestUrl(fetchFn);
    expect(url).toContain("limit=10");
    expect(url).toContain("next_token=page-2");
  });

  it("rejects malformed developer workout records", async () => {
    const fetchFn = createMockFetch({
      status: 200,
      ok: true,
      body: {
        records: [{ id: "missing-start", end: "2024-01-15T11:00:00Z" }],
        next_token: null,
      },
    });
    const client = new WhoopClient(makeToken(), fetchFn);

    await expect(client.listDeveloperWorkouts()).rejects.toThrow();
  });

  it("rejects malformed developer workout responses", async () => {
    const fetchFn = createMockFetch({
      status: 200,
      ok: true,
      body: { records: "not-an-array", next_token: 123 },
    });
    const client = new WhoopClient(makeToken(), fetchFn);

    await expect(client.listDeveloperWorkouts()).rejects.toThrow();
  });

  it("rejects non-string next_token values in developer workout responses", async () => {
    const fetchFn = createMockFetch({
      status: 200,
      ok: true,
      body: {
        records: [
          {
            id: "valid-workout",
            start: "2024-01-15T10:00:00Z",
            end: "2024-01-15T11:00:00Z",
          },
        ],
        next_token: 123,
      },
    });
    const client = new WhoopClient(makeToken(), fetchFn);

    await expect(client.listDeveloperWorkouts()).rejects.toThrow();
  });

  it("rejects null developer workout responses", async () => {
    const fetchFn = createMockFetch({ status: 200, ok: true, body: null });
    const client = new WhoopClient(makeToken(), fetchFn);

    await expect(client.listDeveloperWorkouts()).rejects.toThrow();
  });

  it("does not retry rate-limited developer workout requests", async () => {
    const fetchFn = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        createMockResponse({ status: 429, ok: false, text: "slow down", body: "slow down" }),
      );
    const client = new WhoopClient(makeToken(), fetchFn);

    await expect(client.listDeveloperWorkouts()).rejects.toBeInstanceOf(WhoopRateLimitError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("retries service-unavailable developer workout requests before succeeding", async () => {
    const fetchFn = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        createMockResponse({
          status: 503,
          ok: false,
          text: "Encountered ServiceUnavailableException",
          body: "Encountered ServiceUnavailableException",
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({
          status: 503,
          ok: false,
          text: "Encountered ServiceUnavailableException",
          body: "Encountered ServiceUnavailableException",
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({
          status: 200,
          ok: true,
          body: {
            records: [
              {
                id: "after-service-retry",
                start: "2024-01-15T10:00:00Z",
                end: "2024-01-15T11:00:00Z",
              },
            ],
            next_token: null,
          },
        }),
      );
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.listDeveloperWorkouts();

    expect(result.records.map((record) => record.id)).toEqual(["after-service-retry"]);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("retries HTTP 500 developer workout requests before succeeding", async () => {
    const fetchFn = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        createMockResponse({
          status: 500,
          ok: false,
          text: "Request failed.",
          body: "Request failed.",
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({
          status: 500,
          ok: false,
          text: "Request failed.",
          body: "Request failed.",
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({
          status: 200,
          ok: true,
          body: {
            records: [
              {
                id: "after-internal-server-retry",
                start: "2024-01-15T10:00:00Z",
                end: "2024-01-15T11:00:00Z",
              },
            ],
            next_token: null,
          },
        }),
      );
    const client = new WhoopClient(makeToken(), fetchFn);

    const result = await client.listDeveloperWorkouts();

    expect(result.records.map((record) => record.id)).toEqual(["after-internal-server-retry"]);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-transient developer workout errors", async () => {
    const fetchFn = createMockFetch({
      status: 403,
      ok: false,
      body: "Forbidden",
    });
    const client = new WhoopClient(makeToken(), fetchFn);

    await expect(client.listDeveloperWorkouts()).rejects.toThrow(
      "WHOOP API error (403): Forbidden",
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws the rate-limit error without retrying developer workout requests", async () => {
    const fetchFn = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          createMockResponse({ status: 429, ok: false, text: "slow down", body: "slow down" }),
        ),
      );
    const client = new WhoopClient(makeToken(), fetchFn);

    await expect(client.listDeveloperWorkouts()).rejects.toBeInstanceOf(WhoopRateLimitError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws the common service-unavailable error after exhausting developer workout retries", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockImplementation(() =>
      Promise.resolve(
        createMockResponse({
          status: 503,
          ok: false,
          text: "Encountered ServiceUnavailableException",
          body: "Encountered ServiceUnavailableException",
        }),
      ),
    );
    const client = new WhoopClient(makeToken(), fetchFn);

    await expect(client.listDeveloperWorkouts()).rejects.toBeInstanceOf(
      ProviderServiceUnavailableError,
    );
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });
});

describe("WhoopClient.listDeveloperWorkoutIdsInWindow", () => {
  it("collects workout ids whose start time falls in the window", async () => {
    const fetchFn = createTypedMockFetch();
    fetchFn.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/developer/v2/activity/workout")) {
        return createMockResponse({
          status: 200,
          ok: true,
          body: {
            records: [
              {
                id: "in-window",
                start: "2024-01-15T10:00:00Z",
                end: "2024-01-15T11:00:00Z",
              },
              {
                id: "before-window",
                start: "2024-01-01T10:00:00Z",
                end: "2024-01-01T11:00:00Z",
              },
            ],
            next_token: null,
          },
        });
      }
      return createMockResponse({ status: 404, ok: false, text: "not found" });
    });
    const client = new WhoopClient(makeToken(), fetchFn);

    const ids = await client.listDeveloperWorkoutIdsInWindow(
      new Date("2024-01-10T00:00:00Z"),
      new Date("2024-01-20T00:00:00Z"),
    );

    expect(ids).toEqual(new Set(["in-window"]));
  });

  it("includes starts at the lower bound and excludes starts at the upper bound", async () => {
    const fetchFn = createMockFetch({
      status: 200,
      ok: true,
      body: {
        records: [
          {
            id: "at-start",
            start: "2024-01-10T00:00:00.000Z",
            end: "2024-01-10T01:00:00.000Z",
          },
          {
            id: "at-end",
            start: "2024-01-20T00:00:00.000Z",
            end: "2024-01-20T01:00:00.000Z",
          },
          {
            id: "invalid-start",
            start: "not-a-date",
            end: "2024-01-15T01:00:00.000Z",
          },
          {
            id: "",
            start: "2024-01-15T00:00:00.000Z",
            end: "2024-01-15T01:00:00.000Z",
          },
        ],
        next_token: null,
      },
    });
    const client = new WhoopClient(makeToken(), fetchFn);

    const ids = await client.listDeveloperWorkoutIdsInWindow(
      new Date("2024-01-10T00:00:00.000Z"),
      new Date("2024-01-20T00:00:00.000Z"),
    );

    expect(ids).toEqual(new Set(["at-start"]));
  });

  it("stops when a developer workout page is empty even if next_token is present", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        createMockResponse({
          body: {
            records: [],
            next_token: "should-not-fetch",
          },
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({
          body: {
            records: [
              {
                id: "unexpected",
                start: "2024-01-15T00:00:00.000Z",
                end: "2024-01-15T01:00:00.000Z",
              },
            ],
            next_token: null,
          },
        }),
      );
    const client = new WhoopClient(makeToken(), fetchFn);

    const ids = await client.listDeveloperWorkoutIdsInWindow(
      new Date("2024-01-10T00:00:00.000Z"),
      new Date("2024-01-20T00:00:00.000Z"),
    );

    expect(ids).toEqual(new Set());
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("continues pagination when the oldest workout starts exactly at the window start", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        createMockResponse({
          body: {
            records: [
              {
                id: "at-start",
                start: "2024-01-10T00:00:00.000Z",
                end: "2024-01-10T01:00:00.000Z",
              },
            ],
            next_token: "next-page",
          },
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({
          body: {
            records: [
              {
                id: "second-page",
                start: "2024-01-12T00:00:00.000Z",
                end: "2024-01-12T01:00:00.000Z",
              },
            ],
            next_token: null,
          },
        }),
      );
    const client = new WhoopClient(makeToken(), fetchFn);

    const ids = await client.listDeveloperWorkoutIdsInWindow(
      new Date("2024-01-10T00:00:00.000Z"),
      new Date("2024-01-20T00:00:00.000Z"),
    );

    expect(ids).toEqual(new Set(["at-start", "second-page"]));
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(String(fetchFn.mock.calls[1]?.[0])).toContain("next_token=next-page");
  });

  it("ignores invalid starts when deciding whether a page is older than the window", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        createMockResponse({
          body: {
            records: [
              {
                id: "invalid-start",
                start: "not-a-date",
                end: "2024-01-15T01:00:00.000Z",
              },
              {
                id: "older-page",
                start: "2024-01-01T00:00:00.000Z",
                end: "2024-01-01T01:00:00.000Z",
              },
            ],
            next_token: "should-not-fetch",
          },
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({
          body: {
            records: [
              {
                id: "unexpected",
                start: "2024-01-15T00:00:00.000Z",
                end: "2024-01-15T01:00:00.000Z",
              },
            ],
            next_token: null,
          },
        }),
      );
    const client = new WhoopClient(makeToken(), fetchFn);

    const ids = await client.listDeveloperWorkoutIdsInWindow(
      new Date("2024-01-10T00:00:00.000Z"),
      new Date("2024-01-20T00:00:00.000Z"),
    );

    expect(ids).toEqual(new Set());
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("paginates until records are older than the window start", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        createMockResponse({
          body: {
            records: [
              {
                id: "newer-page",
                start: "2024-01-18T00:00:00.000Z",
                end: "2024-01-18T01:00:00.000Z",
              },
            ],
            next_token: "next-page",
          },
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse({
          body: {
            records: [
              {
                id: "older-page",
                start: "2024-01-01T00:00:00.000Z",
                end: "2024-01-01T01:00:00.000Z",
              },
            ],
            next_token: "ignored-page",
          },
        }),
      );
    const client = new WhoopClient(makeToken(), fetchFn);

    const ids = await client.listDeveloperWorkoutIdsInWindow(
      new Date("2024-01-10T00:00:00.000Z"),
      new Date("2024-01-20T00:00:00.000Z"),
    );

    expect(ids).toEqual(new Set(["newer-page"]));
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(String(fetchFn.mock.calls[1]?.[0])).toContain("next_token=next-page");
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
    const url = getFirstRequestUrl(fetchFn);
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
    const url = getFirstRequestUrl(fetchFn);
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
    const url = getFirstRequestUrl(fetchFn);
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

  it("does not retry HTTP 500 responses from other endpoints", async () => {
    const fetchFn = createMockFetch({
      ok: false,
      status: 500,
      body: "Request failed.",
    });

    const client = new WhoopClient(makeToken(), fetchFn);

    await expect(
      client.getHeartRate("2024-01-15T00:00:00Z", "2024-01-15T23:59:59Z"),
    ).rejects.toThrow("WHOOP API error (500): Request failed.");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// Rate limit detection behavior
// ============================================================

describe("WhoopClient rate limit detection", () => {
  it("throws WhoopRateLimitError immediately on 429", async () => {
    const fetchFn = createMockFetch({
      ok: false,
      status: 429,
      body: "Rate Limit Exceeded",
    });

    const client = new WhoopClient(makeToken(), fetchFn);
    const error = await client
      .getHeartRate("2024-01-15T00:00:00Z", "2024-01-15T23:59:59Z")
      .catch((error: unknown) => error);

    expect(error).toBeInstanceOf(WhoopRateLimitError);
    if (error instanceof WhoopRateLimitError) {
      expect(error.message).toContain("429");
      expect(error.responseBody).toBe("Rate Limit Exceeded");
    }
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("captures Retry-After on WhoopRateLimitError", async () => {
    const response = createMockResponse({
      ok: false,
      status: 429,
      body: "Rate Limit Exceeded",
    });
    response.headers.set("Retry-After", "5");
    const fetchFn = createTypedMockFetch();
    fetchFn.mockResolvedValue(response);

    const client = new WhoopClient(makeToken(), fetchFn);
    const error = await client
      .getHeartRate("2024-01-15T00:00:00Z", "2024-01-15T23:59:59Z")
      .catch((caughtError: unknown) => caughtError);

    expect(error).toBeInstanceOf(WhoopRateLimitError);
    expect(error).toHaveProperty("retryAfterSeconds", 5);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("parses an HTTP-date Retry-After header into seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T00:00:00Z"));
    const response = createMockResponse({
      ok: false,
      status: 429,
      body: "Rate Limit Exceeded",
    });
    response.headers.set("Retry-After", new Date("2024-01-15T00:01:00Z").toUTCString());
    const fetchFn = createTypedMockFetch();
    fetchFn.mockResolvedValue(response);

    const client = new WhoopClient(makeToken(), fetchFn);
    const error = await client
      .getHeartRate("2024-01-15T00:00:00Z", "2024-01-15T23:59:59Z")
      .catch((caughtError: unknown) => caughtError);

    expect(error).toBeInstanceOf(WhoopRateLimitError);
    expect(error).toHaveProperty("retryAfterSeconds", 60);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("WhoopRateLimitError has correct name", () => {
    const error = new WhoopRateLimitError("rate limited");
    expect(error.name).toBe("WhoopRateLimitError");
    expect(error).toBeInstanceOf(Error);
  });

  it("WhoopRateLimitError defaults to provider scope when userId is not provided", () => {
    const error = new WhoopRateLimitError("rate limited");
    expect(error.scope).toBe("provider");
    expect(error.userId).toBeNull();
  });

  it("WhoopRateLimitError uses user scope when userId is provided", () => {
    const error = new WhoopRateLimitError("rate limited", "", null, "user-abc");
    expect(error.scope).toBe("user");
    expect(error.userId).toBe("user-abc");
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

  it("calls onRequest for the 429 response before throwing", async () => {
    const events: Array<{ status: number; attempt: number }> = [];
    const fetchFn = createMockFetch({
      ok: false,
      status: 429,
      body: "Rate Limit Exceeded",
    });

    const client = new WhoopClient(makeToken(), fetchFn, (event) => {
      events.push({ status: event.status, attempt: event.attempt });
    });

    await client
      .getHeartRate("2024-01-15T00:00:00Z", "2024-01-15T23:59:59Z")
      .catch(() => undefined);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ status: 429, attempt: 0 });
  });

  it("sends the bearer Authorization header on GET requests", async () => {
    const fetchFn = createMockFetch({ status: 200, ok: true, body: { values: [] } });
    const client = new WhoopClient(makeToken({ accessToken: "secret-token" }), fetchFn);

    await client.getHeartRate("2024-01-15T00:00:00Z", "2024-01-15T23:59:59Z");

    const init = fetchFn.mock.calls[0]?.[1];
    const headers = init?.headers;
    if (!headers || Array.isArray(headers) || headers instanceof Headers) {
      throw new Error("Expected plain request headers");
    }
    expect(headers.Authorization).toBe("Bearer secret-token");
    expect(headers["User-Agent"]).toBe("WHOOP/4.0");
  });

  it("does not parse Retry-After on a non-429 GET response", async () => {
    const events: Array<{ status: number; retryAfterSeconds: number | null }> = [];
    const response = createMockResponse({ ok: true, status: 200, body: { values: [] } });
    response.headers.set("Retry-After", "30");
    const fetchFn = createTypedMockFetch();
    fetchFn.mockResolvedValue(response);

    const client = new WhoopClient(makeToken(), fetchFn, (event) => {
      events.push({ status: event.status, retryAfterSeconds: event.retryAfterSeconds });
    });

    await client.getHeartRate("2024-01-15T00:00:00Z", "2024-01-15T23:59:59Z");

    expect(events[0]).toEqual({ status: 200, retryAfterSeconds: null });
  });
});

describe("WhoopClient._fetchUserId rate limit detection", () => {
  it("throws WhoopRateLimitError on 429 and sends the bearer header", async () => {
    const fetchFn = createMockFetch({ ok: false, status: 429, body: "Rate Limit Exceeded" });

    const error = await WhoopClient._fetchUserId("bootstrap-token", fetchFn).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(WhoopRateLimitError);
    if (error instanceof WhoopRateLimitError) {
      expect(error.message).toContain("429");
      expect(error.responseBody).toBe("Rate Limit Exceeded");
    }
    const init = fetchFn.mock.calls[0]?.[1];
    const headers = init?.headers;
    if (!headers || Array.isArray(headers) || headers instanceof Headers) {
      throw new Error("Expected plain request headers");
    }
    expect(headers.Authorization).toBe("Bearer bootstrap-token");
  });
});

describe("WhoopClient.getWeightliftingWorkout rate limit detection", () => {
  it("throws WhoopRateLimitError on 429 with the status in the message", async () => {
    const fetchFn = createMockFetch({ ok: false, status: 429, body: "Slow down" });
    const client = new WhoopClient(makeToken(), fetchFn);

    const error = await client
      .getWeightliftingWorkout("abc-123")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WhoopRateLimitError);
    if (error instanceof WhoopRateLimitError) {
      expect(error.message).toContain("429");
      expect(error.responseBody).toBe("Slow down");
    }
  });

  it("emits an onRequest 429 event with parsed Retry-After before throwing", async () => {
    const events: Array<{ status: number; attempt: number; retryAfterSeconds: number | null }> = [];
    const response = createMockResponse({ ok: false, status: 429, body: "Slow down" });
    response.headers.set("Retry-After", "12");
    const fetchFn = createTypedMockFetch();
    fetchFn.mockResolvedValue(response);

    const client = new WhoopClient(makeToken(), fetchFn, (event) => {
      events.push({
        status: event.status,
        attempt: event.attempt,
        retryAfterSeconds: event.retryAfterSeconds,
      });
    });

    const error = await client
      .getWeightliftingWorkout("abc-123")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WhoopRateLimitError);
    expect(error).toHaveProperty("retryAfterSeconds", 12);
    expect(events).toEqual([{ status: 429, attempt: 0, retryAfterSeconds: 12 }]);
  });

  it("sends the bearer Authorization header", async () => {
    const fetchFn = createMockFetch({ status: 200, ok: true, body: { activity_id: "abc-123" } });
    const client = new WhoopClient(makeToken({ accessToken: "lift-token" }), fetchFn);

    await client.getWeightliftingWorkout("abc-123");

    const init = fetchFn.mock.calls[0]?.[1];
    const headers = init?.headers;
    if (!headers || Array.isArray(headers) || headers instanceof Headers) {
      throw new Error("Expected plain request headers");
    }
    expect(headers.Authorization).toBe("Bearer lift-token");
    expect(headers["User-Agent"]).toBe("WHOOP/4.0");
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
