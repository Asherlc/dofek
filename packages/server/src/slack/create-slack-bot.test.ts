import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSocketClient } = vi.hoisted(() => ({
  mockSocketClient: {
    on: vi.fn(),
  },
}));

// Mock @slack/bolt
vi.mock("@slack/bolt", () => {
  const mockApp = {
    message: vi.fn(),
    action: vi.fn(),
    event: vi.fn(),
    error: vi.fn(),
    use: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    processEvent: vi.fn().mockResolvedValue(undefined),
  };
  const mockRouter = { get: vi.fn(), post: vi.fn() };
  return {
    default: {
      App: vi.fn().mockImplementation(() => mockApp),
      ExpressReceiver: vi.fn().mockImplementation(() => ({
        router: mockRouter,
      })),
      SocketModeReceiver: vi.fn().mockImplementation(() => ({
        client: mockSocketClient,
        start: vi.fn().mockResolvedValue(undefined),
      })),
    },
  };
});

vi.mock("@slack/socket-mode", () => ({
  SocketModeClient: vi.fn().mockImplementation(() => mockSocketClient),
}));

vi.mock("../logger.ts", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
}));

vi.mock("../lib/ai-nutrition.ts", () => ({
  analyzeNutritionItems: vi.fn(),
  refineNutritionItems: vi.fn(),
}));

vi.mock("../lib/cache.ts", () => ({
  queryCache: {
    invalidateByPrefix: vi.fn().mockResolvedValue(undefined),
  },
}));

import * as Sentry from "@sentry/node";
import bolt from "@slack/bolt";
import { createSlackBot, startSlackBot } from "./bot.ts";

