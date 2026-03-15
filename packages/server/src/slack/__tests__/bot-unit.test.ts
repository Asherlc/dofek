import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NutritionItemWithMeal } from "../../lib/ai-nutrition.ts";

// Mock @slack/bolt before importing bot.ts
vi.mock("@slack/bolt", () => {
  return {
    default: {
      App: vi.fn().mockImplementation(() => ({
        message: vi.fn(),
        action: vi.fn(),
        event: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
      })),
      ExpressReceiver: vi.fn().mockImplementation(() => ({
        router: { get: vi.fn(), post: vi.fn() },
      })),
    },
  };
});

vi.mock("../../logger.ts", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../lib/ai-nutrition.ts", () => ({
  analyzeNutritionItems: vi.fn(),
  refineNutritionItems: vi.fn(),
}));

vi.mock("../../lib/cache.ts", () => ({
  queryCache: {
    invalidateByPrefix: vi.fn().mockResolvedValue(undefined),
  },
}));

import { analyzeNutritionItems, refineNutritionItems } from "../../lib/ai-nutrition.ts";
import { queryCache } from "../../lib/cache.ts";
import { createSlackBot } from "../bot.ts";

const mockAnalyze = vi.mocked(analyzeNutritionItems);
const mockRefine = vi.mocked(refineNutritionItems);

// biome-ignore lint/suspicious/noExplicitAny: simplified mock for test
type AnyMock = ReturnType<typeof vi.fn<any>>;

function createMockDb() {
  return {
    execute: vi.fn<AnyMock>().mockResolvedValue([]),
  } as unknown as import("dofek/db").Database;
}

function getMockExecute(db: import("dofek/db").Database): AnyMock {
  return db.execute as unknown as AnyMock;
}

