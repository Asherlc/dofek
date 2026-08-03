import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  AccountErasureIdentityFencedError: class AccountErasureIdentityFencedError extends Error {},
  AccountErasureUserFencedError: class AccountErasureUserFencedError extends Error {},
  captureException: vi.fn(),
  executeWithSchema: vi.fn(),
  invalidateAllUserQueries: vi.fn(),
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  oauthStateDelete: vi.fn(),
  repositoryConstructor: vi.fn(),
  repositoryUpsert: vi.fn(),
  lockIdentityFence: vi.fn(),
  withUserWriteFence: vi.fn(),
}));

const database = {};
const transaction = { execute: vi.fn() };

vi.mock("@sentry/node", () => ({ captureException: mocks.captureException }));
vi.mock("dofek/auth/oauth", () => ({
  getOAuthRedirectUri: () => "https://dofek.example/callback",
}));
vi.mock("dofek/db/account-erasure", () => ({
  AccountErasureIdentityFencedError: mocks.AccountErasureIdentityFencedError,
  AccountErasureUserFencedError: mocks.AccountErasureUserFencedError,
  lockAndAssertAccountErasureIdentityWriteFence: mocks.lockIdentityFence,
  withAccountErasureUserWriteFence: mocks.withUserWriteFence,
}));
vi.mock("dofek/lib/cache", () => ({
  invalidateAllUserQueries: mocks.invalidateAllUserQueries,
}));
vi.mock("../../lib/typed-sql.ts", () => ({
  executeWithSchema: mocks.executeWithSchema,
}));
vi.mock("../../logger.ts", () => ({
  logger: { error: mocks.loggerError, info: mocks.loggerInfo, warn: mocks.loggerWarn },
}));
vi.mock("../../repositories/slack-installation-repository.ts", () => ({
  SlackInstallationRepository: class {
    constructor(databaseArg: unknown) {
      mocks.repositoryConstructor(databaseArg);
    }

    upsertMemberInstallation(input: unknown) {
      return mocks.repositoryUpsert(input);
    }
  },
}));
vi.mock("./shared.ts", () => ({
  getDb: () => database,
  getOAuthStateStoreRef: () => ({ delete: mocks.oauthStateDelete }),
  oauthSuccessHtml: () => "<html>success</html>",
  SLACK_SCOPES: [],
}));
vi.mock("../../auth/cookies.ts", () => ({
  getSessionIdFromRequest: vi.fn(),
}));
vi.mock("../../auth/session.ts", () => ({
  validateSession: vi.fn(),
}));

import { handleSlackCallback } from "./slack-oauth.ts";

function mockOf<T extends object>(partial: Partial<T>): T {
  const result: T = partial;
  return result;
}

function response(): Response {
  return mockOf<Response>({
    send: vi.fn(),
    status: vi.fn().mockReturnThis(),
  });
}

const slackState = {
  providerId: "slack",
  intent: "data" as const,
  userId: "user-1",
};

