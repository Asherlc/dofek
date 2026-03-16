import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../db/__tests__/test-helpers.ts";
import { journalEntry } from "../../db/schema.ts";
import { ensureProvider, saveTokens } from "../../db/tokens.ts";
import { WhoopClient, WhoopProvider, type WhoopSleepRecord } from "../whoop.ts";

const server = setupServer();

// ============================================================
// Coverage tests for uncovered paths:
// - HR stream error (line ~1143)
// - Journal error (lines ~1178-1182)
// - cognitoCall error paths
// - parseJournalResponse edge cases
// - WhoopClient.verifyCode
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
    server.listen({ onUnhandledRequest: "error" });
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "whoop", "WHOOP");
    await saveTokens(ctx.db, "whoop", {
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      scopes: "userId:10129",
    });
  }, 60_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    if (ctx) await ctx.cleanup();
  });

  it("catches HR stream errors and continues to journal sync", async () => {
    server.use(
      http.post("https://api.prod.whoop.com/auth-service/v3/whoop/", () => {
        return HttpResponse.json({
          AuthenticationResult: { AccessToken: "test-token", RefreshToken: "test-refresh" },
        });
      }),
      http.get("https://api.prod.whoop.com/users-service/v2/bootstrap/", () => {
        return HttpResponse.json({ id: 10129 });
      }),
      http.get("https://api.prod.whoop.com/core-details-bff/v0/cycles/details", () => {
        return HttpResponse.json([]);
      }),
      http.get(
        "https://api.prod.whoop.com/weightlifting-service/v2/weightlifting-workout/:id",
        () => {
          return new HttpResponse("Not found", { status: 404 });
        },
      ),
      http.get("https://api.prod.whoop.com/metrics-service/v1/metrics/user/:userId", () => {
        return new HttpResponse("Internal Server Error", { status: 500 });
      }),
      http.get("https://api.prod.whoop.com/behavior-impact-service/v1/impact", () => {
        return HttpResponse.json([
          {
            date: "2026-03-01T00:00:00Z",
            answers: [{ name: "caffeine", value: 1, impact: 0.2 }],
          },
        ]);
      }),
    );

    const provider = new WhoopProvider();
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
    server.use(
      http.post("https://api.prod.whoop.com/auth-service/v3/whoop/", () => {
        return HttpResponse.json({
          AuthenticationResult: { AccessToken: "test-token", RefreshToken: "test-refresh" },
        });
      }),
      http.get("https://api.prod.whoop.com/users-service/v2/bootstrap/", () => {
        return HttpResponse.json({ id: 10129 });
      }),
      http.get("https://api.prod.whoop.com/core-details-bff/v0/cycles/details", () => {
        return HttpResponse.json([]);
      }),
      http.get("https://api.prod.whoop.com/metrics-service/v1/metrics/user/:userId", () => {
        return HttpResponse.json({ values: [] });
      }),
      http.get("https://api.prod.whoop.com/behavior-impact-service/v1/impact", () => {
        return new HttpResponse("Internal Server Error", { status: 500 });
      }),
    );

    const provider = new WhoopProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-28T00:00:00Z"));

    // Should have a journal error
    const journalError = result.errors.find((e) => e.message.includes("journal"));
    expect(journalError).toBeDefined();
  });
});

