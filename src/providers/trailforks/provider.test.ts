import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenSet } from "../../auth/oauth.ts";
import { resolveOAuthTokens } from "../../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../../db/index.ts";
import { upsertProviderActivity } from "../../db/provider-activity-sync.ts";
import { RefreshTokenRevokedError } from "../auth-errors.ts";
import { SyncRun } from "../sync-run.ts";
import { SyncWindow } from "../sync-window.ts";
import { TrailforksActivityClient } from "./client.ts";
import { TrailforksProvider } from "./provider.ts";

describe("TrailforksProvider", () => {
  beforeEach(() => {
    vi.stubEnv("TRAILFORKS_CLIENT_ID", "trailforks-public-client-id");
    vi.stubEnv("OAUTH_REDIRECT_URI", "https://dofek.example.com/callback");
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
});

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

function activityPayload(id: number, startedAt: string) {
  return {
    id,
    title: `Ride ${id}`,
    started_at: startedAt,
    activitytype: 1,
    link: `https://www.trailforks.com/ridelog/view/${id}/`,
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

describe("TrailforksProvider.sync sanitization", () => {
  beforeEach(() => {
    vi.stubEnv("TRAILFORKS_CLIENT_ID", "trailforks-public-client-id");
    vi.stubEnv("OAUTH_REDIRECT_URI", "https://dofek.example.com/callback");
    vi.clearAllMocks();
    resolveOAuthTokensMock.mockResolvedValue(TOKENS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps typed auth outcomes without nested OAuth causes", async () => {
    const revoked = new RefreshTokenRevokedError("Trailforks", {
      cause: new Error('{"error":"invalid_grant","private":"activity-secret"}'),
    });
    resolveOAuthTokensMock.mockRejectedValue(revoked);

    const result = await new TrailforksProvider().sync(
      new SyncRun({
        db: stubDb(),
        window: SyncWindow.fromDateRange({ sinceDate: "2026-09-01", untilDate: "2026-09-30" }),
        userId: "user-1",
      }),
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    const cause = result.errors[0]?.cause;
    expect(cause).toBeInstanceOf(RefreshTokenRevokedError);
    expect(cause).not.toBe(revoked);
    expect(cause instanceof Error ? cause.cause : undefined).toBeUndefined();
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

    const result = new TrailforksProvider().sync(
      new SyncRun({
        db: stubDb(),
        window: SyncWindow.fromDateRange({ sinceDate: "2026-09-01", untilDate: "2026-09-30" }),
        userId: "user-1",
      }),
    );

    await expect(result).rejects.toBeInstanceOf(ProviderRateLimitError);
    await expect(result).rejects.toMatchObject({
      message: "Trailforks rate limit exceeded.",
      responseBody: "",
      retryAfterSeconds: 45,
    });
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

    const result = await new TrailforksProvider().sync(
      new SyncRun({
        db: stubDb(),
        window: SyncWindow.fromDateRange({ sinceDate: "2026-09-01", untilDate: "2026-09-30" }),
        userId: "user-1",
      }),
    );

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toEqual([
      {
        message: "Failed to save a Trailforks activity.",
        externalId: "2",
      },
    ]);
    expect(upsertProviderActivityMock).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });
});
