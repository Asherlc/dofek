import { describe, expect, it, vi } from "vitest";
import {
  FoodEntryRepository,
  extractLatestConfirmFromThread,
  slackTimestampToDateString,
  slackTimestampToLocalTime,
} from "./food-entry-repository.ts";
import { castMock, mockAs } from "./bot-unit.test.ts";

describe("food-entry-repository utility functions", () => {
  describe("extractLatestConfirmFromThread", () => {
    it("returns null for empty messages", () => {
      expect(extractLatestConfirmFromThread([])).toBeNull();
    });

    it("skips messages without bot_id or blocks", () => {
      const messages = [{ ts: "1" }, { ts: "2", bot_id: "B1" }, { ts: "3", blocks: [] }];
      expect(extractLatestConfirmFromThread(messages)).toBeNull();
    });

    it("extracts IDs from the LATEST bot message with confirm button", () => {
      const messages = [
        {
          ts: "100.000",
          bot_id: "B1",
          blocks: [
            {
              type: "actions",
              elements: [{ action_id: "confirm_food", value: "id1,id2" }],
            },
          ],
        },
        {
          ts: "200.000",
          bot_id: "B1",
          blocks: [
            {
              type: "actions",
              elements: [{ action_id: "confirm_food", value: "id3,id4" }],
            },
          ],
        },
        {
          ts: "300.000",
          text: "Some other message",
        },
      ];
      const result = extractLatestConfirmFromThread(messages);
      expect(result).toEqual({
        entryIds: ["id3", "id4"],
        messageTs: "200.000",
      });
    });

    it("skips non-matching action IDs", () => {
      const messages = [
        {
          ts: "100.000",
          bot_id: "B1",
          blocks: [
            {
              type: "actions",
              elements: [{ action_id: "other_action", value: "id1" }],
            },
          ],
        },
      ];
      expect(extractLatestConfirmFromThread(messages)).toBeNull();
    });

    it("handles malformed block data gracefully", () => {
      const messages = [
        {
          ts: "100.000",
          bot_id: "B1",
          blocks: [{ type: "not-an-actions-block" }],
        },
      ];
      expect(extractLatestConfirmFromThread(messages)).toBeNull();
    });

    it("handles empty or whitespace values in confirm button", () => {
      const messages = [
        {
          ts: "100.000",
          bot_id: "B1",
          blocks: [
            {
              type: "actions",
              elements: [{ action_id: "confirm_food", value: "" }],
            },
          ],
        },
        {
          ts: "200.000",
          bot_id: "B1",
          blocks: [
            {
              type: "actions",
              elements: [{ action_id: "confirm_food", value: ", , ," }],
            },
          ],
        },
      ];
      expect(extractLatestConfirmFromThread(messages)).toBeNull();
    });

    it("terminates loop correctly at index 0 (kills i > 0 mutation)", () => {
      const messages = [
        {
          ts: "100.000",
          bot_id: "B1",
          blocks: [
            {
              type: "actions",
              elements: [{ action_id: "confirm_food", value: "first" }],
            },
          ],
        },
      ];
      const result = extractLatestConfirmFromThread(messages);
      expect(result?.entryIds).toEqual(["first"]);
    });
  });

  describe("slackTimestampToDateString", () => {
    it("converts slack ts to ISO date string", () => {
      // 1713290400 is 2024-04-16T18:00:00Z
      expect(slackTimestampToDateString("1713290400.000", "UTC")).toBe("2024-04-16");
    });
  });

  describe("slackTimestampToLocalTime", () => {
    it("formats time with 12-hour clock (kills hour12: false mutation)", () => {
      const ts = "1713290400.000"; // 18:00 UTC
      const formatted = slackTimestampToLocalTime(ts, "UTC");
      expect(formatted).toContain("6:00 PM");
      expect(formatted).not.toContain("18:00");
    });
  });
});

describe("FoodEntryRepository", () => {
  it("throws error in confirm if row is missing (kills if(!row){} mutation)", async () => {
    const mockDb = mockAs<import("dofek/db").Database>({
      execute: vi.fn().mockResolvedValue([]), // Return empty array for RETURNING id
    });
    const mockPendingStore = {
      loadByIds: vi.fn().mockResolvedValue([
        {
          id: "id-1",
          userId: "user-1",
          date: "2024-04-16",
          item: { foodName: "Test" },
        },
      ]),
      deleteByIds: vi.fn(),
      findIdsByMessage: vi.fn(),
      save: vi.fn(),
    };

    const repository = new FoodEntryRepository(mockDb, castMock(mockPendingStore));

    // Mock other things needed for confirm
    vi.spyOn(repository, "lookupUserIdForEntries").mockResolvedValue("user-1");
    vi.spyOn(repository, "ensureDofekProvider").mockResolvedValue(undefined);

    await expect(repository.confirm(["id-1"])).rejects.toThrow(
      'Failed to confirm parsed food entry "Test"',
    );
  });
  
  it("handles empty entryIds in deleteUnconfirmed", async () => {
    const mockPendingStore = {
      deleteByIds: vi.fn(),
    };
    const repository = new FoodEntryRepository(castMock({}), castMock(mockPendingStore));
    await repository.deleteUnconfirmed([]);
    expect(mockPendingStore.deleteByIds).not.toHaveBeenCalled();
  });
});
