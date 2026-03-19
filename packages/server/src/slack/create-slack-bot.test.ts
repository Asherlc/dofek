import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
        start: vi.fn().mockResolvedValue(undefined),
      })),
    },
  };
});

vi.mock("@slack/socket-mode", () => ({
  SocketModeClient: vi.fn().mockImplementation(() => ({})),
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
});