function makeFoodItem(overrides: Partial<NutritionItemWithMeal> = {}): NutritionItemWithMeal {
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
function setupHandlers(db: ReturnType<typeof createMockDb>) {
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  process.env.SLACK_APP_TOKEN = "xapp-test";

  const result = createSlackBot(db);
  expect(result).not.toBeNull();

  // biome-ignore lint/suspicious/noExplicitAny: test mock access
  const app = result?.app as any;
  type Handler = (...args: unknown[]) => Promise<void>;
  const messageHandler = app.message.mock.calls[0]?.[0] as Handler;
  const actionCalls = app.action.mock.calls as [unknown, Handler][];
  const confirmHandler = actionCalls.find((c) => String(c[0]) === "confirm_food")?.[1] as Handler;
  const cancelHandler = actionCalls.find((c) => String(c[0]) === "cancel_food")?.[1] as Handler;
  const eventCalls = app.event.mock.calls as [unknown, Handler][];
  const homeOpenedHandler = eventCalls.find(
    (c) => String(c[0]) === "app_home_opened",
  )?.[1] as Handler;

  expect(messageHandler).toBeDefined();
  expect(confirmHandler).toBeDefined();
  expect(cancelHandler).toBeDefined();
  expect(homeOpenedHandler).toBeDefined();

  return { messageHandler, confirmHandler, cancelHandler, homeOpenedHandler };
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

      // lookupOrCreateUserId: no existing slack link
      mockExecute.mockResolvedValueOnce([]); // slack profile fetch — users.info
      // no existing auth_account for slack
      mockExecute.mockResolvedValueOnce([]);
      // resolveOrCreateUserId: no auth_account by email
      mockExecute.mockResolvedValueOnce([]);
      // no user_profile by email
      mockExecute.mockResolvedValueOnce([]);
      // user count = 0 (multi-user, create new)
      mockExecute.mockResolvedValueOnce([{ count: "0", id: null }]);
      // insert user_profile
      mockExecute.mockResolvedValueOnce([{ id: "user-123" }]);
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
  });

  describe("message handler — thread reply (refinement)", () => {
    it("refines previous items when thread reply has existing entries", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // lookupOrCreateUserId:
      // 1. check existing auth_account for slack link
      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      // 2. check realUsers (orphan check — no email so canonical check skipped)
      mockExecute.mockResolvedValueOnce([]);
      // 3. load previous items from DB
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
      ]);
      // 4. deleteUnconfirmedEntries
      mockExecute.mockResolvedValueOnce([]);
      // 5. ensureDofekProvider
      mockExecute.mockResolvedValueOnce([]);
      // 6. insert new refined food_entry
      mockExecute.mockResolvedValueOnce([{ id: "entry-new" }]);

      const refinedItem = makeFoodItem({ foodName: "Scrambled Eggs", calories: 180 });
      mockRefine.mockResolvedValueOnce({ items: [refinedItem], provider: "gemini" });

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

      expect(mockRefine).toHaveBeenCalled();
      expect(chatPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Updating your entries..." }),
      );
      expect(chatUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ ts: "thinking-ts" }),
      );
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

    it("sends error when refinement fails", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // lookupOrCreateUserId:
      // 1. check existing auth_account for slack link
      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);
      // 2. check realUsers (orphan check — no email so canonical check skipped)
      mockExecute.mockResolvedValueOnce([]);
      // 3. load previous items from DB
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
      ]);

      mockRefine.mockRejectedValueOnce(new Error("Refinement failed"));

      const { messageHandler } = setupHandlers(db);

      const say = vi.fn();
      const chatPostMessage = vi.fn().mockResolvedValue({ ts: "thinking-ts" });
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
        chat: { postMessage: chatPostMessage },
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

      expect(say).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Refinement failed"),
          thread_ts: "1700000000.000000",
        }),
      );
    });
  });

  describe("confirm_food action handler", () => {
    it("confirms food entries and updates the message", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      const { confirmHandler } = setupHandlers(db);

      // confirmFoodEntries — returns confirmed rows
      mockExecute.mockResolvedValueOnce([{ id: "entry-1" }]);
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
      // user_id lookup for cache invalidation
      mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);

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
        }),
      );
      expect(vi.mocked(queryCache.invalidateByPrefix)).toHaveBeenCalledWith("user-123:food.");
      expect(vi.mocked(queryCache.invalidateByPrefix)).toHaveBeenCalledWith("user-123:nutrition.");
    });

    it("updates message when entries were already confirmed", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      const { confirmHandler } = setupHandlers(db);

      // confirmFoodEntries returns empty (already confirmed)
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
          text: "These entries were already saved.",
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
        }),
      );
    });
  });

  describe("cancel_food action handler", () => {
    it("deletes unconfirmed entries and updates message", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      const { cancelHandler } = setupHandlers(db);

      // deleteUnconfirmedEntries
      mockExecute.mockResolvedValueOnce([]);

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
      // Should have called delete
      expect(mockExecute).toHaveBeenCalled();
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
      await cancelHandler({
        ack,
        body: { type: "message_action" },
        client: {},
      });

      expect(ack).toHaveBeenCalled();
      expect(getMockExecute(db)).not.toHaveBeenCalled();
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
          view: expect.objectContaining({
            type: "home",
            blocks: expect.any(Array),
          }),
        }),
      );
    });

    it("logs error when publishing home tab fails", async () => {
      const db = createMockDb();
      const { homeOpenedHandler } = setupHandlers(db);

      const { logger } = await import("../../logger.ts");

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

    it("repairs orphan via single-user fallback when no email match", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // existing slack auth_account found
      mockExecute.mockResolvedValueOnce([{ user_id: "orphan-user" }]);
      // no canonical auth_account by email
      mockExecute.mockResolvedValueOnce([]);
      // single real user with non-slack auth
      mockExecute.mockResolvedValueOnce([{ user_id: "real-user" }]);
      // UPDATE auth_account
      mockExecute.mockResolvedValueOnce([]);
      // UPDATE food_entry
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
            user: { tz: "UTC", real_name: "Test", profile: { email: "test@example.com" } },
          }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: { user: "U123", text: "a banana", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      expect(chatUpdate).toHaveBeenCalled();
    });
  });

  describe("resolveOrCreateUserId — single user fallback", () => {
    it("falls back to sole user when no email match and single user exists", async () => {
      const db = createMockDb();
      const mockExecute = getMockExecute(db);

      // lookupOrCreateUserId: no existing slack auth link
      mockExecute.mockResolvedValueOnce([]);
      // resolveOrCreateUserId: no auth_account by email
      mockExecute.mockResolvedValueOnce([]);
      // no user_profile by email
      mockExecute.mockResolvedValueOnce([]);
      // exactly 1 user
      mockExecute.mockResolvedValueOnce([{ count: "1", id: "sole-user" }]);
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
            user: { tz: "UTC", real_name: "Solo User", profile: { email: "solo@test.com" } },
          }),
        },
        chat: { postMessage: chatPostMessage, update: chatUpdate },
      };

      await messageHandler({
        message: { user: "U999", text: "salad", ts: "1700000000.000000", channel: "C1" },
        say,
        client,
      });

      expect(chatUpdate).toHaveBeenCalled();
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

      // confirmFoodEntries returns confirmed entries
      mockExecute.mockResolvedValueOnce([{ id: "entry-1" }]);
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
      // user_id for cache invalidation
      mockExecute.mockResolvedValueOnce([{ user_id: "user-1" }]);

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
    });
  });
});
