import { beforeEach, describe, expect, it, vi } from "vitest";
import { refineNutritionItems } from "../lib/ai-nutrition.ts";
import { castMock, createMockDb, getMockExecute, setupHandlers } from "./bot-unit.test.ts";
import { FoodEntryRepository } from "./food-entry-repository.ts";

vi.mock("../lib/ai-nutrition.ts", () => ({
  analyzeNutritionItems: vi.fn(),
  refineNutritionItems: vi.fn(),
}));

const mockRefine = vi.mocked(refineNutritionItems);

describe("Slack Bot — Refinement Coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("successfully executes refinement path (kills slack-handlers.ts NoCoverage)", async () => {
    const db = createMockDb();
    const mockExecute = getMockExecute(db);

    // Mock lookupOrCreateUserId
    mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);

    // Mock loadForRefinement (must return items to enter the refinement block)
    const previousItems = [{ foodName: "Old Pizza", calories: 500, meal: "lunch" as const }];
    const loadSpy = vi
      .spyOn(FoodEntryRepository.prototype, "loadForRefinement")
      .mockResolvedValue(castMock(previousItems));

    // Mock deleteUnconfirmed
    const deleteSpy = vi
      .spyOn(FoodEntryRepository.prototype, "deleteUnconfirmed")
      .mockResolvedValue(undefined);

    // Mock saveUnconfirmed
    const saveSpy = vi
      .spyOn(FoodEntryRepository.prototype, "saveUnconfirmed")
      .mockResolvedValue(["new-id"]);

    mockRefine.mockResolvedValueOnce({
      items: [{ foodName: "New Pizza", calories: 400, meal: "lunch" as const }],
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
              ts: "100.000",
              blocks: [
                {
                  type: "actions",
                  elements: [{ action_id: "confirm_food", value: "old-id" }],
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
        text: "it was actually 400 calories",
        ts: "200.000",
        thread_ts: "100.000",
        channel: "C1",
      },
      say,
      client,
    });

    expect(loadSpy).toHaveBeenCalledWith(["old-id"]);
    expect(mockRefine).toHaveBeenCalled();
    expect(deleteSpy).toHaveBeenCalledWith(["old-id"]);
    expect(saveSpy).toHaveBeenCalled();
    expect(chatUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("New Pizza"),
      }),
    );
  });

  it("handles refinement failure when refineNutritionItems returns no items", async () => {
    const db = createMockDb();
    const mockExecute = getMockExecute(db);

    mockExecute.mockResolvedValueOnce([{ user_id: "user-123" }]);

    vi.spyOn(FoodEntryRepository.prototype, "loadForRefinement").mockResolvedValue(
      castMock([{ foodName: "Test" }]),
    );
    mockRefine.mockResolvedValueOnce({
      items: [],
      provider: "gemini",
    });

    const { messageHandler } = setupHandlers(db);

    const say = vi.fn();
    const chatPostMessage = vi.fn().mockResolvedValue({ ts: "thinking-ts" });
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
                { type: "actions", elements: [{ action_id: "confirm_food", value: "id" }] },
              ],
            },
          ],
        }),
      },
      chat: { postMessage: chatPostMessage, update: vi.fn() },
    };

    await messageHandler({
      message: { user: "U1", text: "refine", ts: "2", thread_ts: "1", channel: "C1" },
      say,
      client,
    });

    expect(say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Sorry, I couldn't refine that"),
      }),
    );
  });

  it("does not enter refinement if previousEntryIds is null", async () => {
    const db = createMockDb();
    const { messageHandler } = setupHandlers(db);
    const say = vi.fn();
    const client = {
      conversations: {
        replies: vi.fn().mockResolvedValue({ messages: [] }),
      },
    };
    await messageHandler({
      message: { user: "U1", text: "refine", ts: "2", thread_ts: "1", channel: "C1" },
      say,
      client,
    });
    expect(mockRefine).not.toHaveBeenCalled();
  });
});