describe("WhoopClient — verifyCode", () => {
  const clientServer = setupServer();

  beforeAll(() => {
    clientServer.listen({ onUnhandledRequest: "error" });
  });

  afterEach(() => {
    clientServer.resetHandlers();
  });

  afterAll(() => {
    clientServer.close();
  });

  it("verifies code via SMS_MFA challenge", async () => {
    clientServer.use(
      http.post("https://api.prod.whoop.com/auth-service/v3/whoop/", async ({ request }) => {
        const raw = await request.json();
        const body =
          typeof raw === "object" && raw !== null ? (raw satisfies Record<string, unknown>) : {};
        if (body.ChallengeName === "SMS_MFA") {
          return HttpResponse.json({
            AuthenticationResult: { AccessToken: "verified-tok", RefreshToken: "verified-ref" },
          });
        }
        return HttpResponse.json(
          { __type: "#CodeMismatchException", message: "Wrong code" },
          { status: 400 },
        );
      }),
      http.get("https://api.prod.whoop.com/users-service/v2/bootstrap/", () => {
        return HttpResponse.json({ id: 55 });
      }),
    );

    const token = await WhoopClient.verifyCode("session-xyz", "123456", "user@test.com");
    expect(token.accessToken).toBe("verified-tok");
    expect(token.userId).toBe(55);
  });

  it("falls back to SOFTWARE_TOKEN_MFA when SMS_MFA fails", async () => {
    const challengeNames: string[] = [];

    clientServer.use(
      http.post("https://api.prod.whoop.com/auth-service/v3/whoop/", async ({ request }) => {
        const raw = await request.json();
        const body =
          typeof raw === "object" && raw !== null ? (raw satisfies Record<string, unknown>) : {};
        challengeNames.push(String(body.ChallengeName));
        if (body.ChallengeName === "SMS_MFA") {
          return HttpResponse.json(
            { __type: "#NotAuthorizedException", message: "Wrong challenge" },
            { status: 400 },
          );
        }
        return HttpResponse.json({
          AuthenticationResult: { AccessToken: "totp-tok", RefreshToken: "totp-ref" },
        });
      }),
      http.get("https://api.prod.whoop.com/users-service/v2/bootstrap/", () => {
        return HttpResponse.json({ id: 77 });
      }),
    );

    const token = await WhoopClient.verifyCode("session-xyz", "654321", "user@test.com");
    expect(challengeNames).toContain("SMS_MFA");
    expect(challengeNames).toContain("SOFTWARE_TOKEN_MFA");
    expect(token.accessToken).toBe("totp-tok");
    expect(token.userId).toBe(77);
  });

  it("throws when no tokens in verify response", async () => {
    clientServer.use(
      http.post("https://api.prod.whoop.com/auth-service/v3/whoop/", () => {
        return HttpResponse.json({ AuthenticationResult: {} });
      }),
    );

    await expect(WhoopClient.verifyCode("session", "123456", "user@test.com")).rejects.toThrow(
      /no tokens/i,
    );
  });

  it("throws when bootstrap returns no userId during verifyCode", async () => {
    clientServer.use(
      http.post("https://api.prod.whoop.com/auth-service/v3/whoop/", () => {
        return HttpResponse.json({
          AuthenticationResult: { AccessToken: "tok", RefreshToken: "ref" },
        });
      }),
      http.get("https://api.prod.whoop.com/users-service/v2/bootstrap/", () => {
        return HttpResponse.json({ profile: {} });
      }),
    );

    await expect(WhoopClient.verifyCode("session", "123456", "user@test.com")).rejects.toThrow(
      /user ID/i,
    );
  });
});

describe("WhoopClient — cognitoCall error paths", () => {
  const cognitoServer = setupServer();

  beforeAll(() => {
    cognitoServer.listen({ onUnhandledRequest: "error" });
  });

  afterEach(() => {
    cognitoServer.resetHandlers();
  });

  afterAll(() => {
    cognitoServer.close();
  });

  it("throws on non-JSON Cognito response", async () => {
    cognitoServer.use(
      http.post("https://api.prod.whoop.com/auth-service/v3/whoop/", () => {
        return new HttpResponse("Not JSON", { status: 200 });
      }),
    );

    await expect(WhoopClient.signIn("user@test.com", "pass")).rejects.toThrow(/WHOOP auth failed/);
  });

  it("throws with error type from Cognito error response", async () => {
    cognitoServer.use(
      http.post("https://api.prod.whoop.com/auth-service/v3/whoop/", () => {
        return HttpResponse.json(
          {
            __type: "com.amazonaws.cognito#UserNotFoundException",
            message: "User does not exist",
          },
          { status: 400 },
        );
      }),
    );

    await expect(WhoopClient.signIn("nobody@test.com", "pass")).rejects.toThrow(
      /UserNotFoundException/,
    );
  });

  it("throws when signIn gets no AccessToken", async () => {
    cognitoServer.use(
      http.post("https://api.prod.whoop.com/auth-service/v3/whoop/", () => {
        return HttpResponse.json({ AuthenticationResult: {} });
      }),
    );

    await expect(WhoopClient.signIn("user@test.com", "pass")).rejects.toThrow(/no tokens/i);
  });

  it("throws when refreshAccessToken gets no AccessToken", async () => {
    cognitoServer.use(
      http.post("https://api.prod.whoop.com/auth-service/v3/whoop/", () => {
        return HttpResponse.json({ AuthenticationResult: {} });
      }),
    );

    await expect(WhoopClient.refreshAccessToken("old-ref")).rejects.toThrow(/no tokens/i);
  });
});