/** Mock fetch for verifyBotConfiguration — returns successful auth.test response with scopes in headers */
function mockFetchForSlackVerification() {
  const mockFetch = vi.fn().mockResolvedValue({
    json: () => Promise.resolve({ ok: true, user_id: "U-BOT", team: "test-team" }),
    headers: new Headers({
      "x-oauth-scopes": "chat:write,im:history,im:read,im:write,users:read,users:read.email",
    }),
  });
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

/**
 * Type-narrowing helper for test mocks: accepts a partial object and returns it
 * typed as `T`. Uses `Partial<T>` so the single `as T` assertion is valid.
 */
function mockAs<T extends object>(partial: Partial<T>): T {
  const result: T = partial;
  return result;
}

function createMockDb(): import("dofek/db").Database {
  return mockAs<import("dofek/db").Database>({ execute: vi.fn().mockResolvedValue([]) });
}

function findSocketListener(eventName: string): ((payload: unknown) => void) | undefined {
  for (const call of mockSocketClient.on.mock.calls) {
    if (call[0] === eventName && typeof call[1] === "function") {
      return call[1];
    }
  }
  return undefined;
}

describe("createSlackBot", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_MODE;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when no Slack credentials are configured", () => {
    const db = createMockDb();
    const result = createSlackBot(db);
    expect(result).toBeNull();
  });

  it("creates socket mode bot when SLACK_BOT_TOKEN and SLACK_APP_TOKEN are set", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_APP_TOKEN = "xapp-test-token";

    const db = createMockDb();
    const result = createSlackBot(db);

    expect(result).not.toBeNull();
    expect(result?.mode).toBe("socket");
    expect(result?.router).toBeUndefined();

    expect(vi.mocked(bolt.SocketModeReceiver)).toHaveBeenCalledWith(
      expect.objectContaining({ appToken: "xapp-test-token" }),
    );
    expect(mockSocketClient.on).toHaveBeenCalledWith("connecting", expect.any(Function));
    expect(mockSocketClient.on).toHaveBeenCalledWith("connected", expect.any(Function));
    expect(mockSocketClient.on).toHaveBeenCalledWith("reconnecting", expect.any(Function));
    expect(mockSocketClient.on).toHaveBeenCalledWith("disconnect", expect.any(Function));
    expect(mockSocketClient.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(mockSocketClient.on).toHaveBeenCalledWith(
      "unable_to_socket_mode_start",
      expect.any(Function),
    );
    expect(vi.mocked(bolt.App)).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "xoxb-test-token",
        receiver: expect.any(Object),
      }),
    );
  });

  it("returns null when only SLACK_BOT_TOKEN is set without SLACK_APP_TOKEN", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";

    const db = createMockDb();
    const result = createSlackBot(db);

    expect(result).toBeNull();
  });

  it("creates HTTP mode bot when SLACK_SIGNING_SECRET is set", () => {
    process.env.SLACK_SIGNING_SECRET = "test-signing-secret";

    const db = createMockDb();
    const result = createSlackBot(db);

    expect(result).not.toBeNull();
    expect(result?.mode).toBe("http");
    expect(result?.router).toBeDefined();

    expect(vi.mocked(bolt.ExpressReceiver)).toHaveBeenCalledWith(
      expect.objectContaining({
        signingSecret: "test-signing-secret",
        endpoints: "/events",
        processBeforeResponse: false,
      }),
    );

    expect(vi.mocked(bolt.App)).toHaveBeenCalledWith(
      expect.objectContaining({
        receiver: expect.any(Object),
        authorize: expect.any(Function),
      }),
    );
  });

  it("prefers HTTP mode when both signing secret and tokens are set", () => {
    process.env.SLACK_SIGNING_SECRET = "test-signing-secret";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_APP_TOKEN = "xapp-test-token";

    const db = createMockDb();
    const result = createSlackBot(db);

    expect(result?.mode).toBe("http");
  });

  it("forces HTTP mode when SLACK_MODE=http", () => {
    process.env.SLACK_MODE = "http";
    process.env.SLACK_SIGNING_SECRET = "test-signing-secret";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_APP_TOKEN = "xapp-test-token";

    const db = createMockDb();
    const result = createSlackBot(db);

    expect(result?.mode).toBe("http");
  });

  it("throws when SLACK_MODE=http but SLACK_SIGNING_SECRET is missing", () => {
    process.env.SLACK_MODE = "http";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_APP_TOKEN = "xapp-test-token";

    const db = createMockDb();

    expect(() => createSlackBot(db)).toThrow("SLACK_MODE=http requires SLACK_SIGNING_SECRET");
  });

  it("throws when SLACK_MODE has an invalid value", () => {
    process.env.SLACK_MODE = "invalid-mode";

    const db = createMockDb();

    expect(() => createSlackBot(db)).toThrow(
      'SLACK_MODE must be "http" or "socket" when set (received "invalid-mode")',
    );
  });

  it("throws when SLACK_MODE=socket and one socket token is missing", () => {
    process.env.SLACK_MODE = "socket";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";

    const db = createMockDb();

    expect(() => createSlackBot(db)).toThrow(
      "SLACK_MODE=socket requires SLACK_BOT_TOKEN and SLACK_APP_TOKEN",
    );
  });
});

