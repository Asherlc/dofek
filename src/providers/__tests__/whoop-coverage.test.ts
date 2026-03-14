import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../db/__tests__/test-helpers.ts";
import { journalEntry } from "../../db/schema.ts";
import { ensureProvider, saveTokens } from "../../db/tokens.ts";
import { WhoopInternalClient, WhoopProvider, type WhoopSleepRecord } from "../whoop.ts";

// ============================================================
// Coverage tests for uncovered paths:
// - HR stream error (line ~1143)
// - Journal error (lines ~1178-1182)
// - cognitoCall error paths
// - parseJournalResponse edge cases
// - WhoopInternalClient.verifyCode
// - getCycles response shape handling
// ============================================================

const _fakeSleepResponse: WhoopSleepRecord = {
  id: 10235,
  user_id: 10129,
  created_at: "2026-03-01T06:00:00Z",
  updated_at: "2026-03-01T06:30:00Z",
  start: "2026-02-28T23:00:00Z",
  end: "2026-03-01T06:30:00Z",
  timezone_offset: "-05:00",
  nap: false,
  score_state: "SCORED",
  score: {
    stage_summary: {
      total_in_bed_time_milli: 27000000,
      total_awake_time_milli: 1800000,
      total_no_data_time_milli: 0,
      total_light_sleep_time_milli: 10800000,
      total_slow_wave_sleep_time_milli: 7200000,
      total_rem_sleep_time_milli: 5400000,
      sleep_cycle_count: 4,
      disturbance_count: 2,
    },
    sleep_needed: {
      baseline_milli: 28800000,
      need_from_sleep_debt_milli: 1800000,
      need_from_recent_strain_milli: 900000,
      need_from_recent_nap_milli: 0,
    },
    respiratory_rate: 16.1,
    sleep_performance_percentage: 92,
    sleep_consistency_percentage: 88,
    sleep_efficiency_percentage: 91.7,
  },
};

describe("WhoopProvider — HR stream error path", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "whoop", "WHOOP");
    await saveTokens(ctx.db, "whoop", {
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      scopes: "userId:10129",
    });
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it("catches HR stream errors and continues to journal sync", async () => {
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const urlStr = input.toString();
      if (urlStr.includes("auth-service/v3/whoop")) {
        return Response.json({
          AuthenticationResult: { AccessToken: "test-token", RefreshToken: "test-refresh" },
        });
      }
      if (urlStr.includes("users-service/v2/bootstrap")) {
        return Response.json({ id: 10129 });
      }
      if (urlStr.includes("/cycles")) {
        return Response.json([]);
      }
      if (urlStr.includes("metrics-service") || urlStr.includes("metrics/user")) {
        // Simulate an error in HR stream fetch
        return new Response("Internal Server Error", { status: 500 });
      }
      if (urlStr.includes("behavior-impact-service")) {
        // Journal should still be called even if HR stream fails
        return Response.json([
          {
            date: "2026-03-01T00:00:00Z",
            answers: [{ name: "caffeine", value: 1, impact: 0.2 }],
          },
        ]);
      }
      return new Response("Not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const provider = new WhoopProvider(mockFetch);
    const result = await provider.sync(ctx.db, new Date("2026-02-28T00:00:00Z"));

    // Should have an hr_stream error
    const hrError = result.errors.find((e) => e.message.includes("hr_stream"));
    expect(hrError).toBeDefined();

    // Journal should still have been synced
    const rows = await ctx.db
      .select()
      .from(journalEntry)
      .where(eq(journalEntry.providerId, "whoop"));
    const caffeine = rows.find((r) => r.question === "caffeine");
    expect(caffeine).toBeDefined();
  });

  it("catches journal errors gracefully", async () => {
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const urlStr = input.toString();
      if (urlStr.includes("auth-service/v3/whoop")) {
        return Response.json({
          AuthenticationResult: { AccessToken: "test-token", RefreshToken: "test-refresh" },
        });
      }
      if (urlStr.includes("users-service/v2/bootstrap")) {
        return Response.json({ id: 10129 });
      }
      if (urlStr.includes("/cycles")) {
        return Response.json([]);
      }
      if (urlStr.includes("metrics-service") || urlStr.includes("metrics/user")) {
        return Response.json({ values: [] });
      }
      if (urlStr.includes("behavior-impact-service")) {
        // Simulate a journal fetch error
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const provider = new WhoopProvider(mockFetch);
    const result = await provider.sync(ctx.db, new Date("2026-02-28T00:00:00Z"));

    // Should have a journal error
    const journalError = result.errors.find((e) => e.message.includes("journal"));
    expect(journalError).toBeDefined();
  });
});

