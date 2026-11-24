import {
  ProviderRateLimitError,
  ProviderRequestTimeoutError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenSet } from "../../auth/oauth.ts";
import { resolveOAuthTokens } from "../../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../../db/index.ts";
import { upsertProviderActivity } from "../../db/provider-activity-sync.ts";
import { getTokenUserId } from "../../db/token-user-context.ts";
import {
  ProviderAccessDeniedError,
  ProviderAuthError,
  ProviderAuthorizationFailedError,
  RefreshTokenRevokedError,
} from "../auth-errors.ts";
import { SyncRun } from "../sync-run.ts";
import { SyncWindow } from "../sync-window.ts";
import { TrailforksActivityClient, TrailforksMcpToolError } from "./client.ts";
import { TrailforksActivityParseError } from "./parsing.ts";
import { TrailforksProvider } from "./provider.ts";

const telemetryMocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  createProviderRateLimitFetch: vi.fn(
    (_providerId: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) => fetchFn,
  ),
}));

vi.mock("../../lib/error-reporting.ts", () => ({
  captureException: (...args: unknown[]) => telemetryMocks.captureException(...args),
}));

vi.mock("../../lib/provider-rate-limit-fetch.ts", () => ({
  createProviderRateLimitFetch: telemetryMocks.createProviderRateLimitFetch,
}));

vi.mock("../../auth/resolve-tokens.ts", () => ({
  resolveOAuthTokens: vi.fn(),
}));

vi.mock("../../db/provider-activity-sync.ts", () => ({
  upsertProviderActivity: vi.fn(),
}));

const resolveOAuthTokensMock = vi.mocked(resolveOAuthTokens);
const upsertProviderActivityMock = vi.mocked(upsertProviderActivity);

const TOKENS: TokenSet = {
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  scopes: "activities:read",
};

function stubDb(): SyncDatabase {
  const unused = (): never => {
    throw new Error("stub SyncDatabase method should not be called");
  };
  return {
    transaction: unused,
    select: unused,
    insert: unused,
    delete: unused,
    execute: unused,
  };
}

function activityPayload(
  id: number,
  startedAt: string,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    title: `Ride ${id}`,
    started_at: startedAt,
    activitytype: 1,
    link: `https://www.trailforks.com/ridelog/view/${id}/`,
    ...extras,
  };
}

function stubClient(options: {
  listMyActivities: TrailforksActivityClient["listMyActivities"];
  close?: () => Promise<void>;
}): TrailforksActivityClient {
  const client: TrailforksActivityClient = Object.create(TrailforksActivityClient.prototype);
  client.listMyActivities = options.listMyActivities;
  client.close = options.close ?? (async () => undefined);
  return client;
}

function syncRun(options: {
  userId?: string;
  sinceDate?: string;
  untilDate?: string;
  signal?: AbortSignal;
}): SyncRun {
  return new SyncRun({
    db: stubDb(),
    window: SyncWindow.fromDateRange({
      sinceDate: options.sinceDate ?? "2026-09-01",
      untilDate: options.untilDate ?? "2026-09-30",
    }),
    userId: options.userId,
    signal: options.signal,
  });
}