describe("startSlackBot", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_MODE;
    mockFetchForSlackVerification();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  it("does nothing when no credentials are configured", async () => {
    const db = createMockDb();
    await startSlackBot(db);
    // Should not throw
  });

  it("mounts router on Express app in HTTP mode", async () => {
    process.env.SLACK_SIGNING_SECRET = "test-signing-secret";

    const db = createMockDb();
    const mockExpress = mockAs<import("express").Express>({ use: vi.fn() });

    await startSlackBot(db, mockExpress);

    expect(mockExpress.use).toHaveBeenCalledWith(
      "/api/slack",
      expect.any(Function),
      expect.anything(),
    );
  });

  it("logs Slack retry headers in HTTP mode", async () => {
    process.env.SLACK_SIGNING_SECRET = "test-signing-secret";

    const db = createMockDb();
    const mockExpress = mockAs<import("express").Express>({ use: vi.fn() });
    const { logger } = await import("../logger.ts");

    await startSlackBot(db, mockExpress);

    const useCall = mockExpress.use.mock.calls[0];
    const retryLoggerMiddleware = useCall?.[1];
    expect(typeof retryLoggerMiddleware).toBe("function");

    if (typeof retryLoggerMiddleware !== "function") {
      throw new Error("retry logger middleware was not mounted");
    }

    const req = {
      path: "/events",
      get: (name: string) => {
        if (name.toLowerCase() === "x-slack-retry-num") return "1";
        if (name.toLowerCase() === "x-slack-retry-reason") return "http_timeout";
        if (name.toLowerCase() === "x-slack-request-timestamp") return "1776905657";
        return undefined;
      },
    };
    const next = vi.fn();

    await retryLoggerMiddleware(req, {}, next);

    expect(next).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("HTTP retry delivery"));
  });

  it("warns when HTTP mode but no Express app provided", async () => {
    process.env.SLACK_SIGNING_SECRET = "test-signing-secret";

    const db = createMockDb();
    const { logger } = await import("../logger.ts");

    await startSlackBot(db);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("requires Express app reference"),
    );
  });

  it("calls app.start() in socket mode", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_APP_TOKEN = "xapp-test-token";

    const db = createMockDb();
    const { logger } = await import("../logger.ts");

    await startSlackBot(db);

    // Get the mock App instance to verify start() was called
    const mockAppInstance = vi.mocked(bolt.App).mock.results[0]?.value;
    expect(mockAppInstance).toBeDefined();
    expect(mockAppInstance.start).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith("[slack] Slack bot connected (Socket Mode)");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not mount Express router in socket mode when express app is provided", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_APP_TOKEN = "xapp-test-token";

    const db = createMockDb();
    const mockExpress = mockAs<import("express").Express>({ use: vi.fn() });
    const { logger } = await import("../logger.ts");

    await startSlackBot(db, mockExpress);

    expect(mockExpress.use).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs error when app.start() fails in socket mode", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_APP_TOKEN = "xapp-test-token";

    // Make the mock App's start() reject
    const mockAppInstance = {
      message: vi.fn(),
      action: vi.fn(),
      event: vi.fn(),
      error: vi.fn(),
      use: vi.fn(),
      start: vi.fn().mockRejectedValue(new Error("WebSocket connection failed")),
      processEvent: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(bolt.App).mockImplementationOnce(() => mockAs(mockAppInstance));

    const db = createMockDb();
    const { logger } = await import("../logger.ts");

    await startSlackBot(db);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("[slack] Failed to start Slack bot: WebSocket connection failed"),
    );
  });

  it("logs HTTP mode mount info after mounting router", async () => {
    process.env.SLACK_SIGNING_SECRET = "test-signing-secret";

    const db = createMockDb();
    const mockExpress = mockAs<import("express").Express>({ use: vi.fn() });
    const { logger } = await import("../logger.ts");

    await startSlackBot(db, mockExpress);

    expect(logger.info).toHaveBeenCalledWith(
      "[slack] Slack bot mounted at /api/slack/events (HTTP mode)",
    );
  });

  it("logs no-credentials info when nothing is configured", async () => {
    const db = createMockDb();
    const { logger } = await import("../logger.ts");

    await startSlackBot(db);

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("No Slack credentials configured"),
    );
  });

  it("verifies bot configuration on socket mode startup", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_APP_TOKEN = "xapp-test-token";

    const db = createMockDb();
    const { logger } = await import("../logger.ts");
    const mockFetch = mockFetchForSlackVerification();

    await startSlackBot(db);

    // Wait for background verification to complete
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "https://slack.com/api/auth.test",
        expect.objectContaining({ method: "POST" }),
      );
    });

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Bot authenticated as U-BOT"));
  });

  it("logs warning when bot verification detects missing scopes", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_APP_TOKEN = "xapp-test-token";

    const db = createMockDb();
    const { logger } = await import("../logger.ts");

    // Return auth.test with scopes missing im:history
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true, user_id: "U-BOT", team: "test-team" }),
        headers: new Headers({ "x-oauth-scopes": "chat:write" }),
      }),
    );

    await startSlackBot(db);

    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("missing required scopes"));
    });
  });

  it("registers SIGTERM handler that stops the app in socket mode", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_APP_TOKEN = "xapp-test-token";

    const db = createMockDb();
    const { logger } = await import("../logger.ts");
    const processOnceSpy = vi.spyOn(process, "once");

    await startSlackBot(db);

    // Verify SIGTERM handler was registered
    const sigtermCall = processOnceSpy.mock.calls.find((call) => call[0] === "SIGTERM");
    expect(sigtermCall).toBeDefined();

    // Call the handler and verify it stops the app
    const mockAppInstance = vi.mocked(bolt.App).mock.results[0]?.value;
    mockAppInstance.stop = vi.fn().mockResolvedValue(undefined);
    if (!sigtermCall) throw new Error("SIGTERM handler not registered");
    const handler: () => void = sigtermCall[1];
    await handler();

    expect(mockAppInstance.stop).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Shutting down Socket Mode connection"),
    );

    processOnceSpy.mockRestore();
  });
});