describe("WhoopInternalClient — verifyCode", () => {
  it("verifies code via SMS_MFA challenge", async () => {
    let _attempts = 0;
    const mockFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("auth-service/v3/whoop")) {
        _attempts++;
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        if (body.ChallengeName === "SMS_MFA") {
          return Promise.resolve(
            Response.json({
              AuthenticationResult: { AccessToken: "verified-tok", RefreshToken: "verified-ref" },
            }),
          );
        }
        return Promise.resolve(
          Response.json(
            { __type: "#CodeMismatchException", message: "Wrong code" },
            { status: 400 },
          ),
        );
      }
      if (url.includes("users-service/v2/bootstrap")) {
        return Promise.resolve(Response.json({ id: 55 }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    }) as typeof globalThis.fetch;

    const token = await WhoopInternalClient.verifyCode(
      "session-xyz",
      "123456",
      "user@test.com",
      mockFetch,
    );
    expect(token.accessToken).toBe("verified-tok");
    expect(token.userId).toBe(55);
  });

  it("falls back to SOFTWARE_TOKEN_MFA when SMS_MFA fails", async () => {
    const challengeNames: string[] = [];
    const mockFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("auth-service/v3/whoop")) {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        challengeNames.push(body.ChallengeName as string);
        if (body.ChallengeName === "SMS_MFA") {
          return Promise.resolve(
            Response.json(
              { __type: "#NotAuthorizedException", message: "Wrong challenge" },
              { status: 400 },
            ),
          );
        }
        // SOFTWARE_TOKEN_MFA succeeds
        return Promise.resolve(
          Response.json({
            AuthenticationResult: { AccessToken: "totp-tok", RefreshToken: "totp-ref" },
          }),
        );
      }
      if (url.includes("users-service/v2/bootstrap")) {
        return Promise.resolve(Response.json({ id: 77 }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    }) as typeof globalThis.fetch;

    const token = await WhoopInternalClient.verifyCode(
      "session-xyz",
      "654321",
      "user@test.com",
      mockFetch,
    );
    expect(challengeNames).toContain("SMS_MFA");
    expect(challengeNames).toContain("SOFTWARE_TOKEN_MFA");
    expect(token.accessToken).toBe("totp-tok");
    expect(token.userId).toBe(77);
  });

  it("throws when no tokens in verify response", async () => {
    const mockFetch = ((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("auth-service/v3/whoop")) {
        return Promise.resolve(Response.json({ AuthenticationResult: {} }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    }) as typeof globalThis.fetch;

    await expect(
      WhoopInternalClient.verifyCode("session", "123456", "user@test.com", mockFetch),
    ).rejects.toThrow(/no tokens/i);
  });

  it("throws when bootstrap returns no userId during verifyCode", async () => {
    const mockFetch = ((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("auth-service/v3/whoop")) {
        return Promise.resolve(
          Response.json({
            AuthenticationResult: { AccessToken: "tok", RefreshToken: "ref" },
          }),
        );
      }
      if (url.includes("users-service/v2/bootstrap")) {
        return Promise.resolve(Response.json({ profile: {} }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    }) as typeof globalThis.fetch;

    await expect(
      WhoopInternalClient.verifyCode("session", "123456", "user@test.com", mockFetch),
    ).rejects.toThrow(/user ID/i);
  });
});

describe("WhoopInternalClient — cognitoCall error paths", () => {
  it("throws on non-JSON Cognito response", async () => {
    const mockFetch = ((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("auth-service/v3/whoop")) {
        return Promise.resolve(new Response("Not JSON", { status: 200 }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    }) as typeof globalThis.fetch;

    await expect(WhoopInternalClient.signIn("user@test.com", "pass", mockFetch)).rejects.toThrow(
      /WHOOP auth failed/,
    );
  });

  it("throws with error type from Cognito error response", async () => {
    const mockFetch = ((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("auth-service/v3/whoop")) {
        return Promise.resolve(
          Response.json(
            {
              __type: "com.amazonaws.cognito#UserNotFoundException",
              message: "User does not exist",
            },
            { status: 400 },
          ),
        );
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    }) as typeof globalThis.fetch;

    await expect(WhoopInternalClient.signIn("nobody@test.com", "pass", mockFetch)).rejects.toThrow(
      /UserNotFoundException/,
    );
  });

  it("throws when signIn gets no AccessToken", async () => {
    const mockFetch = ((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("auth-service/v3/whoop")) {
        return Promise.resolve(Response.json({ AuthenticationResult: {} }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    }) as typeof globalThis.fetch;

    await expect(WhoopInternalClient.signIn("user@test.com", "pass", mockFetch)).rejects.toThrow(
      /no tokens/i,
    );
  });

  it("throws when refreshAccessToken gets no AccessToken", async () => {
    const mockFetch = ((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("auth-service/v3/whoop")) {
        return Promise.resolve(Response.json({ AuthenticationResult: {} }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    }) as typeof globalThis.fetch;

    await expect(WhoopInternalClient.refreshAccessToken("old-ref", mockFetch)).rejects.toThrow(
      /no tokens/i,
    );
  });
});

describe("WhoopInternalClient — signIn SOFTWARE_TOKEN_MFA", () => {
  it("returns totp method for SOFTWARE_TOKEN_MFA challenge", async () => {
    const mockFetch = ((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("auth-service/v3/whoop")) {
        return Promise.resolve(
          Response.json({
            ChallengeName: "SOFTWARE_TOKEN_MFA",
            Session: "totp-session",
          }),
        );
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    }) as typeof globalThis.fetch;

    const result = await WhoopInternalClient.signIn("user@test.com", "pass", mockFetch);
    expect(result.type).toBe("verification_required");
    if (result.type === "verification_required") {
      expect(result.method).toBe("totp");
      expect(result.session).toBe("totp-session");
    }
  });
});

describe("WhoopInternalClient._fetchUserId — bootstrap HTTP failure", () => {
  it("returns null when bootstrap returns non-200", async () => {
    const mockFetch = ((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("users-service/v2/bootstrap")) {
        return Promise.resolve(new Response("Unauthorized", { status: 401 }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    }) as typeof globalThis.fetch;

    const userId = await WhoopInternalClient._fetchUserId("bad-token", mockFetch);
    expect(userId).toBeNull();
  });
});

describe("WhoopInternalClient — getCycles response shapes", () => {
  it("handles wrapped object with 'records' key", async () => {
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const urlStr = input.toString();
      if (urlStr.includes("/cycles")) {
        return Response.json({ records: [{ id: 1, user_id: 10, days: ["2026-03-01"] }] });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const client = new WhoopInternalClient(
      { accessToken: "tok", refreshToken: "ref", userId: 10 },
      mockFetch,
    );
    const cycles = await client.getCycles("2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z");
    expect(cycles).toHaveLength(1);
  });

  it("handles wrapped object with 'data' key", async () => {
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const urlStr = input.toString();
      if (urlStr.includes("/cycles")) {
        return Response.json({ data: [{ id: 2 }] });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const client = new WhoopInternalClient(
      { accessToken: "tok", refreshToken: "ref", userId: 10 },
      mockFetch,
    );
    const cycles = await client.getCycles("2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z");
    expect(cycles).toHaveLength(1);
  });

  it("handles wrapped object with 'results' key", async () => {
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const urlStr = input.toString();
      if (urlStr.includes("/cycles")) {
        return Response.json({ results: [{ id: 3 }] });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const client = new WhoopInternalClient(
      { accessToken: "tok", refreshToken: "ref", userId: 10 },
      mockFetch,
    );
    const cycles = await client.getCycles("2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z");
    expect(cycles).toHaveLength(1);
  });

  it("returns empty array for unknown object shape", async () => {
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const urlStr = input.toString();
      if (urlStr.includes("/cycles")) {
        return Response.json({ unknownKey: "value" });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const client = new WhoopInternalClient(
      { accessToken: "tok", refreshToken: "ref", userId: 10 },
      mockFetch,
    );
    const cycles = await client.getCycles("2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z");
    expect(cycles).toHaveLength(0);
  });

  it("returns empty array for null response", async () => {
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const urlStr = input.toString();
      if (urlStr.includes("/cycles")) {
        return Response.json(null);
      }
      return new Response("Not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const client = new WhoopInternalClient(
      { accessToken: "tok", refreshToken: "ref", userId: 10 },
      mockFetch,
    );
    const cycles = await client.getCycles("2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z");
    expect(cycles).toHaveLength(0);
  });
});

describe("WhoopInternalClient — API error handling", () => {
  it("throws on non-200 API response", async () => {
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const urlStr = input.toString();
      if (urlStr.includes("/cycles")) {
        return new Response("Bad Request", { status: 400 });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const client = new WhoopInternalClient(
      { accessToken: "tok", refreshToken: "ref", userId: 10 },
      mockFetch,
    );
    await expect(client.getCycles("2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z")).rejects.toThrow(
      /WHOOP API error/,
    );
  });
});
