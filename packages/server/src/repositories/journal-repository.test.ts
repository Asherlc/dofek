import { describe, expect, it, vi } from "vitest";
import { JournalRepository } from "./journal-repository.ts";

function makeRepository(rows: Record<string, unknown>[] = []) {
  const execute = vi.fn().mockResolvedValue(rows);
  const repository = new JournalRepository({ execute }, "user-1");
  return { repository, execute };
}

describe("JournalRepository", () => {
  describe("ensureDofekProvider", () => {
    it("calls execute once", async () => {
      const { repository, execute } = makeRepository();
      await repository.ensureDofekProvider();
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("listQuestions", () => {
    it("returns empty array when no questions exist", async () => {
      const { repository } = makeRepository([]);
      const result = await repository.listQuestions();
      expect(result).toEqual([]);
    });

    it("returns parsed question rows", async () => {
      const { repository } = makeRepository([
        {
          slug: "caffeine",
          display_name: "Caffeine",
          category: "substance",
          data_type: "boolean",
          unit: null,
          sort_order: 1,
        },
      ]);
      const result = await repository.listQuestions();
      expect(result).toEqual([
        {
          slug: "caffeine",
          display_name: "Caffeine",
          category: "substance",
          data_type: "boolean",
          unit: null,
          sort_order: 1,
        },
      ]);
    });

    it("calls execute once", async () => {
      const { repository, execute } = makeRepository([]);
      await repository.listQuestions();
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("listEntries", () => {
    it("returns empty array when no entries exist", async () => {
      const { repository } = makeRepository([]);
      const result = await repository.listEntries(30);
      expect(result).toEqual([]);
    });

    it("returns parsed entry rows with question metadata", async () => {
      const { repository } = makeRepository([
        {
          id: "entry-1",
          date: "2025-01-15",
          provider_id: "dofek",
          question_slug: "caffeine",
          display_name: "Caffeine",
          category: "substance",
          data_type: "boolean",
          unit: null,
          answer_text: "yes",
          answer_numeric: null,
          impact_score: null,
        },
      ]);
      const result = await repository.listEntries(30);
      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe("entry-1");
      expect(result[0]?.question_slug).toBe("caffeine");
    });

    it("calls execute once", async () => {
      const { repository, execute } = makeRepository([]);
      await repository.listEntries(7);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("listTrends", () => {
    it("returns empty array when no trend data exists", async () => {
      const { repository } = makeRepository([]);
      const result = await repository.listTrends("caffeine", 90);
      expect(result).toEqual([]);
    });

    it("returns parsed trend points", async () => {
      const { repository } = makeRepository([
        { date: "2025-01-10", value: "3" },
        { date: "2025-01-11", value: "5" },
      ]);
      const result = await repository.listTrends("mood", 90);
      expect(result).toEqual([
        { date: "2025-01-10", value: 3 },
        { date: "2025-01-11", value: 5 },
      ]);
    });

    it("calls execute once", async () => {
      const { repository, execute } = makeRepository([]);
      await repository.listTrends("mood", 30);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("createEntry", () => {
    it("calls ensureDofekProvider then inserts and returns the entry", async () => {
      const entryRow = {
        id: "new-entry-1",
        date: "2025-03-01",
        provider_id: "dofek",
        user_id: "user-1",
        question_slug: "mood",
        answer_text: null,
        answer_numeric: 7,
        impact_score: null,
      };
      // First call is ensureDofekProvider, second is the INSERT
      const execute = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([entryRow]);
      const repository = new JournalRepository({ execute }, "user-1");

      const result = await repository.createEntry({
        date: "2025-03-01",
        questionSlug: "mood",
        answerText: null,
        answerNumeric: 7,
      });

      expect(execute).toHaveBeenCalledTimes(2);
      expect(result.id).toBe("new-entry-1");
      expect(result.answer_numeric).toBe(7);
    });
  });

  describe("updateEntry", () => {
    it("returns null when no fields to update", async () => {
      const { repository, execute } = makeRepository([]);
      const result = await repository.updateEntry({ id: "entry-1" });
      expect(result).toBeNull();
      expect(execute).not.toHaveBeenCalled();
    });

    it("updates answerText and returns the entry", async () => {
      const updatedRow = {
        id: "entry-1",
        date: "2025-03-01",
        provider_id: "dofek",
        user_id: "user-1",
        question_slug: "mood",
        answer_text: "updated text",
        answer_numeric: null,
        impact_score: null,
      };
      const { repository } = makeRepository([updatedRow]);
      const result = await repository.updateEntry({
        id: "entry-1",
        answerText: "updated text",
      });
      expect(result?.answer_text).toBe("updated text");
    });

    it("updates answerNumeric and returns the entry", async () => {
      const updatedRow = {
        id: "entry-1",
        date: "2025-03-01",
        provider_id: "dofek",
        user_id: "user-1",
        question_slug: "mood",
        answer_text: null,
        answer_numeric: 9,
        impact_score: null,
      };
      const { repository } = makeRepository([updatedRow]);
      const result = await repository.updateEntry({
        id: "entry-1",
        answerNumeric: 9,
      });
      expect(result?.answer_numeric).toBe(9);
    });

    it("returns null when entry not found", async () => {
      const { repository } = makeRepository([]);
      const result = await repository.updateEntry({
        id: "nonexistent",
        answerText: "foo",
      });
      expect(result).toBeNull();
    });

    it("handles setting fields to null", async () => {
      const updatedRow = {
        id: "entry-1",
        date: "2025-03-01",
        provider_id: "dofek",
        user_id: "user-1",
        question_slug: "mood",
        answer_text: null,
        answer_numeric: null,
        impact_score: null,
      };
      const { repository, execute } = makeRepository([updatedRow]);
      const result = await repository.updateEntry({
        id: "entry-1",
        answerText: null,
        answerNumeric: null,
      });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(result?.answer_text).toBeNull();
      expect(result?.answer_numeric).toBeNull();
    });
  });

  describe("deleteEntry", () => {
    it("calls execute and returns success", async () => {
      const { repository, execute } = makeRepository([]);
      const result = await repository.deleteEntry("entry-1");
      expect(result).toEqual({ success: true });
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("createQuestion", () => {
    it("returns empty array when no rows returned", async () => {
      const { repository } = makeRepository([
        {
          slug: "custom_q",
          display_name: "Custom Question",
          category: "custom",
          data_type: "text",
          unit: null,
          sort_order: 100,
        },
      ]);
      const result = await repository.createQuestion({
        slug: "custom_q",
        displayName: "Custom Question",
        category: "custom",
        dataType: "text",
        unit: null,
      });
      expect(result.slug).toBe("custom_q");
      expect(result.display_name).toBe("Custom Question");
    });

    it("calls execute once", async () => {
      const { repository, execute } = makeRepository([
        {
          slug: "test",
          display_name: "Test",
          category: "custom",
          data_type: "boolean",
          unit: null,
          sort_order: 0,
        },
      ]);
      await repository.createQuestion({
        slug: "test",
        displayName: "Test",
        category: "custom",
        dataType: "boolean",
        unit: null,
      });
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });
});
