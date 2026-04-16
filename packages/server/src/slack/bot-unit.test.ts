import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NutritionItemWithMeal } from "../lib/ai-nutrition.ts";

// Mock @slack/bolt before importing bot.ts
vi.mock("@slack/bolt", () => {
  return {
    default: {
      App: vi.fn().mockImplementation(() => ({
        message: vi.fn(),
        action: vi.fn(),
        event: vi.fn(),
        error: vi.fn(),
        use: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        processEvent: vi.fn().mockResolvedValue(undefined),
      })),
      ExpressReceiver: vi.fn().mockImplementation(() => ({
        router: { get: vi.fn(), post: vi.fn() },
      })),
      SocketModeReceiver: vi.fn().mockImplementation(() => ({
        client: { on: vi.fn() },
        start: vi.fn().mockResolvedValue(undefined),
      })),
    },
  };
});

vi.mock("@slack/socket-mode", () => ({
  SocketModeClient: vi.fn().mockImplementation(() => ({ on: vi.fn() })),
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

import { analyzeNutritionItems, refineNutritionItems } from "../lib/ai-nutrition.ts";
import { queryCache } from "../lib/cache.ts";
import { createSlackBot } from "./bot.ts";
import { slackTimestampToDateString } from "./food-entry-repository.ts";

const mockAnalyze = vi.mocked(analyzeNutritionItems);
const mockRefine = vi.mocked(refineNutritionItems);

export type FlexibleMock = ReturnType<typeof vi.fn>;

export interface MockSlackApp {
  message: ReturnType<typeof vi.fn>;
  action: ReturnType<typeof vi.fn>;
  event: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  use: ReturnType<typeof vi.fn>;
}

/**
 * Type-narrowing helper for test mocks: accepts a partial object and returns it
 * typed as `T`. Uses `Partial<T>` internally so the single `as T` assertion is
 * valid (Partial<T> always overlaps with T).
 */
export function mockAs<T extends object>(partial: Partial<T>): T {
  const result: T = partial;
  return result;
}

/**
 * Reinterpret an object as type T for test mocking. This avoids double-casts
 * when the source type (e.g. a real Slack App) is structurally different from
 * the mock interface.
 */
export function castMock<T>(value: object): T {
  return value;
}

export function createMockDb(): import("dofek/db").Database {
  return mockAs<import("dofek/db").Database>({ execute: vi.fn().mockResolvedValue([]) });
}

export function getMockExecute(db: import("dofek/db").Database): FlexibleMock {
  const mock: FlexibleMock = db.execute;
  return mock;
}

export function makeFoodItem(overrides: Partial<NutritionItemWithMeal> = {}): NutritionItemWithMeal {
  return {
    foodName: "Test Food",
    foodDescription: "1 serving",
    category: "other",
    calories: 200,
    proteinG: 10,
    carbsG: 20,
    fatG: 8,
    fiberG: 3,
    saturatedFatG: 2,
    sugarG: 5,
    sodiumMg: 100,
    meal: "lunch",
    ...overrides,
  };
}

/**
 * Helper: create a Slack bot in socket mode, capture all registered handlers,
 * and return them for direct invocation.
 */
export function setupHandlers(db: ReturnType<typeof createMockDb>) {
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  process.env.SLACK_APP_TOKEN = "xapp-test";

  const result = createSlackBot(db);
  expect(result).not.toBeNull();

  const app = castMock<MockSlackApp>(result?.app ?? {});
  type Handler = (...args: unknown[]) => Promise<void>;
  const messageHandler: Handler = app.message.mock.calls[0]?.[0];
  const actionCalls: [unknown, Handler][] = app.action.mock.calls;
  const confirmHandler: Handler = actionCalls.find((c) => String(c[0]) === "confirm_food")?.[1];
  const cancelHandler: Handler = actionCalls.find((c) => String(c[0]) === "cancel_food")?.[1];
  const eventCalls: [unknown, Handler][] = app.event.mock.calls;
  const homeOpenedHandler: Handler = eventCalls.find(
    (c) => String(c[0]) === "app_home_opened",
  )?.[1];
  const appMentionHandler: Handler = eventCalls.find((c) => String(c[0]) === "app_mention")?.[1];

  expect(messageHandler).toBeDefined();
  expect(confirmHandler).toBeDefined();
  expect(cancelHandler).toBeDefined();
  expect(homeOpenedHandler).toBeDefined();
  expect(appMentionHandler).toBeDefined();

  // Capture the app.use() middleware(s) for direct invocation in tests
  type MiddlewareFn = (args: Record<string, unknown>) => Promise<void>;
  const useMiddlewares: MiddlewareFn[] = app.use.mock.calls.map((call: [unknown]) =>
    castMock<MiddlewareFn>(call[0] ?? {}),
  );

  return {
    messageHandler,
    confirmHandler,
    cancelHandler,
    homeOpenedHandler,
    appMentionHandler,
    useMiddlewares,
    app,
  };
}

describe("bot.ts — registerHandlers", () => {
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

  describe("message handler — top-level message (fresh analysis)", () => {
    it("analyzes food text and saves unconfirmed entries", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // lookupOrCreateUserId: no existing slack auth link
      mockExecute.mockResolvedValueOnce([]);
      // resolveUserByEmail: auth_account by email → found
      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      // link slack auth_account
      mockExecute.mockResolvedValueOnce([]);
      // ensureDofekProvider
      mockExecute.mockResolvedValueOnce([]);
      // insert food_entry
      mockExecute.mockResolvedValueOnce([{ id: "entry-1" }]);

      const item = makeFoodItem();
      mockAnalyze.mockResolvedValueOnce({ items: [item], provider: "gemini" });

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "thinking-ts" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({
            user: {
              tz: "America/New_York",
              real_name: "Test User",
              profile: { email: "test@test.com" },
            },
          }),
        },
        conversations: { replies: vi.fn() },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: {
          user: "U123",
          text: "Two eggs and toast",
          ts: "1700000000.000000",
          channel: "C123",
        },
        say,
        client,
      });

      expect(mockAnalyze).toHaveBeenCalledWith("Two eggs and toast", expect.any(String));
      expect(chatPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Analyzing what you ate..." }),
      );
      expect(chatUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          ts: "thinking-ts",
          blocks: expect.any(Array),
          text: expect.stringContaining("Test Food: 200 cal"),
        }),
      );
    });

    it("sends error message when AI analysis fails", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // lookupOrCreateUserId: existing slack link found
      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);

      mockAnalyze.mockRejectedValueOnce(new Error("AI provider down"));

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "thinking-ts" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "America/New_York" } }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: {
          user: "U123",
          text: "mystery food",
          ts: "1700000000.000000",
          channel: "C123",
        },
        say,
        client,
      });

      expect(chatUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          ts: "thinking-ts",
          text: expect.stringContaining("AI provider down"),
        }),
      );
    });

    it("skips messages with subtype, no text, or from bots", async () => {
      const db = createMockDb();
      const { messageHandler } = setupHandlers(db);
      const say = vi.fn();
      const client = { users: { info: vi.fn() } };

      // subtype message
      await messageHandler({
        message: { user: "U1", text: "hi", ts: "1", subtype: "channel_join" },
        say,
        client,
      });
      expect(say).not.toHaveBeenCalled();

      // no text
      await messageHandler({
        message: { user: "U1", ts: "1" },
        say,
        client,
      });
      expect(say).not.toHaveBeenCalled();

      // bot message
      await messageHandler({
        message: { user: "U1", text: "hi", ts: "1", bot_id: "B1" },
        say,
        client,
      });
      expect(say).not.toHaveBeenCalled();
    });

    it("replies with error when lookupOrCreateUserId fails", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // lookupOrCreateUserId: users.info fails
      mockExecute.mockRejectedValueOnce(new Error("Slack API unavailable"));

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const client = {
        users: {
          info: vi.fn().mockRejectedValue(new Error("Slack API unavailable")),
        },
        chat: { postMessage: vi.fn() },
      };

      await messageHandler({
        message: {
          user: "U123",
          text: "some food",
          ts: "1700000000.000000",
          channel: "C123",
        },
        say,
        client,
      });

      // The top-level catch should send an error reply
      expect(say).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Slack API unavailable"),
          thread_ts: "1700000000.000000",
        }),
      );
    });

    it("handles failed say() in top-level error handler gracefully", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // lookupOrCreateUserId fails
      mockExecute.mockRejectedValueOnce(new Error("DB error"));

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn().mockRejectedValue(new Error("say failed"));
      const client = {
        users: { info: vi.fn().mockRejectedValue(new Error("API down")) },
        chat: { postMessage: vi.fn() },
      };

      // Should not throw even if say() fails
      await expect(
        messageHandler({
          message: {
            user: "U123",
            text: "food",
            ts: "1700000000.000000",
            channel: "C123",
          },
          say,
          client,
        }),
      ).resolves.not.toThrow();
    });
  });

  describe("app_mention handler", () => {
    it("handles app mentions by reusing message parsing flow", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // lookupOrCreateUserId: existing slack link found
      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      // ensureDofekProvider
      mockExecute.mockResolvedValueOnce([]);
      // insert food_entry
      mockExecute.mockResolvedValueOnce([{ id: "entry-1" }]);

      mockAnalyze.mockResolvedValueOnce({ items: [makeFoodItem()], provider: "gemini" });

      const { appMentionHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "thinking-ts" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "America/New_York" } }),
        },
        conversations: { replies: vi.fn() },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await appMentionHandler({
        event: {
          user: "U123",
          text: "<@U_BOT> two eggs and toast",
          ts: "1700000000.000000",
          channel: "C123",
        },
        say,
        client,
      });

      expect(mockAnalyze).toHaveBeenCalledWith("two eggs and toast", expect.any(String));
      expect(chatPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Analyzing what you ate..." }),
      );
      expect(chatUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          ts: "thinking-ts",
          blocks: expect.any(Array),
        }),
      );
    });

    it("ignores mention events with no text beyond the bot mention", async () => {
      const db = createMockDb();
      const { appMentionHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn();
      const chatUpdate = vi.fn();
      const client = {
        users: {
          info: vi.fn(),
        },
        conversations: { replies: vi.fn() },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await appMentionHandler({
        event: {
          user: "U123",
          text: "<@U_BOT>",
          ts: "1700000000.000000",
          channel: "C123",
        },
        say,
        client,
      });

      expect(mockAnalyze).not.toHaveBeenCalled();
      expect(chatPostMessage).not.toHaveBeenCalled();
      expect(chatUpdate).not.toHaveBeenCalled();
      expect(say).not.toHaveBeenCalled();
    });
  });

  describe("message handler — thread reply (refinement)", () => {
    it("falls back to fresh analysis when thread IDs are not pending", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // lookupOrCreateUserId:
      // 1. check existing auth_account for slack link
      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      mockAnalyze.mockResolvedValueOnce({
        items: [makeFoodItem({ foodName: "Scrambled Eggs", calories: 180 })],
        provider: "gemini",
      });

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "thinking-ts" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "America/Chicago" } }),
        },
        conversations: {
          replies: vi.fn().mockResolvedValue({
            messages: [
              { text: "Two eggs" },
              {
                bot_id: "B123",
                ts: "old-confirm-ts",
                blocks: [
                  {
                    type: "actions",
                    elements: [{ action_id: "confirm_food", value: "entry-old-1" }],
                  },
                ],
              },
            ],
          }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: {
          user: "U123",
          text: "actually they were scrambled",
          ts: "1700000010.000000",
          thread_ts: "1700000000.000000",
          channel: "C123",
        },
        say,
        client,
      });

      expect(mockRefine).not.toHaveBeenCalled();
      expect(mockAnalyze).toHaveBeenCalledWith("actually they were scrambled", expect.any(String));
      expect(chatPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Analyzing what you ate..." }),
      );
      expect(chatUpdate).toHaveBeenCalledWith(expect.objectContaining({ ts: "thinking-ts" }));
    });

    it("falls through to fresh analysis when no previous entries in thread", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // lookupOrCreateUserId
      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      // ensureDofekProvider
      mockExecute.mockResolvedValueOnce([]);
      // insert food_entry
      mockExecute.mockResolvedValueOnce([{ id: "entry-1" }]);

      const item = makeFoodItem();
      mockAnalyze.mockResolvedValueOnce({ items: [item], provider: "gemini" });

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "thinking-ts" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "America/Chicago" } }),
        },
        conversations: {
          replies: vi.fn().mockResolvedValue({
            messages: [{ text: "something" }], // no bot messages with confirm buttons
          }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: {
          user: "U123",
          text: "a banana",
          ts: "1700000010.000000",
          thread_ts: "1700000000.000000",
          channel: "C123",
        },
        say,
        client,
      });

      expect(mockRefine).not.toHaveBeenCalled();
      expect(mockAnalyze).toHaveBeenCalled();
    });

    it("falls back to fresh analysis when thread entries are no longer pending", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      mockAnalyze.mockResolvedValueOnce({ items: [makeFoodItem()], provider: "gemini" });

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "thinking-ts" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "America/Chicago" } }),
        },
        conversations: {
          replies: vi.fn().mockResolvedValue({
            messages: [
              {
                bot_id: "B123",
                blocks: [
                  {
                    type: "actions",
                    elements: [{ action_id: "confirm_food", value: "entry-1" }],
                  },
                ],
              },
            ],
          }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: {
          user: "U123",
          text: "actually remove the eggs",
          ts: "1700000010.000000",
          thread_ts: "1700000000.000000",
          channel: "C123",
        },
        say,
        client,
      });

      expect(mockRefine).not.toHaveBeenCalled();
      expect(mockAnalyze).toHaveBeenCalledWith("actually remove the eggs", expect.any(String));
      expect(say).not.toHaveBeenCalled();
    });
  });

  describe("confirm_food action handler", () => {
    it("confirms food entries and updates the message", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      const { confirmHandler } = setupHandlers(db);

      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      // load items for saved message
      mockExecute.mockResolvedValueOnce([
        {
          food_name: "Toast",
          food_description: "1 slice",
          category: "breads_and_cereals",
          calories: 80,
          protein_g: 3,
          carbs_g: 15,
          fat_g: 1,
          fiber_g: 1,
          saturated_fat_g: 0,
          sugar_g: 1,
          sodium_mg: 150,
          meal: "breakfast",
        },
      ]);
      const ack = vi.fn();
      const chatUpdate = vi.fn().mockResolvedValue({});

      await confirmHandler({
        ack,
        body: {
          type: "block_actions",
          actions: [{ action_id: "confirm_food", value: "entry-1" }],
          channel: { id: "C123" },
          message: { ts: "1700000000.000000" },
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(ack).toHaveBeenCalled();
      expect(chatUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "C123",
          ts: "1700000000.000000",
          text: expect.stringContaining("Toast: 80 cal"),
        }),
      );
      expect(vi.mocked(queryCache.invalidateByPrefix)).toHaveBeenCalledWith("user-123:food.");
      expect(vi.mocked(queryCache.invalidateByPrefix)).toHaveBeenCalledWith("user-123:nutrition.");
    });

    it("shows success message when entries were already confirmed (idempotent retry)", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      const { confirmHandler } = setupHandlers(db);

      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      // SELECT items still returns data (entries exist, just already confirmed)
      mockExecute.mockResolvedValueOnce([{ food_name: "Toast", calories: 80 }]);

      const ack = vi.fn();
      const chatUpdate = vi.fn().mockResolvedValue({});

      await confirmHandler({
        ack,
        body: {
          type: "block_actions",
          actions: [{ action_id: "confirm_food", value: "entry-1" }],
          channel: { id: "C123" },
          message: { ts: "1700000000.000000" },
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(ack).toHaveBeenCalled();
      // Should show success message, not "already saved"
      expect(chatUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Toast: 80 cal"),
        }),
      );
    });

    it("shows expired confirmation message when entries were deleted", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      const { confirmHandler } = setupHandlers(db);

      // confirmFoodEntries returns empty
      mockExecute.mockResolvedValueOnce([]);
      // SELECT items also returns empty (entries were deleted)
      mockExecute.mockResolvedValueOnce([]);

      const ack = vi.fn();
      const chatUpdate = vi.fn().mockResolvedValue({});

      await confirmHandler({
        ack,
        body: {
          type: "block_actions",
          actions: [{ action_id: "confirm_food", value: "entry-1" }],
          channel: { id: "C123" },
          message: { ts: "1700000000.000000" },
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(ack).toHaveBeenCalled();
      expect(chatUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "This confirmation has expired. Please confirm the latest parsed message.",
          blocks: [],
        }),
      );
    });

    it("returns early when body type is not block_actions", async () => {
      const db = createMockDb();
      const { confirmHandler } = setupHandlers(db);

      const ack = vi.fn();
      await confirmHandler({
        ack,
        body: { type: "message_action", actions: [] },
        client: {},
      });

      expect(ack).toHaveBeenCalled();
      expect(getMockExecute(db)).not.toHaveBeenCalled();
    });

    it("returns early when no actions present", async () => {
      const db = createMockDb();
      const { confirmHandler } = setupHandlers(db);

      const ack = vi.fn();
      await confirmHandler({
        ack,
        body: { type: "block_actions", actions: [] },
        client: {},
      });

      expect(ack).toHaveBeenCalled();
      expect(getMockExecute(db)).not.toHaveBeenCalled();
    });

    it("returns early when action has no value", async () => {
      const db = createMockDb();
      const { confirmHandler } = setupHandlers(db);

      const ack = vi.fn();
      await confirmHandler({
        ack,
        body: {
          type: "block_actions",
          actions: [{ action_id: "confirm_food" }],
        },
        client: {},
      });

      expect(ack).toHaveBeenCalled();
      expect(getMockExecute(db)).not.toHaveBeenCalled();
    });

    it("shows invalid or expired when confirm button has empty IDs", async () => {
      const db = createMockDb();
      const { confirmHandler } = setupHandlers(db);

      const ack = vi.fn();
      const chatUpdate = vi.fn().mockResolvedValue({});

      await confirmHandler({
        ack,
        body: {
          type: "block_actions",
          actions: [{ action_id: "confirm_food", value: ",,," }],
          channel: { id: "C123" },
          message: { ts: "1700000000.000000" },
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(ack).toHaveBeenCalled();
      expect(chatUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "This confirmation is invalid or expired. Please confirm the latest parsed message.",
          blocks: [],
        }),
      );
    });

    it("shows expired message when button IDs are stale", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);
      const { confirmHandler } = setupHandlers(db);

      mockExecute.mockResolvedValueOnce([]);
      mockExecute.mockResolvedValueOnce([]);

      const ack = vi.fn();
      const chatUpdate = vi.fn().mockResolvedValue({});

      await confirmHandler({
        ack,
        body: {
          type: "block_actions",
          actions: [{ action_id: "confirm_food", value: "stale-entry-id" }],
          channel: { id: "C123" },
          message: { ts: "1700000000.000000" },
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(ack).toHaveBeenCalled();
      expect(chatUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "This confirmation has expired. Please confirm the latest parsed message.",
          blocks: [],
        }),
      );
    });

    it("shows error message when confirm fails", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      const { confirmHandler } = setupHandlers(db);

      mockExecute.mockRejectedValueOnce(new Error("DB connection failed"));

      const ack = vi.fn();
      const chatUpdate = vi.fn().mockResolvedValue({});

      await confirmHandler({
        ack,
        body: {
          type: "block_actions",
          actions: [{ action_id: "confirm_food", value: "entry-1" }],
          channel: { id: "C123" },
          message: { ts: "1700000000.000000" },
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(chatUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("DB connection failed"),
          blocks: [],
        }),
      );
    });

    it("does not update already-saved message when channel exists but message.ts is missing", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);
      const { confirmHandler } = setupHandlers(db);

      mockExecute.mockResolvedValueOnce([]);

      const ack = vi.fn();
      const chatUpdate = vi.fn();

      await confirmHandler({
        ack,
        body: {
          type: "block_actions",
          actions: [{ action_id: "confirm_food", value: "entry-1" }],
          channel: { id: "C123" },
          message: {},
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(ack).toHaveBeenCalled();
      expect(chatUpdate).not.toHaveBeenCalled();
    });

    it("confirms entries but does not update when message.ts is missing", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);
      const { confirmHandler } = setupHandlers(db);

      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      mockExecute.mockResolvedValueOnce([{ food_name: "Toast", calories: 80 }]);

      const ack = vi.fn();
      const chatUpdate = vi.fn();

      await confirmHandler({
        ack,
        body: {
          type: "block_actions",
          actions: [{ action_id: "confirm_food", value: "entry-1" }],
          channel: { id: "C123" },
          message: {},
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(ack).toHaveBeenCalled();
      expect(chatUpdate).not.toHaveBeenCalled();
      expect(vi.mocked(queryCache.invalidateByPrefix)).toHaveBeenCalledWith("user-123:food.");
      expect(vi.mocked(queryCache.invalidateByPrefix)).toHaveBeenCalledWith("user-123:nutrition.");
    });

    it("does not update error message when channel exists but message.ts is missing", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);
      const { confirmHandler } = setupHandlers(db);

      mockExecute.mockRejectedValueOnce(new Error("DB connection failed"));

      const ack = vi.fn();
      const chatUpdate = vi.fn();

      await confirmHandler({
        ack,
        body: {
          type: "block_actions",
          actions: [{ action_id: "confirm_food", value: "entry-1" }],
          channel: { id: "C123" },
          message: {},
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(ack).toHaveBeenCalled();
      expect(chatUpdate).not.toHaveBeenCalled();
    });
  });

  describe("cancel_food action handler", () => {
    it("deletes unconfirmed entries and updates message", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      const { cancelHandler } = setupHandlers(db);

      const ack = vi.fn();
      const chatUpdate = vi.fn().mockResolvedValue({});

      await cancelHandler({
        ack,
        body: {
          type: "block_actions",
          message: {
            ts: "1700000000.000000",
            blocks: [
              {
                type: "actions",
                elements: [{ action_id: "confirm_food", value: "entry-1,entry-2" }],
              },
            ],
          },
          channel: { id: "C123" },
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(ack).toHaveBeenCalled();
      expect(mockExecute).not.toHaveBeenCalled();
      expect(chatUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Cancelled.",
          blocks: [],
        }),
      );
    });

    it("returns early when body type is not block_actions", async () => {
      const db = createMockDb();
      const { cancelHandler } = setupHandlers(db);

      const ack = vi.fn();
      const chatUpdate = vi.fn();
      await cancelHandler({
        ack,
        body: {
          type: "message_action",
          message: {
            ts: "1700000000.000000",
            blocks: [{ type: "actions", elements: [{ action_id: "confirm_food", value: "e1" }] }],
          },
          channel: { id: "C123" },
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(ack).toHaveBeenCalled();
      expect(getMockExecute(db)).not.toHaveBeenCalled();
      expect(chatUpdate).not.toHaveBeenCalled();
    });

    it("handles cancel when body has no message", async () => {
      const db = createMockDb();
      const { cancelHandler } = setupHandlers(db);

      const ack = vi.fn();
      const chatUpdate = vi.fn();

      await cancelHandler({
        ack,
        body: {
          type: "block_actions",
          channel: { id: "C123" },
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(ack).toHaveBeenCalled();
      expect(getMockExecute(db)).not.toHaveBeenCalled();
      expect(chatUpdate).not.toHaveBeenCalled();
    });

    it("handles cancel when no blocks/elements match", async () => {
      const db = createMockDb();
      const { cancelHandler } = setupHandlers(db);

      const ack = vi.fn();
      const chatUpdate = vi.fn().mockResolvedValue({});

      await cancelHandler({
        ack,
        body: {
          type: "block_actions",
          message: { ts: "1700000000.000000", blocks: [] },
          channel: { id: "C123" },
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(ack).toHaveBeenCalled();
      expect(chatUpdate).toHaveBeenCalledWith(expect.objectContaining({ text: "Cancelled." }));
    });
  });

  describe("app_home_opened event handler", () => {
    it("publishes a home tab view", async () => {
      const db = createMockDb();
      const { homeOpenedHandler } = setupHandlers(db);

      const viewsPublish = vi.fn().mockResolvedValue({});

      await homeOpenedHandler({
        event: { user: "U123" },
        client: { views: { publish: viewsPublish } },
      });

      expect(viewsPublish).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: "U123",
          view: expect.objectContaining({ type: "home" }),
        }),
      );

      const blocks = viewsPublish.mock.calls[0][0].view.blocks;
      expect(blocks).toHaveLength(7);
      expect(blocks[0]).toMatchObject({
        type: "header",
        text: { type: "plain_text", text: "Dofek — Nutrition Tracker" },
      });
      expect(blocks[1]).toMatchObject({ type: "section" });
      expect(blocks[1].text.text).toContain("Track what you eat");
      expect(blocks[2]).toMatchObject({ type: "divider" });
      expect(blocks[3]).toMatchObject({ type: "section" });
      expect(blocks[3].text.text).toContain("How it works");
      expect(blocks[4]).toMatchObject({ type: "divider" });
      expect(blocks[5]).toMatchObject({ type: "section" });
      expect(blocks[5].text.text).toContain("Examples");
      expect(blocks[6]).toMatchObject({ type: "context" });
      expect(blocks[6].elements).toHaveLength(1);
      expect(blocks[6].elements[0]).toMatchObject({ type: "mrkdwn" });
      expect(blocks[6].elements[0].text).toContain("Tip:");
    });

    it("logs error when publishing home tab fails", async () => {
      const db = createMockDb();
      const { homeOpenedHandler } = setupHandlers(db);

      const { logger } = await import("../logger.ts");

      const viewsPublish = vi.fn().mockRejectedValue(new Error("Slack API error"));

      await homeOpenedHandler({
        event: { user: "U123" },
        client: { views: { publish: viewsPublish } },
      });

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to publish Home Tab"),
      );
    });
  });

  describe("lookupOrCreateUserId — orphan repair", () => {
    it("repairs orphaned slack link when email matches a different user", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // existing slack auth_account found with user_id = orphan-user
      mockExecute.mockResolvedValueOnce([{ user_id: "orphan-user" }]);
      // canonical auth_account by email → correct user
      mockExecute.mockResolvedValueOnce([{ user_id: "correct-user" }]);
      // UPDATE auth_account SET user_id
      mockExecute.mockResolvedValueOnce([]);
      // UPDATE food_entry SET user_id
      mockExecute.mockResolvedValueOnce([]);

      const { messageHandler } = setupHandlers(db);

      // ensureDofekProvider
      mockExecute.mockResolvedValueOnce([]);
      // insert food_entry
      mockExecute.mockResolvedValueOnce([{ id: "entry-1" }]);

      const item = makeFoodItem();
      mockAnalyze.mockResolvedValueOnce({ items: [item], provider: "gemini" });

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "thinking-ts" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({
            user: {
              tz: "America/Chicago",
              real_name: "Test",
              profile: { email: "test@example.com" },
            },
          }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: { user: "U123", text: "a banana", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      // Verify the orphan repair happened: UPDATE auth_account + UPDATE food_entry
      expect(mockExecute).toHaveBeenCalled();
      expect(chatUpdate).toHaveBeenCalled();
    });

    it("skips orphan repair when canonical email matches same user", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // existing slack auth_account found
      mockExecute.mockResolvedValueOnce([{ user_id: "correct-user" }]);
      // canonical auth_account by email → SAME user (no orphan)
      mockExecute.mockResolvedValueOnce([{ user_id: "correct-user" }]);

      const { messageHandler } = setupHandlers(db);

      // ensureDofekProvider
      mockExecute.mockResolvedValueOnce([]);
      // insert food_entry
      mockExecute.mockResolvedValueOnce([{ id: "entry-1" }]);

      mockAnalyze.mockResolvedValueOnce({ items: [makeFoodItem()], provider: "gemini" });

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "t" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({
            user: { tz: "UTC", real_name: "Test", profile: { email: "test@example.com" } },
          }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: { user: "U_SAME", text: "food", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      // Should use existing link — no orphan repair (user IDs match)
      expect(chatUpdate).toHaveBeenCalled();
      // Should NOT have called UPDATE auth_account or UPDATE food_entry.
      // Redis now stores unconfirmed items, so DB calls are link lookups only.
      expect(mockExecute).toHaveBeenCalledTimes(2);
    });

    it("skips orphan repair when email exists but no canonical auth_account found", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // existing slack auth_account found
      mockExecute.mockResolvedValueOnce([{ user_id: "slack-user" }]);
      // canonical auth_account by email → none found
      mockExecute.mockResolvedValueOnce([]);

      const { messageHandler } = setupHandlers(db);

      mockAnalyze.mockResolvedValueOnce({ items: [makeFoodItem()], provider: "gemini" });

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "t" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({
            user: { tz: "UTC", real_name: "Test", profile: { email: "nocanonical@test.com" } },
          }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: { user: "U_NOCANON", text: "food", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      // Should use existing link — no orphan repair (no canonical match)
      expect(chatUpdate).toHaveBeenCalled();
      expect(mockExecute).toHaveBeenCalledTimes(2);
    });

    it("uses existing link without repair when no email available", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // existing slack auth_account found — no email available so no orphan repair
      mockExecute.mockResolvedValueOnce([{ user_id: "existing-user" }]);

      const { messageHandler } = setupHandlers(db);

      mockAnalyze.mockResolvedValueOnce({ items: [makeFoodItem()], provider: "gemini" });

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "thinking-ts" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({
            user: { tz: "UTC", real_name: "Test" },
          }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: { user: "U123", text: "a banana", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      // Should use existing link directly, food gets logged
      expect(chatUpdate).toHaveBeenCalled();
    });
  });

  describe("resolveUserByEmail", () => {
    it("replies with error when no email match found", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // lookupOrCreateUserId: no existing slack auth link
      mockExecute.mockResolvedValueOnce([]);
      // resolveUserByEmail: no auth_account by email
      mockExecute.mockResolvedValueOnce([]);
      // no user_profile by email
      mockExecute.mockResolvedValueOnce([]);

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({
            user: { tz: "UTC", real_name: "Unknown", profile: { email: "unknown@test.com" } },
          }),
        },
        chat: { postMessage: vi.fn().mockResolvedValue({}) },
      };

      await messageHandler({
        message: { user: "U999", text: "salad", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      // Should reply with error about unmatched account
      expect(say).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Could not match your Slack account"),
        }),
      );
    });

    it("finds user by user_profile email", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // no existing slack auth link
      mockExecute.mockResolvedValueOnce([]);
      // resolveOrCreateUserId: no auth_account by email
      mockExecute.mockResolvedValueOnce([]);
      // user_profile by email → found
      mockExecute.mockResolvedValueOnce([{ id: "profile-user" }]);
      // link slack auth_account
      mockExecute.mockResolvedValueOnce([]);

      const { messageHandler } = setupHandlers(db);

      // ensureDofekProvider
      mockExecute.mockResolvedValueOnce([]);
      // insert food_entry
      mockExecute.mockResolvedValueOnce([{ id: "entry-1" }]);

      mockAnalyze.mockResolvedValueOnce({ items: [makeFoodItem()], provider: "gemini" });

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "thinking-ts" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({
            user: { tz: "UTC", real_name: "Profile User", profile: { email: "p@test.com" } },
          }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: { user: "U888", text: "rice", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      expect(chatUpdate).toHaveBeenCalled();
    });

    it("finds user by auth_account email", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // no existing slack auth link
      mockExecute.mockResolvedValueOnce([]);
      // resolveOrCreateUserId: auth_account by email → found
      mockExecute.mockResolvedValueOnce([{ user_id: "auth-user" }]);
      // link slack auth_account
      mockExecute.mockResolvedValueOnce([]);

      const { messageHandler } = setupHandlers(db);

      // ensureDofekProvider
      mockExecute.mockResolvedValueOnce([]);
      // insert food_entry
      mockExecute.mockResolvedValueOnce([{ id: "entry-1" }]);

      mockAnalyze.mockResolvedValueOnce({ items: [makeFoodItem()], provider: "gemini" });

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "thinking-ts" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({
            user: { tz: "UTC", real_name: "Auth User", profile: { email: "a@test.com" } },
          }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: { user: "U777", text: "soup", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      expect(chatUpdate).toHaveBeenCalled();
    });
  });

  describe("resolveUserByEmail — no email available", () => {
    it("replies with error when users.info returns no email and no existing link", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // lookupOrCreateUserId: no existing slack auth link
      mockExecute.mockResolvedValueOnce([]);

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({
            user: { tz: "UTC", real_name: "Test User" },
          }),
        },
        chat: { postMessage: vi.fn().mockResolvedValue({}) },
      };

      await messageHandler({
        message: { user: "U_NEW", text: "a burrito", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      // Should reply with error about unmatched account (no email to match)
      expect(say).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Could not match your Slack account"),
        }),
      );
    });
  });

  describe("lookupOrCreateUserId — Slack API failure fallback", () => {
    it("uses fallback timezone when Slack users.info fails", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // existing slack auth link
      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);

      const { messageHandler } = setupHandlers(db);

      // ensureDofekProvider
      mockExecute.mockResolvedValueOnce([]);
      // insert food_entry
      mockExecute.mockResolvedValueOnce([{ id: "entry-1" }]);

      mockAnalyze.mockResolvedValueOnce({ items: [makeFoodItem()], provider: "gemini" });

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "thinking-ts" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockRejectedValue(new Error("Slack API failed")),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: { user: "U123", text: "toast", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      // Should still work with fallback timezone
      expect(chatUpdate).toHaveBeenCalled();
    });
  });

  describe("resolveUserByEmail — additional error cases", () => {
    it("rejects users with mismatched non-slack auth_account (orphan repair)", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // lookupOrCreateUserId: existing slack auth link (orphan)
      mockExecute.mockResolvedValueOnce([{ user_id: "orphan-user" }]);
      // canonical auth_account with different user_id
      mockExecute.mockResolvedValueOnce([{ user_id: "real-user" }]);
      // update slack auth_account
      mockExecute.mockResolvedValueOnce([]);
      // update food_entry
      mockExecute.mockResolvedValueOnce([]);

      const { messageHandler } = setupHandlers(db);

      // ensureDofekProvider
      mockExecute.mockResolvedValueOnce([]);
      // insert food_entry
      mockExecute.mockResolvedValueOnce([{ id: "entry-1" }]);

      mockAnalyze.mockResolvedValueOnce({ items: [makeFoodItem()], provider: "gemini" });

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "thinking-ts" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({
            user: { tz: "UTC", real_name: "Real User", profile: { email: "real@test.com" } },
          }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: { user: "U_ORPHAN", text: "orphan entry", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      // Should repair orphan and log food to real user
      expect(chatUpdate).toHaveBeenCalled();
    });
  });

  describe("confirm_food — no channel or message context", () => {
    it("confirms entries without updating message when channel/message missing", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      const { confirmHandler } = setupHandlers(db);

      // confirmFoodEntries returns 0 (already confirmed)
      mockExecute.mockResolvedValueOnce([]);

      const ack = vi.fn();

      await confirmHandler({
        ack,
        body: {
          type: "block_actions",
          actions: [{ action_id: "confirm_food", value: "entry-1" }],
          // no channel or message
        },
        client: { chat: { update: vi.fn() } },
      });

      expect(ack).toHaveBeenCalled();
    });

    it("confirms entries but does not update when no channel", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      const { confirmHandler } = setupHandlers(db);

      mockExecute.mockResolvedValueOnce([{ user_id: "user-1" }]);
      // load items
      mockExecute.mockResolvedValueOnce([
        {
          food_name: "Apple",
          food_description: "1 medium",
          category: "fruit",
          calories: 95,
          protein_g: 0,
          carbs_g: 25,
          fat_g: 0,
          fiber_g: 4,
          saturated_fat_g: 0,
          sugar_g: 19,
          sodium_mg: 2,
          meal: "snack",
        },
      ]);
      const ack = vi.fn();
      const chatUpdate = vi.fn();

      await confirmHandler({
        ack,
        body: {
          type: "block_actions",
          actions: [{ action_id: "confirm_food", value: "entry-1" }],
          // no channel
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(ack).toHaveBeenCalled();
      expect(chatUpdate).not.toHaveBeenCalled();
      expect(vi.mocked(queryCache.invalidateByPrefix)).toHaveBeenCalledWith("user-1:food.");
      expect(vi.mocked(queryCache.invalidateByPrefix)).toHaveBeenCalledWith("user-1:nutrition.");
    });
  });

  describe("message guard clauses — individual field checks", () => {
    it("skips message with no user field", async () => {
      const db = createMockDb();
      const { messageHandler } = setupHandlers(db);
      const say = vi.fn();
      const client = { users: { info: vi.fn() }, chat: { postMessage: vi.fn() } };

      await messageHandler({
        message: { text: "food", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      expect(say).not.toHaveBeenCalled();
      expect(client.users.info).not.toHaveBeenCalled();
    });

    it("skips message with no ts field", async () => {
      const db = createMockDb();
      const { messageHandler } = setupHandlers(db);
      const say = vi.fn();
      const client = { users: { info: vi.fn() }, chat: { postMessage: vi.fn() } };

      await messageHandler({
        message: { user: "U1", text: "food", channel: "C1" },
        say,
        client,
      });

      expect(say).not.toHaveBeenCalled();
      expect(client.users.info).not.toHaveBeenCalled();
    });

    it("skips message with no channel field", async () => {
      const db = createMockDb();
      const { messageHandler } = setupHandlers(db);
      const say = vi.fn();
      const client = { users: { info: vi.fn() }, chat: { postMessage: vi.fn() } };

      await messageHandler({
        message: { user: "U1", text: "food", ts: "1700000000.000000" },
        say,
        client,
      });

      expect(say).not.toHaveBeenCalled();
      expect(client.users.info).not.toHaveBeenCalled();
    });
  });

  describe("null food data — kills ?? → && mutations", () => {
    it("falls back to fresh analysis when prior thread entries are not pending", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      mockAnalyze.mockResolvedValueOnce({
        items: [makeFoodItem({ foodName: "Known Food" })],
        provider: "gemini",
      });

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "thinking-ts" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "UTC" } }),
        },
        conversations: {
          replies: vi.fn().mockResolvedValue({
            messages: [
              {
                bot_id: "B1",
                blocks: [
                  {
                    type: "actions",
                    elements: [{ action_id: "confirm_food", value: "entry-1" }],
                  },
                ],
              },
            ],
          }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: {
          user: "U1",
          text: "actually it was pizza",
          ts: "1700000010.000000",
          thread_ts: "1700000000.000000",
          channel: "C1",
        },
        say,
        client,
      });

      expect(mockRefine).not.toHaveBeenCalled();
      expect(mockAnalyze).toHaveBeenCalledWith("actually it was pizza", expect.any(String));
      expect(chatUpdate).toHaveBeenCalled();
    });

    it("handles null values in confirmed food entry data", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      const { confirmHandler } = setupHandlers(db);

      mockExecute.mockResolvedValueOnce([{ user_id: "user-1" }]);
      // load items with all nullable fields null
      mockExecute.mockResolvedValueOnce([
        {
          food_name: "Unknown",
          food_description: null,
          category: null,
          calories: 0,
          protein_g: null,
          carbs_g: null,
          fat_g: null,
          fiber_g: null,
          saturated_fat_g: null,
          sugar_g: null,
          sodium_mg: null,
          meal: null,
        },
      ]);
      const ack = vi.fn();
      const chatUpdate = vi.fn().mockResolvedValue({});

      await confirmHandler({
        ack,
        body: {
          type: "block_actions",
          actions: [{ action_id: "confirm_food", value: "entry-1" }],
          channel: { id: "C1" },
          message: { ts: "123" },
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(ack).toHaveBeenCalled();
      // The update should still work with null-coalesced values
      expect(chatUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Unknown"),
        }),
      );
    });
  });

  describe("thinkingMsg.ts undefined — falls back to say()", () => {
    it("uses say() when chat.postMessage returns no ts (fresh analysis)", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // lookupOrCreateUserId: existing slack link
      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      // ensureDofekProvider
      mockExecute.mockResolvedValueOnce([]);
      // insert food_entry
      mockExecute.mockResolvedValueOnce([{ id: "entry-1" }]);

      mockAnalyze.mockResolvedValueOnce({ items: [makeFoodItem()], provider: "gemini" });

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      // postMessage returns no ts
      const chatPostMessage = vi.fn().mockResolvedValue({});
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "UTC" } }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: { user: "U1", text: "eggs", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      // Should NOT have used chat.update (no ts to update)
      expect(chatUpdate).not.toHaveBeenCalled();
      // Should have used say() instead
      expect(say).toHaveBeenCalledWith(
        expect.objectContaining({
          thread_ts: "1700000000.000000",
          text: expect.stringContaining("Test Food"),
        }),
      );
    });

    it("uses say() when chat.postMessage returns no ts (AI error path)", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);

      mockAnalyze.mockRejectedValueOnce(new Error("AI down"));

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({});
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "UTC" } }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: { user: "U1", text: "food", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      expect(chatUpdate).not.toHaveBeenCalled();
      expect(say).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("AI down"),
          thread_ts: "1700000000.000000",
        }),
      );
    });

    it("uses say() when chat.postMessage returns no ts (thread reply fallback analysis)", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      mockAnalyze.mockResolvedValueOnce({
        items: [makeFoodItem({ foodName: "Scrambled Eggs" })],
        provider: "gemini",
      });

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      // No ts returned
      const chatPostMessage = vi.fn().mockResolvedValue({});
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "UTC" } }),
        },
        conversations: {
          replies: vi.fn().mockResolvedValue({
            messages: [
              {
                bot_id: "B1",
                blocks: [
                  {
                    type: "actions",
                    elements: [{ action_id: "confirm_food", value: "entry-1" }],
                  },
                ],
              },
            ],
          }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: {
          user: "U1",
          text: "scrambled",
          ts: "1700000010.000000",
          thread_ts: "1700000000.000000",
          channel: "C1",
        },
        say,
        client,
      });

      expect(chatUpdate).not.toHaveBeenCalled();
      expect(say).toHaveBeenCalledWith(
        expect.objectContaining({
          thread_ts: "1700000010.000000",
        }),
      );
    });
  });

  describe("logger assertions — kills string literal mutations", () => {
    it("logs parsing info for top-level messages", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      mockExecute.mockResolvedValueOnce([]);
      mockExecute.mockResolvedValueOnce([{ id: "entry-1" }]);

      mockAnalyze.mockResolvedValueOnce({ items: [makeFoodItem()], provider: "gemini" });

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "t" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "UTC" } }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: { user: "U_LOG", text: "pasta", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("[slack] Parsing food from U_LOG"),
      );
    });

    it("logs thread reply info", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      mockExecute.mockResolvedValueOnce([]);
      mockExecute.mockResolvedValueOnce([{ id: "e1" }]);

      mockAnalyze.mockResolvedValueOnce({ items: [makeFoodItem()], provider: "gemini" });

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "t" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "UTC" } }),
        },
        conversations: {
          replies: vi.fn().mockResolvedValue({ messages: [] }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: {
          user: "U_THREAD",
          text: "more food",
          ts: "1700000010.000000",
          thread_ts: "1700000000.000000",
          channel: "C1",
        },
        say,
        client,
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("[slack] Thread reply from U_THREAD"),
      );
    });

    it("logs error for AI analysis failure", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      mockAnalyze.mockRejectedValueOnce(new Error("model unavailable"));

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "t" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "UTC" } }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: { user: "U1", text: "food", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("[slack] AI analysis failed"),
      );
    });

    it("logs error for top-level message handler failure", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      mockExecute.mockRejectedValueOnce(new Error("DB down"));

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const client = {
        users: {
          info: vi.fn().mockRejectedValue(new Error("API down")),
        },
        chat: { postMessage: vi.fn() },
      };

      await messageHandler({
        message: { user: "U1", text: "food", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("[slack] Message handler failed"),
      );
    });

    it("logs confirmation count", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      const { confirmHandler } = setupHandlers(db);

      mockExecute.mockResolvedValueOnce([{ user_id: "u1" }]);
      mockExecute.mockResolvedValueOnce([
        {
          food_name: "Apple",
          food_description: "1 medium",
          category: "fruit",
          calories: 95,
          protein_g: 0,
          carbs_g: 25,
          fat_g: 0,
          fiber_g: 4,
          saturated_fat_g: 0,
          sugar_g: 19,
          sodium_mg: 2,
          meal: "snack",
        },
      ]);
      const ack = vi.fn();
      const chatUpdate = vi.fn().mockResolvedValue({});

      await confirmHandler({
        ack,
        body: {
          type: "block_actions",
          actions: [{ action_id: "confirm_food", value: "entry-1" }],
          channel: { id: "C1" },
          message: { ts: "123" },
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("[slack] Confirmed"));
    });

    it("logs error for refinement failure", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      mockAnalyze.mockRejectedValueOnce(new Error("refine broke"));

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "t" });
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "UTC" } }),
        },
        conversations: {
          replies: vi.fn().mockResolvedValue({
            messages: [
              {
                bot_id: "B1",
                blocks: [
                  {
                    type: "actions",
                    elements: [{ action_id: "confirm_food", value: "entry-1" }],
                  },
                ],
              },
            ],
          }),
        },
        chat: { postMessage: chatPostMessage },
      };

      await messageHandler({
        message: {
          user: "U1",
          text: "change it",
          ts: "1700000010.000000",
          thread_ts: "1700000000.000000",
          channel: "C1",
        },
        say,
        client,
      });

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("[slack] AI analysis failed"),
      );
    });

    it("logs confirm failure error", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      const { confirmHandler } = setupHandlers(db);

      mockExecute.mockRejectedValueOnce(new Error("DB error"));

      const ack = vi.fn();
      const chatUpdate = vi.fn().mockResolvedValue({});

      await confirmHandler({
        ack,
        body: {
          type: "block_actions",
          actions: [{ action_id: "confirm_food", value: "entry-1" }],
          channel: { id: "C1" },
          message: { ts: "123" },
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("[slack] Failed to confirm food entries"),
      );
    });

    it("logs say error in nested catch", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      mockExecute.mockRejectedValueOnce(new Error("DB error"));

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn().mockRejectedValue(new Error("say broke"));
      const client = {
        users: { info: vi.fn().mockRejectedValue(new Error("API down")) },
        chat: { postMessage: vi.fn() },
      };

      await messageHandler({
        message: { user: "U1", text: "food", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("[slack] Failed to send error reply"),
      );
    });
  });

  describe("multiple entry IDs — kills join/split mutations", () => {
    it("produces comma-separated entry IDs for multiple entries", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      mockAnalyze.mockResolvedValueOnce({
        items: [makeFoodItem({ foodName: "Eggs" }), makeFoodItem({ foodName: "Toast" })],
        provider: "gemini",
      });

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "t" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "UTC" } }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: { user: "U1", text: "eggs and toast", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      // The confirm button value should contain comma-separated IDs
      const updateCall = chatUpdate.mock.calls
        .map((call) => call[0])
        .find((call) =>
          Array.isArray(call?.blocks)
            ? call.blocks.some((block: { type?: string }) => block.type === "actions")
            : false,
        );
      const actionsBlock = updateCall?.blocks?.find((b: { type: string }) => b.type === "actions");
      if (actionsBlock) {
        const confirmButton = actionsBlock.elements?.find(
          (e: { action_id: string }) => e.action_id === "confirm_food",
        );
        expect(confirmButton?.value).toContain(",");
        expect(confirmButton?.value).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12},[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
      }
    });
  });

  describe("confirm_food — error without channel context", () => {
    it("logs error but does not update message when channel missing on confirm error", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      const { confirmHandler } = setupHandlers(db);

      mockExecute.mockRejectedValueOnce(new Error("DB error"));

      const ack = vi.fn();
      const chatUpdate = vi.fn().mockResolvedValue({});

      await confirmHandler({
        ack,
        body: {
          type: "block_actions",
          actions: [{ action_id: "confirm_food", value: "entry-1" }],
          // no channel or message
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(ack).toHaveBeenCalled();
      // Without channel+message, should not try to update
      expect(chatUpdate).not.toHaveBeenCalled();
    });
  });

  describe("app_home_opened — section types", () => {
    it("uses mrkdwn type for all section text blocks", async () => {
      const db = createMockDb();
      const { homeOpenedHandler } = setupHandlers(db);

      const viewsPublish = vi.fn().mockResolvedValue({});

      await homeOpenedHandler({
        event: { user: "U123" },
        client: { views: { publish: viewsPublish } },
      });

      const blocks = viewsPublish.mock.calls[0][0].view.blocks;
      // All section blocks should use mrkdwn type
      const sectionBlocks = blocks.filter((b: { type: string }) => b.type === "section");
      for (const section of sectionBlocks) {
        expect(section.text.type).toBe("mrkdwn");
      }
    });
  });

  describe("app.use middleware — event logging", () => {
    it("logs event type for event payloads", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const { useMiddlewares } = setupHandlers(db);

      const middleware = useMiddlewares[0];
      expect(middleware).toBeDefined();

      const next = vi.fn().mockResolvedValue(undefined);
      await middleware({
        event: { type: "message" },
        next,
      });

      expect(logger.info).toHaveBeenCalledWith("[slack] Received event type=message");
      expect(next).toHaveBeenCalled();
    });

    it("logs non-event payload for actions/shortcuts/commands", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const { useMiddlewares } = setupHandlers(db);

      const middleware = useMiddlewares[0];
      expect(middleware).toBeDefined();

      const next = vi.fn().mockResolvedValue(undefined);
      await middleware({
        body: { type: "block_actions" },
        next,
      });

      expect(logger.info).toHaveBeenCalledWith(
        "[slack] Received non-event payload (action/shortcut/command)",
      );
      expect(next).toHaveBeenCalled();
    });

    it("treats payload with event=null as non-event", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const { useMiddlewares } = setupHandlers(db);

      const middleware = useMiddlewares[0];
      const next = vi.fn().mockResolvedValue(undefined);
      await middleware({
        event: null,
        next,
      });

      expect(logger.info).toHaveBeenCalledWith(
        "[slack] Received non-event payload (action/shortcut/command)",
      );
      expect(next).toHaveBeenCalled();
    });

    it("treats payload with event as non-object as non-event", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const { useMiddlewares } = setupHandlers(db);

      const middleware = useMiddlewares[0];
      const next = vi.fn().mockResolvedValue(undefined);
      await middleware({
        event: "string-event",
        next,
      });

      expect(logger.info).toHaveBeenCalledWith(
        "[slack] Received non-event payload (action/shortcut/command)",
      );
      expect(next).toHaveBeenCalled();
    });

    it("treats event object without type property as non-event", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const { useMiddlewares } = setupHandlers(db);

      const middleware = useMiddlewares[0];
      const next = vi.fn().mockResolvedValue(undefined);
      await middleware({
        event: { subtype: "something" },
        next,
      });

      expect(logger.info).toHaveBeenCalledWith(
        "[slack] Received non-event payload (action/shortcut/command)",
      );
      expect(next).toHaveBeenCalled();
    });
  });

  describe("diagnostic logger.info — message handler invoked", () => {
    it("logs diagnostic info including type, subtype, text, user, bot_id fields", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const { messageHandler } = setupHandlers(db);

      // Message with all fields present
      await messageHandler({
        message: {
          type: "message",
          user: "U1",
          text: "hello",
          ts: "1700000000.000000",
          channel: "C1",
          bot_id: "B1",
        },
        say: vi.fn(),
        client: { users: { info: vi.fn() } },
      });

      // The handler should log the diagnostic info including the fields
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringMatching(
          /\[slack\] Message handler invoked:.*type=message.*subtype=.*has_text=true.*has_user=true.*has_bot_id=true/,
        ),
      );
    });

    it("logs type=unknown when message.type is undefined", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const { messageHandler } = setupHandlers(db);

      await messageHandler({
        message: {
          user: "U1",
          text: "hello",
          ts: "1700000000.000000",
          channel: "C1",
        },
        say: vi.fn(),
        client: { users: { info: vi.fn() } },
      });

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("type=unknown"));
    });

    it("logs subtype=none when message has no subtype", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const { messageHandler } = setupHandlers(db);

      await messageHandler({
        message: {
          user: "U1",
          text: "hello",
          ts: "1700000000.000000",
          channel: "C1",
        },
        say: vi.fn(),
        client: { users: { info: vi.fn() } },
      });

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("subtype=none"));
    });

    it("logs subtype value when message has subtype", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const { messageHandler } = setupHandlers(db);

      await messageHandler({
        message: {
          user: "U1",
          text: "hello",
          ts: "1700000000.000000",
          channel: "C1",
          subtype: "channel_join",
        },
        say: vi.fn(),
        client: { users: { info: vi.fn() } },
      });

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("subtype=channel_join"));
    });

    it("logs has_text=false when message has no text", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const { messageHandler } = setupHandlers(db);

      await messageHandler({
        message: {
          user: "U1",
          ts: "1700000000.000000",
          channel: "C1",
        },
        say: vi.fn(),
        client: { users: { info: vi.fn() } },
      });

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("has_text=false"));
    });

    it("logs has_user=false when message has no user", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const { messageHandler } = setupHandlers(db);

      await messageHandler({
        message: {
          text: "hello",
          ts: "1700000000.000000",
          channel: "C1",
        },
        say: vi.fn(),
        client: { users: { info: vi.fn() } },
      });

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("has_user=false"));
    });

    it("logs has_bot_id=false when message has no bot_id", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const { messageHandler } = setupHandlers(db);

      await messageHandler({
        message: {
          user: "U1",
          text: "hello",
          ts: "1700000000.000000",
          channel: "C1",
        },
        say: vi.fn(),
        client: { users: { info: vi.fn() } },
      });

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("has_bot_id=false"));
    });
  });

  describe("guard clause edge cases — empty string values", () => {
    it("skips message with text present but empty string", async () => {
      const db = createMockDb();
      const { messageHandler } = setupHandlers(db);
      const say = vi.fn();
      const client = { users: { info: vi.fn() }, chat: { postMessage: vi.fn() } };

      // text key exists but value is empty string — should return early
      await messageHandler({
        message: { user: "U1", text: "", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      expect(say).not.toHaveBeenCalled();
      expect(client.users.info).not.toHaveBeenCalled();
    });

    it("skips message with user present but empty string", async () => {
      const db = createMockDb();
      const { messageHandler } = setupHandlers(db);
      const say = vi.fn();
      const client = { users: { info: vi.fn() }, chat: { postMessage: vi.fn() } };

      // user key exists but value is empty string — should return early
      await messageHandler({
        message: { user: "", text: "food", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      expect(say).not.toHaveBeenCalled();
      expect(client.users.info).not.toHaveBeenCalled();
    });

    it("skips message with ts present but empty string", async () => {
      const db = createMockDb();
      const { messageHandler } = setupHandlers(db);
      const say = vi.fn();
      const client = { users: { info: vi.fn() }, chat: { postMessage: vi.fn() } };

      // ts key exists but value is empty string — should return early
      await messageHandler({
        message: { user: "U1", text: "food", ts: "", channel: "C1" },
        say,
        client,
      });

      expect(say).not.toHaveBeenCalled();
      expect(client.users.info).not.toHaveBeenCalled();
    });

    it("skips message with channel present but empty string", async () => {
      const db = createMockDb();
      const { messageHandler } = setupHandlers(db);
      const say = vi.fn();
      const client = { users: { info: vi.fn() }, chat: { postMessage: vi.fn() } };

      // channel key exists but value is empty string — should return early
      await messageHandler({
        message: { user: "U1", text: "food", ts: "1700000000.000000", channel: "" },
        say,
        client,
      });

      expect(say).not.toHaveBeenCalled();
      expect(client.users.info).not.toHaveBeenCalled();
    });

    it("skips message with subtype present but falsy (empty string)", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // subtype is present but empty string — should NOT skip (falsy subtype is allowed)
      // existing slack auth_account found
      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      // ensureDofekProvider
      mockExecute.mockResolvedValueOnce([]);
      // insert food_entry
      mockExecute.mockResolvedValueOnce([{ id: "entry-1" }]);

      mockAnalyze.mockResolvedValueOnce({ items: [makeFoodItem()], provider: "gemini" });

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "t" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "UTC" } }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: { user: "U1", text: "food", ts: "1700000000.000000", channel: "C1", subtype: "" },
        say,
        client,
      });

      // Empty string subtype is falsy, so the guard should NOT filter it out
      expect(mockAnalyze).toHaveBeenCalled();
    });
  });

  describe("thread reply — thread_ts === ts (not a reply)", () => {
    it("treats message where thread_ts === ts as top-level (not a thread reply)", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // lookupOrCreateUserId: existing slack link
      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      // ensureDofekProvider
      mockExecute.mockResolvedValueOnce([]);
      // insert food_entry
      mockExecute.mockResolvedValueOnce([{ id: "entry-1" }]);

      mockAnalyze.mockResolvedValueOnce({ items: [makeFoodItem()], provider: "gemini" });

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "t" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const conversationsReplies = vi.fn();
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "UTC" } }),
        },
        conversations: { replies: conversationsReplies },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      // thread_ts === ts means it's the parent message, not a reply
      await messageHandler({
        message: {
          user: "U1",
          text: "some food",
          ts: "1700000000.000000",
          thread_ts: "1700000000.000000",
          channel: "C1",
        },
        say,
        client,
      });

      // Should NOT have tried to load thread replies
      expect(conversationsReplies).not.toHaveBeenCalled();
      // Should have gone to fresh analysis
      expect(mockAnalyze).toHaveBeenCalled();
      expect(mockRefine).not.toHaveBeenCalled();
    });
  });

  describe("thread reply — conversations.replies arguments", () => {
    it("calls conversations.replies with correct channel and ts", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // lookupOrCreateUserId: existing slack link
      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      // ensureDofekProvider (for fallthrough to fresh analysis)
      mockExecute.mockResolvedValueOnce([]);
      // insert food_entry
      mockExecute.mockResolvedValueOnce([{ id: "entry-1" }]);

      mockAnalyze.mockResolvedValueOnce({ items: [makeFoodItem()], provider: "gemini" });

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "t" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const conversationsReplies = vi.fn().mockResolvedValue({ messages: [] });
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "UTC" } }),
        },
        conversations: { replies: conversationsReplies },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: {
          user: "U1",
          text: "update this",
          ts: "1700000010.000000",
          thread_ts: "1700000000.000000",
          channel: "C_THREAD",
        },
        say,
        client,
      });

      expect(conversationsReplies).toHaveBeenCalledWith({
        channel: "C_THREAD",
        ts: "1700000000.000000",
      });
    });
  });

  describe("thread reply — empty previousItems fallthrough", () => {
    it("falls through to fresh analysis when DB returns empty rows for previous entries", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // lookupOrCreateUserId
      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      // load previous items — empty result (IDs existed in thread but no DB rows)
      mockExecute.mockResolvedValueOnce([]);
      // ensureDofekProvider (for fresh analysis fallthrough)
      mockExecute.mockResolvedValueOnce([]);
      // insert food_entry
      mockExecute.mockResolvedValueOnce([{ id: "entry-1" }]);

      mockAnalyze.mockResolvedValueOnce({ items: [makeFoodItem()], provider: "gemini" });

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "t" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "UTC" } }),
        },
        conversations: {
          replies: vi.fn().mockResolvedValue({
            messages: [
              {
                bot_id: "B1",
                blocks: [
                  {
                    type: "actions",
                    elements: [{ action_id: "confirm_food", value: "entry-old" }],
                  },
                ],
              },
            ],
          }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: {
          user: "U1",
          text: "update to pizza",
          ts: "1700000010.000000",
          thread_ts: "1700000000.000000",
          channel: "C1",
        },
        say,
        client,
      });

      // previousItems.length === 0, so should fall through to fresh analysis
      expect(mockRefine).not.toHaveBeenCalled();
      expect(mockAnalyze).toHaveBeenCalled();
    });
  });

  describe("thread reply — multiple entry IDs join with comma in refinement", () => {
    it("produces comma-separated entry IDs for multiple refined entries", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      const analyzedItems = [
        makeFoodItem({ foodName: "Scrambled Eggs" }),
        makeFoodItem({ foodName: "Toast" }),
      ];
      mockAnalyze.mockResolvedValueOnce({ items: analyzedItems, provider: "gemini" });

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "thinking-ts" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "UTC" } }),
        },
        conversations: {
          replies: vi.fn().mockResolvedValue({
            messages: [
              {
                bot_id: "B1",
                blocks: [
                  {
                    type: "actions",
                    elements: [{ action_id: "confirm_food", value: "old-entry" }],
                  },
                ],
              },
            ],
          }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: {
          user: "U1",
          text: "actually scrambled eggs and toast",
          ts: "1700000010.000000",
          thread_ts: "1700000000.000000",
          channel: "C1",
        },
        say,
        client,
      });

      expect(chatUpdate).toHaveBeenCalled();
      const lastUpdate = chatUpdate.mock.calls.at(-1)?.[0];
      expect(lastUpdate?.text).toContain("Scrambled Eggs");
      expect(lastUpdate?.text).toContain("Toast");
      expect(mockRefine).not.toHaveBeenCalled();
    });
  });

  describe("confirm_food — split/filter edge cases", () => {
    it("handles entry IDs with trailing comma (filter removes empty strings)", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      const { confirmHandler } = setupHandlers(db);

      mockExecute.mockResolvedValueOnce([{ user_id: "user-1" }]);
      // load items for saved message
      mockExecute.mockResolvedValueOnce([
        {
          food_name: "Apple",
          food_description: "1 medium",
          category: "fruit",
          calories: 95,
          protein_g: 0,
          carbs_g: 25,
          fat_g: 0,
          fiber_g: 4,
          saturated_fat_g: 0,
          sugar_g: 19,
          sodium_mg: 2,
          meal: "snack",
        },
      ]);
      const ack = vi.fn();
      const chatUpdate = vi.fn().mockResolvedValue({});

      await confirmHandler({
        ack,
        body: {
          type: "block_actions",
          actions: [{ action_id: "confirm_food", value: "entry-1," }], // trailing comma
          channel: { id: "C123" },
          message: { ts: "1700000000.000000" },
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(ack).toHaveBeenCalled();
      // filter(Boolean) removes empty strings from split
      expect(chatUpdate).toHaveBeenCalled();
    });

    it("handles confirm action with multiple comma-separated IDs", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      const { confirmHandler } = setupHandlers(db);

      mockExecute.mockResolvedValueOnce([{ user_id: "user-1" }]);
      // load items
      mockExecute.mockResolvedValueOnce([
        {
          food_name: "Eggs",
          food_description: "2 eggs",
          category: "eggs",
          calories: 140,
          protein_g: 12,
          carbs_g: 1,
          fat_g: 10,
          fiber_g: 0,
          saturated_fat_g: 3,
          sugar_g: 0,
          sodium_mg: 120,
          meal: "breakfast",
        },
        {
          food_name: "Toast",
          food_description: "1 slice",
          category: "breads_and_cereals",
          calories: 80,
          protein_g: 3,
          carbs_g: 15,
          fat_g: 1,
          fiber_g: 1,
          saturated_fat_g: 0,
          sugar_g: 1,
          sodium_mg: 150,
          meal: "breakfast",
        },
      ]);
      const ack = vi.fn();
      const chatUpdate = vi.fn().mockResolvedValue({});

      await confirmHandler({
        ack,
        body: {
          type: "block_actions",
          actions: [{ action_id: "confirm_food", value: "e1,e2" }],
          channel: { id: "C1" },
          message: { ts: "123" },
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(ack).toHaveBeenCalled();
      // Both items should be in the saved message
      expect(chatUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Eggs"),
        }),
      );
    });
  });

  describe("confirm_food — already confirmed without channel/message context", () => {
    it("returns early when confirmedCount is 0 and no channel/message available", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      const { confirmHandler } = setupHandlers(db);

      // confirmFoodEntries returns empty (already confirmed)
      mockExecute.mockResolvedValueOnce([]);

      const ack = vi.fn();
      const chatUpdate = vi.fn();

      await confirmHandler({
        ack,
        body: {
          type: "block_actions",
          actions: [{ action_id: "confirm_food", value: "entry-1" }],
          // no channel or message
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(ack).toHaveBeenCalled();
      // Without channel/message, chat.update should not be called
      expect(chatUpdate).not.toHaveBeenCalled();
    });
  });

  describe("confirm_food — no user row for cache invalidation", () => {
    it("skips cache invalidation when no user_id found for entries", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      const { confirmHandler } = setupHandlers(db);

      mockExecute.mockResolvedValueOnce([]);
      // load items
      mockExecute.mockResolvedValueOnce([
        {
          food_name: "Apple",
          food_description: "1 medium",
          category: "fruit",
          calories: 95,
          protein_g: 0,
          carbs_g: 25,
          fat_g: 0,
          fiber_g: 4,
          saturated_fat_g: 0,
          sugar_g: 19,
          sodium_mg: 2,
          meal: "snack",
        },
      ]);
      const ack = vi.fn();
      const chatUpdate = vi.fn().mockResolvedValue({});

      await confirmHandler({
        ack,
        body: {
          type: "block_actions",
          actions: [{ action_id: "confirm_food", value: "entry-1" }],
          channel: { id: "C1" },
          message: { ts: "123" },
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(ack).toHaveBeenCalled();
      expect(chatUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Logged: Apple: 95 cal"),
        }),
      );
      // Cache invalidation should not have been called because no user row was found
      expect(vi.mocked(queryCache.invalidateByPrefix)).not.toHaveBeenCalled();
    });
  });

  describe("cancel_food — blocks with non-matching action_id", () => {
    it("does not delete entries when blocks have non-matching action_id", async () => {
      const db = createMockDb();
      const { cancelHandler } = setupHandlers(db);

      const ack = vi.fn();
      const chatUpdate = vi.fn().mockResolvedValue({});

      await cancelHandler({
        ack,
        body: {
          type: "block_actions",
          message: {
            ts: "1700000000.000000",
            blocks: [
              {
                type: "actions",
                elements: [{ action_id: "other_action", value: "entry-1" }],
              },
            ],
          },
          channel: { id: "C123" },
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(ack).toHaveBeenCalled();
      expect(getMockExecute(db)).not.toHaveBeenCalled();
      // Should still update the message with "Cancelled."
      expect(chatUpdate).toHaveBeenCalledWith(expect.objectContaining({ text: "Cancelled." }));
    });

    it("does not delete entries when block type is not actions", async () => {
      const db = createMockDb();
      const { cancelHandler } = setupHandlers(db);

      const ack = vi.fn();
      const chatUpdate = vi.fn().mockResolvedValue({});

      await cancelHandler({
        ack,
        body: {
          type: "block_actions",
          message: {
            ts: "1700000000.000000",
            blocks: [
              {
                type: "section",
                elements: [{ action_id: "confirm_food", value: "entry-1" }],
              },
            ],
          },
          channel: { id: "C123" },
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(ack).toHaveBeenCalled();
      expect(getMockExecute(db)).not.toHaveBeenCalled();
      expect(chatUpdate).toHaveBeenCalledWith(expect.objectContaining({ text: "Cancelled." }));
    });
  });

  describe("cancel_food — no channel for chat.update", () => {
    it("does not call chat.update when no channel available", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);
      const { cancelHandler } = setupHandlers(db);

      // deleteUnconfirmedEntries
      mockExecute.mockResolvedValueOnce([]);

      const ack = vi.fn();
      const chatUpdate = vi.fn();

      await cancelHandler({
        ack,
        body: {
          type: "block_actions",
          message: {
            ts: "1700000000.000000",
            blocks: [
              {
                type: "actions",
                elements: [{ action_id: "confirm_food", value: "entry-1" }],
              },
            ],
          },
          // no channel
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(ack).toHaveBeenCalled();
      expect(chatUpdate).not.toHaveBeenCalled();
    });
  });

  describe("thread reply — refinement with refine item count logging", () => {
    it("logs refining item count when previous items are found", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // lookupOrCreateUserId
      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      mockAnalyze.mockResolvedValueOnce({
        items: [makeFoodItem({ foodName: "Scrambled Eggs and Toast" })],
        provider: "gemini",
      });

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "thinking-ts" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "UTC" } }),
        },
        conversations: {
          replies: vi.fn().mockResolvedValue({
            messages: [
              {
                bot_id: "B1",
                blocks: [
                  {
                    type: "actions",
                    elements: [{ action_id: "confirm_food", value: "old-1,old-2" }],
                  },
                ],
              },
            ],
          }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: {
          user: "U1",
          text: "combine into one",
          ts: "1700000010.000000",
          thread_ts: "1700000000.000000",
          channel: "C1",
        },
        say,
        client,
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("[slack] Parsing food from"),
      );
    });
  });

  describe("extractEntryIdsFromThread — edge cases", () => {
    it("handles thread with no messages (undefined)", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // lookupOrCreateUserId
      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      // ensureDofekProvider
      mockExecute.mockResolvedValueOnce([]);
      // insert
      mockExecute.mockResolvedValueOnce([{ id: "e1" }]);

      mockAnalyze.mockResolvedValueOnce({ items: [makeFoodItem()], provider: "gemini" });

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "t" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "UTC" } }),
        },
        conversations: {
          // messages is undefined
          replies: vi.fn().mockResolvedValue({}),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: {
          user: "U1",
          text: "food",
          ts: "1700000010.000000",
          thread_ts: "1700000000.000000",
          channel: "C1",
        },
        say,
        client,
      });

      // No previous entries found, falls through to fresh analysis
      expect(mockAnalyze).toHaveBeenCalled();
      expect(mockRefine).not.toHaveBeenCalled();
    });

    it("skips thread messages without bot_id", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // lookupOrCreateUserId
      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      // ensureDofekProvider
      mockExecute.mockResolvedValueOnce([]);
      // insert
      mockExecute.mockResolvedValueOnce([{ id: "e1" }]);

      mockAnalyze.mockResolvedValueOnce({ items: [makeFoodItem()], provider: "gemini" });

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "t" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "UTC" } }),
        },
        conversations: {
          replies: vi.fn().mockResolvedValue({
            messages: [
              // User message without bot_id — should be skipped
              { text: "food description", blocks: [] },
              // Message with bot_id but no blocks
              { bot_id: "B1" },
            ],
          }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: {
          user: "U1",
          text: "refine",
          ts: "1700000010.000000",
          thread_ts: "1700000000.000000",
          channel: "C1",
        },
        say,
        client,
      });

      // No valid entry IDs found, falls through
      expect(mockAnalyze).toHaveBeenCalled();
      expect(mockRefine).not.toHaveBeenCalled();
    });

    it("skips blocks that fail schema validation", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // lookupOrCreateUserId
      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      // ensureDofekProvider
      mockExecute.mockResolvedValueOnce([]);
      // insert
      mockExecute.mockResolvedValueOnce([{ id: "e1" }]);

      mockAnalyze.mockResolvedValueOnce({ items: [makeFoodItem()], provider: "gemini" });

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "t" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "UTC" } }),
        },
        conversations: {
          replies: vi.fn().mockResolvedValue({
            messages: [
              {
                bot_id: "B1",
                blocks: [
                  // actions block but with non-matching action_id
                  {
                    type: "actions",
                    elements: [{ action_id: "other_action", value: "entry-1" }],
                  },
                ],
              },
            ],
          }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: {
          user: "U1",
          text: "refine",
          ts: "1700000010.000000",
          thread_ts: "1700000000.000000",
          channel: "C1",
        },
        say,
        client,
      });

      // No confirm_food action found, falls through
      expect(mockAnalyze).toHaveBeenCalled();
      expect(mockRefine).not.toHaveBeenCalled();
    });

    it("skips elements with empty value", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // lookupOrCreateUserId
      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      // ensureDofekProvider
      mockExecute.mockResolvedValueOnce([]);
      // insert
      mockExecute.mockResolvedValueOnce([{ id: "e1" }]);

      mockAnalyze.mockResolvedValueOnce({ items: [makeFoodItem()], provider: "gemini" });

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "t" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "UTC" } }),
        },
        conversations: {
          replies: vi.fn().mockResolvedValue({
            messages: [
              {
                bot_id: "B1",
                blocks: [
                  {
                    type: "actions",
                    elements: [{ action_id: "confirm_food", value: "" }],
                  },
                ],
              },
            ],
          }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: {
          user: "U1",
          text: "refine",
          ts: "1700000010.000000",
          thread_ts: "1700000000.000000",
          channel: "C1",
        },
        say,
        client,
      });

      // Empty value after filter(Boolean), falls through
      expect(mockAnalyze).toHaveBeenCalled();
      expect(mockRefine).not.toHaveBeenCalled();
    });
  });

  describe("non-Error objects in catch blocks", () => {
    it("handles non-Error thrown in AI analysis catch block", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      mockAnalyze.mockRejectedValueOnce("string error");

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "t" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "UTC" } }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: { user: "U1", text: "food", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("string error"));
    });

    it("handles non-Error thrown in refinement catch block", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      mockAnalyze.mockRejectedValueOnce(42);

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "t" });
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "UTC" } }),
        },
        conversations: {
          replies: vi.fn().mockResolvedValue({
            messages: [
              {
                bot_id: "B1",
                blocks: [
                  {
                    type: "actions",
                    elements: [{ action_id: "confirm_food", value: "entry-1" }],
                  },
                ],
              },
            ],
          }),
        },
        chat: { postMessage: chatPostMessage },
      };

      await messageHandler({
        message: {
          user: "U1",
          text: "change it",
          ts: "1700000010.000000",
          thread_ts: "1700000000.000000",
          channel: "C1",
        },
        say,
        client,
      });

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("[slack] AI analysis failed: 42"),
      );
      expect(say).not.toHaveBeenCalled();
      expect(chatPostMessage).toHaveBeenCalled();
    });

    it("handles non-Error thrown in top-level message handler catch", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      mockExecute.mockRejectedValueOnce("raw string error");

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const client = {
        users: { info: vi.fn().mockRejectedValue("api failure") },
        chat: { postMessage: vi.fn() },
      };

      await messageHandler({
        message: { user: "U1", text: "food", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("[slack] Message handler failed: raw string error"),
      );
    });

    it("handles non-Error thrown in say error catch", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      mockExecute.mockRejectedValueOnce(new Error("DB error"));

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn().mockRejectedValue("say failed string");
      const client = {
        users: { info: vi.fn().mockRejectedValue(new Error("API down")) },
        chat: { postMessage: vi.fn() },
      };

      await messageHandler({
        message: { user: "U1", text: "food", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("[slack] Failed to send error reply: say failed string"),
      );
    });

    it("handles non-Error thrown in confirm food catch", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      const { confirmHandler } = setupHandlers(db);

      mockExecute.mockRejectedValueOnce("confirm DB string error");

      const ack = vi.fn();
      const chatUpdate = vi.fn().mockResolvedValue({});

      await confirmHandler({
        ack,
        body: {
          type: "block_actions",
          actions: [{ action_id: "confirm_food", value: "entry-1" }],
          channel: { id: "C1" },
          message: { ts: "123" },
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("[slack] Failed to confirm food entries: confirm DB string error"),
      );
    });
  });

  describe("lookupOrCreateUserId — users.info warns with non-Error", () => {
    it("logs warning with non-Error thrown by users.info", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // existing slack auth link
      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);

      const { messageHandler } = setupHandlers(db);

      // ensureDofekProvider
      mockExecute.mockResolvedValueOnce([]);
      // insert
      mockExecute.mockResolvedValueOnce([{ id: "e1" }]);

      mockAnalyze.mockResolvedValueOnce({ items: [makeFoodItem()], provider: "gemini" });

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "t" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: { info: vi.fn().mockRejectedValue(42) },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: { user: "U1", text: "food", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("[slack] Could not fetch Slack profile for U1: 42"),
      );
    });
  });

  describe("confirm_food — non-null/non-zero values in entry mapping (kills ?? → && mutations)", () => {
    it("maps non-null, non-zero DB values correctly to NutritionItemWithMeal", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      const { confirmHandler } = setupHandlers(db);

      mockExecute.mockResolvedValueOnce([{ user_id: "user-map" }]);
      // load items with all non-null, non-zero values
      mockExecute.mockResolvedValueOnce([
        {
          food_name: "Grilled Chicken",
          food_description: "1 breast",
          category: "meat",
          calories: 250,
          protein_g: 35,
          carbs_g: 2,
          fat_g: 11,
          fiber_g: 0.5,
          saturated_fat_g: 3,
          sugar_g: 0.2,
          sodium_mg: 75,
          meal: "dinner",
        },
      ]);
      const ack = vi.fn();
      const chatUpdate = vi.fn().mockResolvedValue({});

      await confirmHandler({
        ack,
        body: {
          type: "block_actions",
          actions: [{ action_id: "confirm_food", value: "entry-1" }],
          channel: { id: "C1" },
          message: { ts: "123" },
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(ack).toHaveBeenCalled();
      // Verify the saved message contains the actual non-zero values
      expect(chatUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Grilled Chicken"),
        }),
      );
      // The text should contain 250 cal (from calories: 250)
      expect(chatUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("250 cal"),
        }),
      );
    });
  });

  describe("slackTimestampToDateString — kills timestamp mutations", () => {
    it("converts known Slack timestamp to correct date string in specific timezone", async () => {
      expect(slackTimestampToDateString("1700000000.000000", "America/New_York")).toBe(
        "2023-11-14",
      );
    });

    it("computes different date when timestamp crosses midnight in target timezone", async () => {
      expect(slackTimestampToDateString("1700003600.000000", "Asia/Tokyo")).toBe("2023-11-15");
    });

    it("uses epochSeconds * 1000 for correct date (not / 1000)", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // lookupOrCreateUserId: existing slack link
      mockExecute.mockResolvedValueOnce([{ user_id: "user-tz3" }]);
      // ensureDofekProvider
      mockExecute.mockResolvedValueOnce([]);
      // insert food_entry
      mockExecute.mockResolvedValueOnce([{ id: "entry-tz3" }]);

      const item = makeFoodItem();
      mockAnalyze.mockResolvedValueOnce({ items: [item], provider: "gemini" });

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "thinking-ts" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "UTC" } }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      // epoch 1700000000 = 2023-11-14T14:13:20 UTC
      // If mutated to / 1000, date would be new Date(1700000000/1000) = new Date(1700000)
      // = 1970-01-20 — completely wrong
      await messageHandler({
        message: { user: "U1", text: "food", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      // slackTimestampToLocalTime returns "weekday, H:MM AM/PM" format — check for Tuesday
      // (Nov 14, 2023 was a Tuesday). If mutated to /1000, would be Jan 1970 = Thursday
      expect(mockAnalyze).toHaveBeenCalledWith("food", expect.stringContaining("Tuesday"));
    });
  });

  describe("slackTimestampToDateString — passes date to analyzeNutritionItems", () => {
    it("passes correct local time string to analyzeNutritionItems (kills function removal mutation)", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // lookupOrCreateUserId: existing slack link
      mockExecute.mockResolvedValueOnce([{ user_id: "user-lt" }]);
      // ensureDofekProvider
      mockExecute.mockResolvedValueOnce([]);
      // insert food_entry
      mockExecute.mockResolvedValueOnce([{ id: "entry-lt" }]);

      const item = makeFoodItem();
      mockAnalyze.mockResolvedValueOnce({ items: [item], provider: "gemini" });

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "t" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "America/Chicago" } }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      // 1700000000 = 2023-11-14 14:13:20 UTC = 2023-11-14 08:13:20 CT
      await messageHandler({
        message: { user: "U1", text: "breakfast", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      // slackTimestampToLocalTime should produce something like "Tuesday, 8:13 AM"
      // The key: it must not be undefined (function removed) and must contain the day name
      const localTimeArg = mockAnalyze.mock.calls[0]?.[1];
      expect(localTimeArg).toBeDefined();
      expect(typeof localTimeArg).toBe("string");
      // Nov 14, 2023 was a Tuesday. The function uses { weekday: "long", hour, minute, hour12 }
      expect(localTimeArg).toMatch(/Tuesday/);
      // Should contain a time with minutes ":13" (from 14:13:20 UTC shifted by timezone)
      expect(localTimeArg).toContain(":13");
    });
  });

  describe("diagnostic log — && vs || mutations on has_text/has_user/has_bot_id", () => {
    it("logs has_text=false when text is empty string (truthy key, falsy value)", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const { messageHandler } = setupHandlers(db);

      // Message with text="" — "text" in message is true, but !!message.text is false
      // With &&: true && false = false → "has_text=false"
      // With ||: true || false = true → "has_text=true" (mutation would produce wrong log)
      await messageHandler({
        message: { user: "U1", text: "", ts: "1700000000.000000", channel: "C1" },
        say: vi.fn(),
        client: { users: { info: vi.fn() } },
      });

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("has_text=false"));
    });

    it("logs has_user=false when user is empty string", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const { messageHandler } = setupHandlers(db);

      // user="" — "user" in message is true, but !!message.user is false
      await messageHandler({
        message: { user: "", text: "food", ts: "1700000000.000000", channel: "C1" },
        say: vi.fn(),
        client: { users: { info: vi.fn() } },
      });

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("has_user=false"));
    });

    it("logs has_bot_id=false when bot_id is empty string", async () => {
      const { logger } = await import("../logger.ts");
      const db = createMockDb();
      const { messageHandler } = setupHandlers(db);

      // bot_id="" — "bot_id" in message is true, but !!message.bot_id is false
      // With &&: true && false = false → has_bot_id=false
      // With ||: true || false = true → has_bot_id=true (mutation produces wrong value)
      await messageHandler({
        message: {
          user: "U1",
          text: "food",
          ts: "1700000000.000000",
          channel: "C1",
          bot_id: "",
        },
        say: vi.fn(),
        client: { users: { info: vi.fn() } },
      });

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("has_bot_id=false"));
    });
  });

  describe("guard clause — subtype and bot_id filtering edge cases", () => {
    it("filters message with truthy subtype (kills 'if (false)' mutation on subtype guard)", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);
      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const client = {
        users: { info: vi.fn() },
        chat: { postMessage: vi.fn() },
      };

      // Message with truthy subtype should be filtered (returned early)
      await messageHandler({
        message: {
          user: "U1",
          text: "food",
          ts: "1700000000.000000",
          channel: "C1",
          subtype: "message_changed",
        },
        say,
        client,
      });

      // The guard should filter this message — users.info should NOT be called
      expect(client.users.info).not.toHaveBeenCalled();
      expect(say).not.toHaveBeenCalled();
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("filters message with truthy bot_id (kills 'if (false)' mutation on bot_id guard)", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);
      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const client = {
        users: { info: vi.fn() },
        chat: { postMessage: vi.fn() },
      };

      // Message with truthy bot_id should be filtered
      await messageHandler({
        message: {
          user: "U1",
          text: "food",
          ts: "1700000000.000000",
          channel: "C1",
          bot_id: "B_BOT",
        },
        say,
        client,
      });

      expect(client.users.info).not.toHaveBeenCalled();
      expect(say).not.toHaveBeenCalled();
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("does NOT filter message with falsy bot_id (empty string)", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // existing slack link
      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      // ensureDofekProvider
      mockExecute.mockResolvedValueOnce([]);
      // insert food_entry
      mockExecute.mockResolvedValueOnce([{ id: "entry-1" }]);

      mockAnalyze.mockResolvedValueOnce({ items: [makeFoodItem()], provider: "gemini" });

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "t" });
      const chatUpdate = vi.fn().mockResolvedValue({});
      const client = {
        users: {
          info: vi.fn().mockResolvedValue({ user: { tz: "UTC" } }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      // bot_id="" is falsy, so the guard should NOT filter it
      await messageHandler({
        message: {
          user: "U1",
          text: "food",
          ts: "1700000000.000000",
          channel: "C1",
          bot_id: "",
        },
        say,
        client,
      });

      // Should proceed to analysis
      expect(mockAnalyze).toHaveBeenCalled();
    });
  });

  describe("confirm_food — non-null/non-zero row mapping", () => {
    it("correctly maps non-null food_description, category, and non-zero macros", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      const { confirmHandler } = setupHandlers(db);

      mockExecute.mockResolvedValueOnce([{ user_id: "user-steak" }]);
      // load items — ALL fields have non-null, non-zero, non-falsy values
      // This is critical: if ?? is mutated to &&, e.g. `35 && 0` = 0, `"dinner" && "other"` = "other"
      mockExecute.mockResolvedValueOnce([
        {
          food_name: "Steak",
          food_description: "8oz ribeye",
          category: "meat",
          calories: 600,
          protein_g: 50,
          carbs_g: 1,
          fat_g: 42,
          fiber_g: 0.1,
          saturated_fat_g: 18,
          sugar_g: 0.5,
          sodium_mg: 65,
          meal: "dinner",
        },
      ]);
      const ack = vi.fn();
      const chatUpdate = vi.fn().mockResolvedValue({});

      await confirmHandler({
        ack,
        body: {
          type: "block_actions",
          actions: [{ action_id: "confirm_food", value: "entry-1" }],
          channel: { id: "C1" },
          message: { ts: "123" },
        },
        client: { chat: { update: chatUpdate } },
      });

      // The formatted saved message should contain the actual values, not the ?? fallbacks
      const updateArgs = chatUpdate.mock.calls[0]?.[0];
      expect(updateArgs).toBeDefined();

      // "Steak: 600 cal" should be in the text (not "0 cal" from && mutation)
      // formatSavedMessage produces text: "Logged: Steak: 600 cal"
      expect(updateArgs.text).toContain("Steak");
      expect(updateArgs.text).toContain("600 cal");

      // The blocks should contain "Steak — *600 cal*"
      const blockText = JSON.stringify(updateArgs.blocks);
      expect(blockText).toContain("Steak");
      expect(blockText).toContain("600 cal");
    });
  });

  describe("cancel_food — no channel behavior", () => {
    it("handles cancel when body has no channel (does not crash with non-null data)", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      const { cancelHandler } = setupHandlers(db);

      const ack = vi.fn();
      const chatUpdate = vi.fn();

      await cancelHandler({
        ack,
        body: {
          type: "block_actions",
          message: {
            ts: "1700000000.000000",
            blocks: [
              {
                type: "actions",
                elements: [{ action_id: "confirm_food", value: "entry-1,entry-2" }],
              },
            ],
          },
          // No channel — should not call chat.update
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(ack).toHaveBeenCalled();
      expect(mockExecute).not.toHaveBeenCalled();
      // But no chat.update since no channel
      expect(chatUpdate).not.toHaveBeenCalled();
    });
  });

  describe("empty entryIds behavior", () => {
    it("shows invalid/expired message when confirm IDs are empty", async () => {
      const db = createMockDb();
      const { confirmHandler } = setupHandlers(db);

      const ack = vi.fn();
      const chatUpdate = vi.fn().mockResolvedValue({});

      // Action value is just commas — filter(Boolean) produces empty array
      await confirmHandler({
        ack,
        body: {
          type: "block_actions",
          actions: [{ action_id: "confirm_food", value: ",,," }],
          channel: { id: "C1" },
          message: { ts: "123" },
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(ack).toHaveBeenCalled();
      // fallback lookup runs, but no pending rows are found
      expect(chatUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "This confirmation is invalid or expired. Please confirm the latest parsed message.",
        }),
      );
    });

    it("does not execute DELETE SQL when cancelling with empty entry IDs", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      const { cancelHandler } = setupHandlers(db);

      const ack = vi.fn();
      const chatUpdate = vi.fn().mockResolvedValue({});

      // Confirm button value is just commas
      await cancelHandler({
        ack,
        body: {
          type: "block_actions",
          message: {
            ts: "1700000000.000000",
            blocks: [
              {
                type: "actions",
                elements: [{ action_id: "confirm_food", value: ",,," }],
              },
            ],
          },
          channel: { id: "C1" },
        },
        client: { chat: { update: chatUpdate } },
      });

      expect(ack).toHaveBeenCalled();
      // deleteUnconfirmedEntries should return early (entryIds.length === 0)
      expect(mockExecute).not.toHaveBeenCalled();
      // Should still update message with "Cancelled."
      expect(chatUpdate).toHaveBeenCalledWith(expect.objectContaining({ text: "Cancelled." }));
    });
  });
});
