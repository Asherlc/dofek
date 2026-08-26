import { describe, expect, it, vi } from "vitest";
import { makeTransactionalTestDatabase } from "../routers/test-helpers.ts";
import type { SaveActivityInput } from "./activity-recording-repository.ts";
import { ActivityRecordingRepository } from "./activity-recording-repository.ts";

vi.mock("../../../../src/db/provider-data-deletion.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/db/provider-data-deletion.ts")>();
  const { resolveProviderDataGenerationsForTest } = await import("./test-helpers.ts");
  return { ...actual, getProviderDataGenerations: resolveProviderDataGenerationsForTest };
});

describe("ActivityRecordingRepository", () => {
  function makeRepository(executeResults?: Record<string, unknown>[][]) {
    const execute = vi.fn().mockResolvedValue([]);
    if (executeResults) {
      for (const result of executeResults) {
        execute.mockResolvedValueOnce(result);
      }
    } else {
      // Default: ensureProvider returns nothing, insert returns an id
      execute.mockResolvedValueOnce([]); // ensureProvider
      execute.mockResolvedValueOnce([{ id: "activity-123" }]); // INSERT RETURNING
    }
    const db = makeTransactionalTestDatabase({ execute });
    const repository = new ActivityRecordingRepository(db, "00000000-0000-0000-0000-000000000001");
    return { repository, execute };
  }

  function makeInput(overrides: Partial<SaveActivityInput> = {}): SaveActivityInput {
    return {
      activityType: "running",
      startedAt: "2024-06-15T08:00:00Z",
      endedAt: "2024-06-15T09:00:00Z",
      name: "Morning Run",
      notes: null,
      sourceName: "dofek-mobile",
      ...overrides,
    };
  }

  describe("ensureProvider", () => {
    it("executes an INSERT for the dofek provider", async () => {
      const { repository, execute } = makeRepository([[]]);
      await repository.ensureProvider();
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("saveActivity", () => {
    it("returns the activity id", async () => {
      const { repository } = makeRepository();
      const activityId = await repository.saveActivity(makeInput());
      expect(activityId).toBe("activity-123");
    });

    it("calls ensureProvider before inserting", async () => {
      const { repository, execute } = makeRepository();
      await repository.saveActivity(makeInput());
      // First call is ensureProvider, second is INSERT RETURNING
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it("throws when insert returns no rows", async () => {
      const { repository } = makeRepository([
        [], // ensureProvider
        [], // INSERT returns nothing
      ]);
      await expect(repository.saveActivity(makeInput())).rejects.toThrow(
        "Failed to insert activity",
      );
    });

  });
});