describe("createSlackBot — logger messages", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    delete process.env.SLACK_SIGNING_SECRET;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("logs HTTP mode configured message", async () => {
    process.env.SLACK_SIGNING_SECRET = "test-signing-secret";

    const db = createMockDb();
    const { logger } = await import("../logger.ts");

    createSlackBot(db);

    expect(logger.info).toHaveBeenCalledWith(
      "[slack] Configured in HTTP mode (multi-workspace, OAuth via /auth/provider/slack)",
    );
  });

  it("logs Socket Mode configured message", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_APP_TOKEN = "xapp-test-token";

    const db = createMockDb();
    const { logger } = await import("../logger.ts");

    createSlackBot(db);

    expect(logger.info).toHaveBeenCalledWith(
      "[slack] Configured in Socket Mode (single workspace)",
    );
  });

  it("logs no credentials message when nothing set", async () => {
    const db = createMockDb();
    const { logger } = await import("../logger.ts");

    createSlackBot(db);

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("No Slack credentials configured"),
    );
  });

  it("registers error handler on app", () => {
    process.env.SLACK_SIGNING_SECRET = "test-signing-secret";

    const db = createMockDb();
    const result = createSlackBot(db);

    expect(result).not.toBeNull();
    const mockAppInstance = vi.mocked(bolt.App).mock.results[0]?.value;
    expect(mockAppInstance.error).toHaveBeenCalled();
  });

  it("registers error handler on socket mode app", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_APP_TOKEN = "xapp-test-token";

    const db = createMockDb();
    const result = createSlackBot(db);

    expect(result).not.toBeNull();
    const mockAppInstance = vi.mocked(bolt.App).mock.results[0]?.value;
    expect(mockAppInstance.error).toHaveBeenCalled();
  });

  it("passes processEventErrorHandler to SocketModeReceiver", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_APP_TOKEN = "xapp-test-token";

    const db = createMockDb();
    createSlackBot(db);

    expect(vi.mocked(bolt.SocketModeReceiver)).toHaveBeenCalledWith(
      expect.objectContaining({
        appToken: "xapp-test-token",
        processEventErrorHandler: expect.any(Function),
      }),
    );
  });

  it("processEventErrorHandler logs error and reports to Sentry", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_APP_TOKEN = "xapp-test-token";

    const db = createMockDb();
    const { logger } = await import("../logger.ts");

    createSlackBot(db);

    const receiverCall = vi.mocked(bolt.SocketModeReceiver).mock.calls[0]?.[0];
    const errorHandler = receiverCall?.processEventErrorHandler;
    expect(errorHandler).toBeDefined();

    const testError = new Error("authorization failed");
    if (!errorHandler) throw new Error("errorHandler not defined");
    const result = await errorHandler({
      error: testError,
      logger: mockAs({}),
      event: mockAs({}),
    });

    expect(result).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      "[slack] Bolt processEvent error: authorization failed",
    );
    expect(Sentry.captureException).toHaveBeenCalledWith(testError);
  });

  it("processEventErrorHandler wraps non-Error values in Error", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_APP_TOKEN = "xapp-test-token";

    const db = createMockDb();
    createSlackBot(db);

    const receiverCall = vi.mocked(bolt.SocketModeReceiver).mock.calls[0]?.[0];
    const errorHandler = receiverCall?.processEventErrorHandler;

    if (!errorHandler) throw new Error("errorHandler not defined");
    await errorHandler({
      error: "string error",
      logger: mockAs({}),
      event: mockAs({}),
    });

    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error));
  });

  it("wraps processEvent with logging", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_APP_TOKEN = "xapp-test-token";

    const db = createMockDb();
    const { logger } = await import("../logger.ts");

    createSlackBot(db);

    const mockAppInstance = vi.mocked(bolt.App).mock.results[0]?.value;
    const wrappedProcessEvent = mockAppInstance.processEvent;

    await wrappedProcessEvent({ body: { event: { type: "message" } }, ack: vi.fn() });

    expect(logger.info).toHaveBeenCalledWith("[slack] processEvent called: eventType=message");
  });

  it("processEvent wrapper logs and re-throws on error", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_APP_TOKEN = "xapp-test-token";

    const originalProcessEvent = vi.fn().mockRejectedValue(new Error("bolt internal error"));
    vi.mocked(bolt.App).mockImplementationOnce(() =>
      mockAs({
        message: vi.fn(),
        action: vi.fn(),
        event: vi.fn(),
        error: vi.fn(),
        use: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        processEvent: originalProcessEvent,
      }),
    );

    const db = createMockDb();
    const { logger } = await import("../logger.ts");

    createSlackBot(db);
    const wrappedProcessEvent = vi.mocked(bolt.App).mock.results[0]?.value.processEvent;

    await expect(
      wrappedProcessEvent({ body: { event: { type: "message" } }, ack: vi.fn() }),
    ).rejects.toThrow("bolt internal error");

    expect(logger.error).toHaveBeenCalledWith("[slack] processEvent threw: bolt internal error");
  });

  it("HTTP mode error handler reports to Sentry", async () => {
    process.env.SLACK_SIGNING_SECRET = "test-signing-secret";

    const db = createMockDb();

    createSlackBot(db);

    const mockAppInstance = vi.mocked(bolt.App).mock.results[0]?.value;
    const errorHandlerCall = mockAppInstance.error.mock.calls[0];
    const errorHandler = errorHandlerCall?.[0];

    const testError = new Error("http mode error");
    await errorHandler(testError);

    expect(Sentry.captureException).toHaveBeenCalledWith(testError);
  });

  it("Socket mode error handler reports to Sentry", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_APP_TOKEN = "xapp-test-token";

    const db = createMockDb();

    createSlackBot(db);

    const mockAppInstance = vi.mocked(bolt.App).mock.results[0]?.value;
    const errorHandlerCall = mockAppInstance.error.mock.calls[0];
    const errorHandler = errorHandlerCall?.[0];

    const testError = new Error("socket mode error");
    await errorHandler(testError);

    expect(Sentry.captureException).toHaveBeenCalledWith(testError);
  });

  it("registers slack_event diagnostic listener on socket mode client", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_APP_TOKEN = "xapp-test-token";

    const db = createMockDb();
    createSlackBot(db);

    expect(mockSocketClient.on).toHaveBeenCalledWith("slack_event", expect.any(Function));
  });

  it("logs socket diagnostics on disconnect and error events", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_APP_TOKEN = "xapp-test-token";

    const db = createMockDb();
    const { logger } = await import("../logger.ts");

    createSlackBot(db);

    const disconnectHandler = findSocketListener("disconnect");
    const errorHandler = findSocketListener("error");

    expect(disconnectHandler).toBeDefined();
    expect(errorHandler).toBeDefined();

    disconnectHandler?.({ code: 1006, reason: "abnormal closure" });
    errorHandler?.(new Error("socket failure"));

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Socket Mode disconnected"));
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Socket Mode client error: socket failure"),
    );
  });
});