describe("TrailforksProvider", () => {
  beforeEach(() => {
    vi.stubEnv("TRAILFORKS_CLIENT_ID", "trailforks-public-client-id");
    vi.stubEnv("OAUTH_REDIRECT_URI", "https://dofek.example.com/callback");
    telemetryMocks.createProviderRateLimitFetch.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("gates visibility on TRAILFORKS_CLIENT_ID", () => {
    const provider = new TrailforksProvider();
    expect(provider.validate()).toBeNull();

    delete process.env.TRAILFORKS_CLIENT_ID;
    expect(provider.validate()).toBe("TRAILFORKS_CLIENT_ID is not set");
    expect(provider.authSetup()).toBeUndefined();
  });

  it("exposes public-client PKCE OAuth setup with the MCP account resource", () => {
    const provider = new TrailforksProvider();
    const setup = provider.authSetup();

    expect(setup?.oauthConfig).toMatchObject({
      clientId: "trailforks-public-client-id",
      usePkce: true,
      resource: "https://www.trailforks.com/mcp/account/",
      scopes: ["activities:read"],
      revokeUrl: "https://www.trailforks.com/mcp/oauth/revoke/",
    });
    expect(setup?.oauthConfig).not.toHaveProperty("clientSecret");
    expect(setup?.apiBaseUrl).toBe("https://www.trailforks.com/mcp/account/");
  });

  it("builds ridelog/view activity URLs", () => {
    expect(new TrailforksProvider().activityUrl("42001")).toBe(
      "https://www.trailforks.com/ridelog/view/42001/",
    );
  });

  it("uses a one-day scheduled lookback", () => {
    expect(new TrailforksProvider().scheduledSyncLookbackDays).toBe(1);
  });

  it("wraps the constructor fetch with the Trailforks rate-limit helper for OAuth", () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>();
    telemetryMocks.createProviderRateLimitFetch.mockClear();
    new TrailforksProvider(fetchFn);
    expect(telemetryMocks.createProviderRateLimitFetch).toHaveBeenCalled();
    expect(telemetryMocks.createProviderRateLimitFetch.mock.calls.at(-1)?.[0]).toBe("trailforks");
    expect(telemetryMocks.createProviderRateLimitFetch.mock.calls.at(-1)?.[1]).toBe(fetchFn);
  });
});

describe("TrailforksProvider.sync sanitization", () => {
  beforeEach(() => {
    vi.stubEnv("TRAILFORKS_CLIENT_ID", "trailforks-public-client-id");
    vi.stubEnv("OAUTH_REDIRECT_URI", "https://dofek.example.com/callback");
    vi.clearAllMocks();
    resolveOAuthTokensMock.mockResolvedValue(TOKENS);
    telemetryMocks.captureException.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("requires a non-blank user ID", async () => {
    await expect(new TrailforksProvider().sync(syncRun({}))).rejects.toThrow(
      "Trailforks sync requires a user ID",
    );
    await expect(new TrailforksProvider().sync(syncRun({ userId: "   " }))).rejects.toThrow(
      "Trailforks sync requires a user ID",
    );
  });

  it("trims the explicit user ID before resolving tokens", async () => {
    let tokenUserId: string | undefined;
    resolveOAuthTokensMock.mockImplementationOnce(async () => {
      tokenUserId = getTokenUserId();
      throw new Error("missing");
    });

    await new TrailforksProvider().sync(syncRun({ userId: "  user-1  " }));

    expect(tokenUserId).toBe("user-1");
  });

  it("keeps typed auth outcomes without nested OAuth causes", async () => {
    const revoked = new RefreshTokenRevokedError("Trailforks", {
      cause: new Error('{"error":"invalid_grant","private":"activity-secret"}'),
    });
    resolveOAuthTokensMock.mockRejectedValue(revoked);

    const result = await new TrailforksProvider().sync(syncRun({ userId: "user-1" }));

    expect(result.provider).toBe("trailforks");
    expect(result.recordsSynced).toBe(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.duration).toBeLessThan(60_000);
    expect(result.errors).toHaveLength(1);
    const cause = result.errors[0]?.cause;
    expect(cause).toBeInstanceOf(RefreshTokenRevokedError);
    expect(cause).not.toBe(revoked);
    expect(cause instanceof Error ? cause.cause : undefined).toBeUndefined();
  });

  it("keeps generic authorization failures distinct from refresh revocation", async () => {
    resolveOAuthTokensMock.mockRejectedValue(new ProviderAuthorizationFailedError("Trailforks"));

    const result = await new TrailforksProvider().sync(syncRun({ userId: "user-1" }));

    expect(result.errors[0]?.cause).toBeInstanceOf(ProviderAuthError);
    expect(result.errors[0]?.cause).not.toBeInstanceOf(RefreshTokenRevokedError);
    expect(result.errors[0]?.cause).toMatchObject({ authFailureReason: "authorization_failed" });
    expect(result.errors[0]?.message).toBe("Trailforks authorization failed.");
  });

  it("preserves rate-limit retry information while removing the response body", async () => {
    vi.spyOn(TrailforksActivityClient, "connect").mockRejectedValue(
      new ProviderRateLimitError({
        providerId: "trailforks",
        statusCode: 429,
        message: "private response",
        responseBody: "private response",
        retryAfterSeconds: 45,
      }),
    );

    const result = new TrailforksProvider().sync(syncRun({ userId: "user-1" }));

    await expect(result).rejects.toBeInstanceOf(ProviderRateLimitError);
    await expect(result).rejects.toMatchObject({
      message: "Trailforks rate limit exceeded.",
      responseBody: "",
      retryAfterSeconds: 45,
    });
  });

  it("rethrows redacted service-unavailable and timeout transport failures", async () => {
    vi.spyOn(TrailforksActivityClient, "connect").mockRejectedValueOnce(
      new ProviderServiceUnavailableError({
        providerId: "trailforks",
        statusCode: 503,
        message: "private 503 body",
        responseBody: "private 503 body",
        retryAfterSeconds: 30,
      }),
    );

    await expect(
      new TrailforksProvider().sync(syncRun({ userId: "user-1" })),
    ).rejects.toMatchObject({
      name: "ProviderServiceUnavailableError",
      message: "Trailforks is temporarily unavailable (503). Try again.",
      responseBody: "",
      retryAfterSeconds: 30,
    });

    vi.spyOn(TrailforksActivityClient, "connect").mockRejectedValueOnce(
      new ProviderRequestTimeoutError({
        providerId: "trailforks",
        timeoutMs: 1_000,
        cause: new Error("socket hang"),
      }),
    );

    const timeout = new TrailforksProvider().sync(syncRun({ userId: "user-1" }));
    await expect(timeout).rejects.toBeInstanceOf(ProviderRequestTimeoutError);
    await expect(timeout).rejects.toMatchObject({ cause: undefined, timeoutMs: 1_000 });
  });

  it("rethrows cancellation without turning it into a SyncError", async () => {
    const abortError = new DOMException("The operation was aborted", "AbortError");
    vi.spyOn(TrailforksActivityClient, "connect").mockRejectedValue(abortError);

    await expect(new TrailforksProvider().sync(syncRun({ userId: "user-1" }))).rejects.toBe(
      abortError,
    );
  });

  it("returns sanitized access-denied guidance from MCP", async () => {
    vi.spyOn(TrailforksActivityClient, "connect").mockRejectedValue(
      new ProviderAccessDeniedError("Trailforks denied access. Confirm Pro/Outside+."),
    );

    const result = await new TrailforksProvider().sync(syncRun({ userId: "user-1" }));

    expect(result.errors).toEqual([
      {
        message: "Trailforks denied access. Confirm Pro/Outside+.",
        cause: expect.any(ProviderAccessDeniedError),
      },
    ]);
    expect(result.errors[0]?.cause).not.toHaveProperty("cause");
  });

  it("returns typed MCP and parse failures with sanitized messages", async () => {
    vi.spyOn(TrailforksActivityClient, "connect").mockResolvedValue(
      stubClient({
        listMyActivities: vi.fn(async () => {
          throw new TrailforksMcpToolError();
        }),
      }),
    );

    const mcpResult = await new TrailforksProvider().sync(syncRun({ userId: "user-1" }));
    expect(mcpResult.errors[0]).toMatchObject({
      message: "Trailforks could not complete the activity list.",
      cause: expect.any(TrailforksMcpToolError),
    });

    vi.spyOn(TrailforksActivityClient, "connect").mockResolvedValue(
      stubClient({
        listMyActivities: vi.fn(async () => ({
          content: [],
          structuredContent: { activities: [{ id: 1, started_at: "2026-09-19" }] },
        })),
      }),
    );

    const parseResult = await new TrailforksProvider().sync(syncRun({ userId: "user-1" }));
    expect(parseResult.errors[0]).toMatchObject({
      message: "Trailforks returned an invalid activity list.",
      cause: expect.any(TrailforksActivityParseError),
    });
    expect(parseResult.errors[0]).not.toHaveProperty("externalId");
  });

  it("filters by the inclusive sync window boundaries", async () => {
    const close = vi.fn(async () => undefined);
    vi.spyOn(TrailforksActivityClient, "connect").mockResolvedValue(
      stubClient({
        listMyActivities: vi.fn(async () => ({
          content: [],
          structuredContent: {
            activities: [
              activityPayload(1, "2026-08-31T23:59:59.999Z"),
              activityPayload(2, "2026-09-01T00:00:00.000Z"),
              activityPayload(3, "2026-09-30T23:59:59.999Z"),
              activityPayload(4, "2026-10-01T00:00:00.000Z"),
            ],
          },
        })),
        close,
      }),
    );
    upsertProviderActivityMock.mockResolvedValue({ id: "row" });

    const result = await new TrailforksProvider().sync(syncRun({ userId: "user-1" }));

    expect(result).toMatchObject({
      provider: "trailforks",
      recordsSynced: 2,
      errors: [],
    });
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(upsertProviderActivityMock.mock.calls.map((call) => call[1]?.externalId)).toEqual([
      "2",
      "3",
    ]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("uses other activity type on insert when sport is omitted and skips it on conflict update", async () => {
    vi.spyOn(TrailforksActivityClient, "connect").mockResolvedValue(
      stubClient({
        listMyActivities: vi.fn(async () => ({
          content: [],
          structuredContent: {
            activities: [
              {
                id: 9,
                started_at: "2026-09-10T12:00:00Z",
              },
            ],
          },
        })),
      }),
    );
    upsertProviderActivityMock.mockResolvedValue({ id: "row" });

    await new TrailforksProvider().sync(syncRun({ userId: "user-1" }));

    const insert = upsertProviderActivityMock.mock.calls[0]?.[1];
    const update = upsertProviderActivityMock.mock.calls[0]?.[2];
    expect(insert).toMatchObject({
      externalId: "9",
      activityType: { canonicalType: "other", modality: null, providerType: "unknown" },
      sourceName: "Trailforks",
    });
    expect(insert).not.toHaveProperty("name");
    expect(insert).not.toHaveProperty("endedAt");
    expect(update).toMatchObject({
      startedAt: new Date("2026-09-10T12:00:00Z"),
      sourceName: "Trailforks",
    });
    expect(update).not.toHaveProperty("name");
    expect(update).not.toHaveProperty("endedAt");
    expect(update?.activityType).toBeUndefined();
  });

  it("aborts on the first write failure without attaching raw causes and keeps earlier recordsSynced", async () => {
    const close = vi.fn(async () => undefined);
    vi.spyOn(TrailforksActivityClient, "connect").mockResolvedValue(
      stubClient({
        listMyActivities: vi.fn(async () => ({
          content: [],
          structuredContent: {
            activities: [
              activityPayload(1, "2026-09-10T12:00:00Z"),
              activityPayload(2, "2026-09-11T12:00:00Z"),
            ],
          },
        })),
        close,
      }),
    );
    upsertProviderActivityMock
      .mockResolvedValueOnce({ id: "row-1" })
      .mockRejectedValueOnce(new Error('insert failed: {"raw":"private-activity"}'));

    const result = await new TrailforksProvider().sync(syncRun({ userId: "user-1" }));

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toEqual([
      {
        message: "Failed to save a Trailforks activity.",
        externalId: "2",
      },
    ]);
    expect(telemetryMocks.captureException).toHaveBeenCalledWith(
      expect.any(TrailforksMcpToolError),
      {
        tags: { provider: "trailforks", mcpPhase: "persist" },
        extra: { errorName: "Error", externalId: "2" },
      },
    );
    expect(JSON.stringify(telemetryMocks.captureException.mock.calls)).not.toContain(
      "private-activity",
    );
    expect(upsertProviderActivityMock).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports close failures without replacing the sync result", async () => {
    vi.spyOn(TrailforksActivityClient, "connect").mockResolvedValue(
      stubClient({
        listMyActivities: vi.fn(async () => ({
          content: [],
          structuredContent: { activities: [] },
        })),
        close: async () => {
          throw new Error("close blew up");
        },
      }),
    );

    const result = await new TrailforksProvider().sync(syncRun({ userId: "user-1" }));

    expect(result).toMatchObject({ provider: "trailforks", recordsSynced: 0, errors: [] });
    expect(telemetryMocks.captureException).toHaveBeenCalledWith(
      expect.any(TrailforksMcpToolError),
      {
        tags: { provider: "trailforks", mcpPhase: "close" },
        extra: { errorName: "Error" },
      },
    );
  });

  it("passes the run AbortSignal into MCP connect", async () => {
    const controller = new AbortController();
    const connect = vi
      .spyOn(TrailforksActivityClient, "connect")
      .mockImplementation(async (options) => {
        expect(options.signal).toBe(controller.signal);
        throw new DOMException("The operation was aborted", "AbortError");
      });

    await expect(
      new TrailforksProvider().sync(syncRun({ userId: "user-1", signal: controller.signal })),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(connect).toHaveBeenCalledOnce();
  });

  it("resolves OAuth with the Trailforks provider identity", async () => {
    resolveOAuthTokensMock.mockRejectedValue(new Error("missing tokens"));
    await new TrailforksProvider().sync(syncRun({ userId: "user-1" }));

    expect(resolveOAuthTokensMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "trailforks",
        providerName: "Trailforks",
      }),
    );
    const options = resolveOAuthTokensMock.mock.calls[0]?.[0];
    expect(options?.getOAuthConfig?.()).toMatchObject({
      clientId: "trailforks-public-client-id",
      resource: "https://www.trailforks.com/mcp/account/",
    });
  });
});
