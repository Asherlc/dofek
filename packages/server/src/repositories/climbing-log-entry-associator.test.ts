import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityRepository } from "./activity-repository.ts";
import { ClimbingActivityLogEntryRepository } from "./climbing-activity-log-entry-repository.ts";
import { ClimbingLogEntryAssociator } from "./climbing-log-entry-associator.ts";
import { climbingActivityFixture, climbingLogEntryFixture } from "./climbing-test-helpers.ts";

afterEach(() => vi.restoreAllMocks());
describe("ClimbingLogEntryAssociator", () => {
  it.each([
    ["climbing", "2026-01-01"],
    ["hiking", "2026-01-02"],
  ] as const)(
    "uses the displayed day and generic projection for %s",
    async (canonical_type, displayed_date) => {
      vi.spyOn(ActivityRepository.prototype, "findById").mockResolvedValue(
        climbingActivityFixture({ canonical_type, displayed_date }),
      );
      const log = climbingLogEntryFixture();
      const lookup = vi
        .spyOn(ClimbingActivityLogEntryRepository.prototype, "getUnattachedLogEntriesForDate")
        .mockResolvedValue([log]);
      expect(
        await new ClimbingLogEntryAssociator(
          { execute: vi.fn() },
          "user-1",
          "America/Los_Angeles",
        ).getSuggestions("activity"),
      ).toEqual([log]);
      expect(lookup).toHaveBeenCalledWith(displayed_date);
    },
  );
  it.each([
    [null, "NOT_FOUND"],
    [climbingActivityFixture({ canonical_type: "running" }), "PRECONDITION_FAILED"],
  ] as const)("reports unavailable or incompatible activity %j", async (found, code) => {
    vi.spyOn(ActivityRepository.prototype, "findById").mockResolvedValue(found);
    const repo = new ClimbingLogEntryAssociator({ execute: vi.fn() }, "user-1");
    await expect(repo.getSuggestions("activity")).rejects.toMatchObject({ code });
    await expect(
      repo.attachLogEntry({ climbingLogEntryId: "log", activityId: "activity" }),
    ).rejects.toMatchObject({ code });
  });
  it("reports a stale or concurrent attachment as a conflict", async () => {
    vi.spyOn(ActivityRepository.prototype, "findById").mockResolvedValue(climbingActivityFixture());
    await expect(
      new ClimbingLogEntryAssociator(
        { execute: vi.fn().mockResolvedValue([]) },
        "user-1",
      ).attachLogEntry({ climbingLogEntryId: "log", activityId: "activity" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("accepts the successful conditional attachment", async () => {
    vi.spyOn(ActivityRepository.prototype, "findById").mockResolvedValue(climbingActivityFixture());
    await expect(
      new ClimbingLogEntryAssociator(
        { execute: vi.fn().mockResolvedValue([{ id: climbingLogEntryFixture().id }]) },
        "user-1",
      ).attachLogEntry({ climbingLogEntryId: "log", activityId: "activity" }),
    ).resolves.toBeUndefined();
  });
});