describe("handleSlackCallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SLACK_CLIENT_ID = "client-id";
    process.env.SLACK_CLIENT_SECRET = "client-secret";
    mocks.executeWithSchema.mockResolvedValue([]);
    mocks.repositoryUpsert.mockResolvedValue(undefined);
    mocks.lockIdentityFence.mockResolvedValue(undefined);
    mocks.withUserWriteFence.mockImplementation(
      async (
        _database: unknown,
        _userId: string,
        operation: (database: typeof transaction) => Promise<unknown>,
      ) => operation(transaction),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SLACK_CLIENT_ID;
    delete process.env.SLACK_CLIENT_SECRET;
  });

  it("holds the user write fence across token exchange and installation persistence", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        ok: true,
        access_token: "xoxb-token",
        team: { id: "T1", name: "Workspace" },
        authed_user: { id: "U1" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await handleSlackCallback(mockOf<Request>({}), response(), "code", "state", slackState);

    expect(mocks.withUserWriteFence).toHaveBeenCalledWith(database, "user-1", expect.any(Function));
    expect(mocks.repositoryConstructor).toHaveBeenCalledWith(transaction);
    expect(mocks.repositoryUpsert).toHaveBeenCalledOnce();
    expect(mocks.repositoryUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        slackUserId: "U1",
        teamId: "T1",
        userId: "user-1",
      }),
    );
    expect(mocks.lockIdentityFence).toHaveBeenCalledWith(transaction, [
      {
        authProvider: "slack",
        kind: "provider_account",
        providerAccountId: "U1",
      },
    ]);
    expect(transaction.execute).toHaveBeenCalledOnce();
  });

  it("does not exchange a Slack code when the account-erasure fence rejects", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.withUserWriteFence.mockRejectedValueOnce(new Error("Account erasure is active"));

    await expect(
      handleSlackCallback(mockOf<Request>({}), response(), "code", "state", slackState),
    ).rejects.toThrow("Account erasure is active");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a missing Slack OAuth state after deleting the state token", async () => {
    const res = response();

    await handleSlackCallback(mockOf<Request>({}), res, "code", "state", null);

    expect(mocks.oauthStateDelete).toHaveBeenCalledWith("state");
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith("Unknown or expired Slack OAuth state");
  });

  it.each([
    ["not ok", { ok: false, error: "invalid_code" }],
    ["without a bot token", { ok: true, team: { id: "T1" }, authed_user: { id: "U1" } }],
    ["without a team", { ok: true, access_token: "xoxb-token", authed_user: { id: "U1" } }],
    ["without an installer", { ok: true, access_token: "xoxb-token", team: { id: "T1" } }],
  ])("returns a controlled failure for a Slack response %s", async (_label, tokenResponse) => {
    const fetchMock = vi.fn(async () => Response.json(tokenResponse));
    vi.stubGlobal("fetch", fetchMock);
    const res = response();

    await handleSlackCallback(mockOf<Request>({}), res, "code", "state", slackState);

    expect(mocks.repositoryUpsert).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith("Slack OAuth failed");
  });

  it("persists optional Slack installation fields as null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          access_token: "xoxb-token",
          authed_user: { id: "U1" },
          ok: true,
          team: { id: "T1" },
        }),
      ),
    );

    await handleSlackCallback(mockOf<Request>({}), response(), "code", "state", slackState);

    expect(mocks.repositoryUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: null,
        botId: null,
        botUserId: null,
        installerSlackUserId: "U1",
        teamName: null,
      }),
    );
  });

  it("does not migrate entries when the existing Slack link already belongs to the user", async () => {
    mocks.executeWithSchema.mockResolvedValueOnce([{ user_id: "user-1" }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          access_token: "xoxb-token",
          authed_user: { id: "U1" },
          ok: true,
          team: { id: "T1", name: "Workspace" },
        }),
      ),
    );

    await handleSlackCallback(mockOf<Request>({}), response(), "code", "state", slackState);

    expect(transaction.execute).toHaveBeenCalledOnce();
    expect(mocks.invalidateAllUserQueries).toHaveBeenCalledWith("user-1");
  });

  it("does not send fenced Slack OAuth identity or payload data to logs or Sentry", async () => {
    const privateValues = [
      "user-private-fence-2001",
      "T-PRIVATE-FENCE-2001",
      "U-PRIVATE-FENCE-2001",
      "raw-provider-payload-2001",
    ];
    const privateState = {
      ...slackState,
      userId: privateValues[0],
    };
    const fenceError = new mocks.AccountErasureUserFencedError(privateValues.slice(1).join(":"));
    mocks.withUserWriteFence.mockRejectedValueOnce(fenceError);

    await expect(
      handleSlackCallback(mockOf<Request>({}), response(), "private-code", "state", privateState),
    ).rejects.toBe(fenceError);

    const emittedTelemetry = JSON.stringify([
      mocks.captureException.mock.calls,
      mocks.loggerError.mock.calls,
      mocks.loggerInfo.mock.calls,
      mocks.loggerWarn.mock.calls,
    ]);
    for (const privateValue of privateValues) {
      expect(emittedTelemetry).not.toContain(privateValue);
    }
  });

  it("does not interpolate stable identities into successful linking logs", async () => {
    const privateValues = [
      "user-private-success-2001",
      "orphan-private-success-2001",
      "T-PRIVATE-SUCCESS-2001",
      "U-PRIVATE-SUCCESS-2001",
      "Workspace Private Success 2001",
    ];
    mocks.executeWithSchema.mockResolvedValueOnce([{ user_id: privateValues[1] }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          access_token: "xoxb-private-success-2001",
          authed_user: { id: privateValues[3] },
          ok: true,
          team: { id: privateValues[2], name: privateValues[4] },
        }),
      ),
    );

    await handleSlackCallback(mockOf<Request>({}), response(), "code", "state", {
      ...slackState,
      userId: privateValues[0],
    });

    const emittedTelemetry = JSON.stringify([
      mocks.captureException.mock.calls,
      mocks.loggerError.mock.calls,
      mocks.loggerInfo.mock.calls,
      mocks.loggerWarn.mock.calls,
    ]);
    for (const privateValue of privateValues) {
      expect(emittedTelemetry).not.toContain(privateValue);
    }
  });

  it("reports unexpected persistence failures with operation-only tags", async () => {
    const persistenceError = new Error("database unavailable");
    mocks.withUserWriteFence.mockRejectedValueOnce(persistenceError);

    await expect(
      handleSlackCallback(mockOf<Request>({}), response(), "code", "state", slackState),
    ).rejects.toBe(persistenceError);

    expect(mocks.captureException).toHaveBeenCalledWith(persistenceError, {
      tags: { operation: "persist-installation", source: "slack-oauth" },
    });
  });

  it.each([
    new mocks.AccountErasureIdentityFencedError(),
    new mocks.AccountErasureUserFencedError(),
  ])("does not report account-erasure fence failures to Sentry", async (fenceError) => {
    mocks.withUserWriteFence.mockRejectedValueOnce(fenceError);

    await expect(
      handleSlackCallback(mockOf<Request>({}), response(), "code", "state", slackState),
    ).rejects.toBe(fenceError);

    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "[auth] Slack OAuth rejected by account-erasure fence",
    );
  });

  it("revokes a newly issued bot token when durable persistence fails", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/oauth.v2.access")) {
        return Response.json({
          ok: true,
          access_token: "xoxb-orphan",
          team: { id: "T1", name: "Workspace" },
          authed_user: { id: "U1" },
        });
      }
      if (url.endsWith("/auth.revoke")) {
        return Response.json({ ok: true });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    mocks.repositoryUpsert.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      handleSlackCallback(mockOf<Request>({}), response(), "code", "state", slackState),
    ).rejects.toThrow("database unavailable");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/auth.revoke",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer xoxb-orphan" },
      }),
    );
  });

  it("revokes a newly issued bot token when the fenced transaction fails to commit", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/oauth.v2.access")) {
        return Response.json({
          ok: true,
          access_token: "xoxb-orphan",
          team: { id: "T1", name: "Workspace" },
          authed_user: { id: "U1" },
        });
      }
      if (url.endsWith("/auth.revoke")) {
        return Response.json({ ok: true });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    mocks.withUserWriteFence.mockImplementationOnce(
      async (
        _database: unknown,
        _userId: string,
        operation: (database: typeof transaction) => Promise<unknown>,
      ) => {
        await operation(transaction);
        throw new Error("commit failed");
      },
    );

    await expect(
      handleSlackCallback(mockOf<Request>({}), response(), "code", "state", slackState),
    ).rejects.toThrow("commit failed");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/auth.revoke",
      expect.objectContaining({
        headers: { Authorization: "Bearer xoxb-orphan" },
      }),
    );
  });

  it("reports a failed orphan-token revocation without masking the persistence error", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/oauth.v2.access")) {
        return Response.json({
          access_token: "xoxb-orphan",
          ok: true,
          team: { id: "T1" },
          authed_user: { id: "U1" },
        });
      }
      if (url.endsWith("/auth.revoke")) return Response.json({ ok: false });
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    mocks.repositoryUpsert.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      handleSlackCallback(mockOf<Request>({}), response(), "code", "state", slackState),
    ).rejects.toThrow("database unavailable");
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { operation: "revoke-orphan-bot-token", source: "slack-oauth" },
      }),
    );
  });
});
