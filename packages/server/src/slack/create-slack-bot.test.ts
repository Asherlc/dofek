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

vi.mock("../lib/ai-nutrition.ts", () => ({
  analyzeNutritionItems: vi.fn(),
  refineNutritionItems: vi.fn(),
}));

vi.mock("../lib/cache.ts", () => ({
  queryCache: {
    invalidateByPrefix: vi.fn().mockResolvedValue(undefined),
  },
}));

import bolt from "@slack/bolt";
import { createSlackBot, startSlackBot } from "./bot.ts";

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
    // Verify ping timeout is set on the existing client (not by replacing it)
    expect(mockSocketClient).toHaveProperty("clientPingTimeoutMS", 30_000);
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
});

describe("startSlackBot", () => {
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

    expect(mockExpress.use).toHaveBeenCalledWith("/slack", expect.anything());
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
      "[slack] Slack bot mounted at /slack/events (HTTP mode)",
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
