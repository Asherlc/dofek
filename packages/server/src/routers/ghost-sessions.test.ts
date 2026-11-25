import { createDatabase } from "dofek/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { GhostSessionsRepository } from "../repositories/ghost-sessions-repository.ts";
import { createGhostSessionsRouter } from "./ghost-sessions.ts";
import { makeMockSensorStore } from "./test-helpers.ts";

const userId = "858be315-220f-417f-8e30-5178f6e9da2d";
const activityId = "a01e19df-d55a-4282-b708-abf628bfc673";
const database = createDatabase("postgresql://unused:unused@localhost:1/unused");
afterAll(() => database.$client.end());

function fixture(authenticatedUserId: string | null = userId) {
  const repository = {
    get: vi.fn<GhostSessionsRepository["get"]>().mockResolvedValue({
      availability: "processing",
      sport: null,
      gpsCoverage: null,
      historyCoverage: "partial",
      nameStatus: "disabled",
      sections: [],
    }),
    passes: vi
      .fn<GhostSessionsRepository["passes"]>()
      .mockResolvedValue({ passes: [], nextCursor: null }),
    compare: vi.fn<GhostSessionsRepository["compare"]>(),
  };
  const createRepository = vi.fn(() => repository);
  const caller = createGhostSessionsRouter(createRepository).createCaller({
    db: database,
    userId: authenticatedUserId,
    timezone: "UTC",
    sensorStore: makeMockSensorStore(),
    accountErasureRestoreLedger: {
      findIntent: async () => null,
      listIntentReferences: async () => [],
      listIntentsForIdentities: async () => [],
      recordIntent: async () => undefined,
    },
  });
  return { caller, repository, createRepository };
}

describe("ghostSessions router", () => {
  it("blocks anonymous get, passes and compare before loading the repository", async () => {
    const { caller, createRepository } = fixture(null);
    await expect(caller.get({ activityId })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.passes({ activityId, sectionId: "section" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      caller.compare({ activityId, sectionId: "section", passId: "pass" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(createRepository).not.toHaveBeenCalled();
  });

  it("validates scoped IDs and cursor limits through the shared inputs before reads", async () => {
    const { caller, createRepository } = fixture();
    await expect(caller.get({ activityId: "invalid" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      caller.passes({ activityId, sectionId: "section", cursor: "x".repeat(2_049) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.compare({ activityId, sectionId: "section", passId: "" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(createRepository).not.toHaveBeenCalled();
  });

  it("uses request context and verifies the shared output before returning it", async () => {
    const { caller, createRepository, repository } = fixture();
    await expect(caller.get({ activityId })).resolves.toMatchObject({ availability: "processing" });
    expect(createRepository).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        timezone: "UTC",
        accessWindow: { kind: "full", paid: true, reason: "paid_grant" },
      }),
    );
    expect(repository.get).toHaveBeenCalledWith({ activityId });
    await expect(caller.passes({ activityId, sectionId: "section" })).resolves.toEqual({
      passes: [],
      nextCursor: null,
    });
    expect(repository.passes).toHaveBeenCalledWith({ activityId, sectionId: "section" });
    await expect(
      caller.compare({ activityId, sectionId: "section", passId: "pass" }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(repository.compare).toHaveBeenCalledWith({
      activityId,
      sectionId: "section",
      passId: "pass",
    });
  });
});