describe("WhoopClient — signIn SOFTWARE_TOKEN_MFA", () => {
  const mfaServer = setupServer();

  beforeAll(() => {
    mfaServer.listen({ onUnhandledRequest: "error" });
  });

  afterEach(() => {
    mfaServer.resetHandlers();
  });

  afterAll(() => {
    mfaServer.close();
  });

  it("returns totp method for SOFTWARE_TOKEN_MFA challenge", async () => {
    mfaServer.use(
      http.post("https://api.prod.whoop.com/auth-service/v3/whoop/", () => {
        return HttpResponse.json({
          ChallengeName: "SOFTWARE_TOKEN_MFA",
          Session: "totp-session",
        });
      }),
    );

    const result = await WhoopClient.signIn("user@test.com", "pass");
    expect(result.type).toBe("verification_required");
    if (result.type === "verification_required") {
      expect(result.method).toBe("totp");
      expect(result.session).toBe("totp-session");
    }
  });
});

describe("WhoopClient._fetchUserId — bootstrap HTTP failure", () => {
  const bootstrapServer = setupServer();

  beforeAll(() => {
    bootstrapServer.listen({ onUnhandledRequest: "error" });
  });

  afterEach(() => {
    bootstrapServer.resetHandlers();
  });

  afterAll(() => {
    bootstrapServer.close();
  });

  it("returns null when bootstrap returns non-200", async () => {
    bootstrapServer.use(
      http.get("https://api.prod.whoop.com/users-service/v2/bootstrap/", () => {
        return new HttpResponse("Unauthorized", { status: 401 });
      }),
    );

    const userId = await WhoopClient._fetchUserId("bad-token", globalThis.fetch);
    expect(userId).toBeNull();
  });
});

describe("WhoopClient — getCycles response shapes", () => {
  const cyclesServer = setupServer();

  beforeAll(() => {
    cyclesServer.listen({ onUnhandledRequest: "error" });
  });

  afterEach(() => {
    cyclesServer.resetHandlers();
  });

  afterAll(() => {
    cyclesServer.close();
  });

  it("handles wrapped object with 'records' key", async () => {
    cyclesServer.use(
      http.get("https://api.prod.whoop.com/core-details-bff/v0/cycles/details", () => {
        return HttpResponse.json({ records: [{ id: 1, user_id: 10, days: ["2026-03-01"] }] });
      }),
    );

    const client = new WhoopClient({ accessToken: "tok", refreshToken: "ref", userId: 10 });
    const cycles = await client.getCycles("2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z");
    expect(cycles).toHaveLength(1);
  });

  it("handles wrapped object with 'data' key", async () => {
    cyclesServer.use(
      http.get("https://api.prod.whoop.com/core-details-bff/v0/cycles/details", () => {
        return HttpResponse.json({ data: [{ id: 2 }] });
      }),
    );

    const client = new WhoopClient({ accessToken: "tok", refreshToken: "ref", userId: 10 });
    const cycles = await client.getCycles("2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z");
    expect(cycles).toHaveLength(1);
  });

  it("handles wrapped object with 'results' key", async () => {
    cyclesServer.use(
      http.get("https://api.prod.whoop.com/core-details-bff/v0/cycles/details", () => {
        return HttpResponse.json({ results: [{ id: 3 }] });
      }),
    );

    const client = new WhoopClient({ accessToken: "tok", refreshToken: "ref", userId: 10 });
    const cycles = await client.getCycles("2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z");
    expect(cycles).toHaveLength(1);
  });

  it("returns empty array for unknown object shape", async () => {
    cyclesServer.use(
      http.get("https://api.prod.whoop.com/core-details-bff/v0/cycles/details", () => {
        return HttpResponse.json({ unknownKey: "value" });
      }),
    );

    const client = new WhoopClient({ accessToken: "tok", refreshToken: "ref", userId: 10 });
    const cycles = await client.getCycles("2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z");
    expect(cycles).toHaveLength(0);
  });

  it("returns empty array for null response", async () => {
    cyclesServer.use(
      http.get("https://api.prod.whoop.com/core-details-bff/v0/cycles/details", () => {
        return HttpResponse.json(null);
      }),
    );

    const client = new WhoopClient({ accessToken: "tok", refreshToken: "ref", userId: 10 });
    const cycles = await client.getCycles("2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z");
    expect(cycles).toHaveLength(0);
  });
});

describe("WhoopClient — API error handling", () => {
  const apiServer = setupServer();

  beforeAll(() => {
    apiServer.listen({ onUnhandledRequest: "error" });
  });

  afterEach(() => {
    apiServer.resetHandlers();
  });

  afterAll(() => {
    apiServer.close();
  });

  it("throws on non-200 API response", async () => {
    apiServer.use(
      http.get("https://api.prod.whoop.com/core-details-bff/v0/cycles/details", () => {
        return new HttpResponse("Bad Request", { status: 400 });
      }),
    );

    const client = new WhoopClient({ accessToken: "tok", refreshToken: "ref", userId: 10 });
    await expect(client.getCycles("2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z")).rejects.toThrow(
      /WHOOP API error/,
    );
  });
});
