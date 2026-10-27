import type { CatalogueSeed } from "@dofek/training/climbing-catalogue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClimbingCatalogueService } from "../climbing-catalogue.ts";
import { MemoryCacheStore } from "../lib/cache.ts";
import { processClimbingCatalogueJob } from "./climbing-catalogue-job.ts";

const mocks = vi.hoisted(() => ({ seed: vi.fn(), adapters: vi.fn(), allowed: vi.fn() }));
vi.mock("../db/climbing-catalogue-seed.ts", () => ({ loadCatalogueSeed: mocks.seed }));
vi.mock("../climbing-catalogue-sources.ts", () => ({
  createClimbingCatalogueAdapters: mocks.adapters,
}));
vi.mock("./account-erasure-work-guard.ts", () => ({
  accountErasureAllowsQueuedUserWork: mocks.allowed,
}));
const seed: CatalogueSeed = {
  userId: "user-a",
  logEntryId: "log-a",
  providerId: "kaya",
  externalId: "1",
  sourceUrl: null,
  name: "Cragmont Crack",
  kind: "route",
  setting: "outdoor",
  locations: [],
};
const data = { type: "climbing-catalogue" as const, userId: "user-a", logEntryId: "log-a", seed };

describe("processClimbingCatalogueJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.seed.mockResolvedValue(seed);
    mocks.adapters.mockReturnValue([]);
    mocks.allowed.mockResolvedValue(true);
  });
  it("refreshes only the active user's source and stores disposable context", async () => {
    const cache = new MemoryCacheStore();
    await processClimbingCatalogueJob(data, Object.create(null), cache);
    expect((await new ClimbingCatalogueService(cache, []).read(seed)).status).toBe("ready");
    expect(mocks.seed).toHaveBeenCalledWith(expect.anything(), "user-a", "log-a");
  });
  it("does not fetch catalogue data for an erased user or missing active source", async () => {
    mocks.allowed.mockResolvedValueOnce(false);
    await processClimbingCatalogueJob(data, Object.create(null), new MemoryCacheStore());
    expect(mocks.seed).not.toHaveBeenCalled();
    mocks.seed.mockResolvedValueOnce(null);
    await processClimbingCatalogueJob(data, Object.create(null), new MemoryCacheStore());
    expect(mocks.adapters).not.toHaveBeenCalled();
  });
  it("invalidates the old cached fingerprint when a source changes during lookup", async () => {
    const cache = new MemoryCacheStore();
    mocks.seed
      .mockResolvedValueOnce(seed)
      .mockResolvedValueOnce({ ...seed, name: "Changed route" });
    await processClimbingCatalogueJob(data, Object.create(null), cache);
    expect((await new ClimbingCatalogueService(cache, []).read(seed)).status).toBe("missing");
  });
  it("preserves actionable failures in the cache and fails the background job", async () => {
    const cache = new MemoryCacheStore();
    mocks.adapters.mockReturnValue([
      {
        providerId: "kaya",
        search: async () => {
          throw new Error("KAYA catalogue request failed (403). Try again later.");
        },
      },
    ]);
    await expect(processClimbingCatalogueJob(data, Object.create(null), cache)).rejects.toThrow(
      "403",
    );
    expect((await new ClimbingCatalogueService(cache, []).read(seed)).error).toContain("403");
  });

  it.each(["guard", "load", "factory"])(
    "stores actionable %s prelude failures and rethrows",
    async (phase) => {
      const error = new Error(`${phase} catalogue initialization failed. Try refreshing again.`);
      if (phase === "guard") mocks.allowed.mockRejectedValue(error);
      else if (phase === "load") mocks.seed.mockRejectedValue(error);
      else
        mocks.adapters.mockImplementation(() => {
          throw error;
        });
      const cache = new MemoryCacheStore();
      await expect(processClimbingCatalogueJob(data, Object.create(null), cache)).rejects.toThrow(
        error,
      );
      expect(await new ClimbingCatalogueService(cache, []).read(seed)).toMatchObject({
        status: "error",
        error: error.message,
      });
    },
  );
  it("keeps erased users' cache empty even when an enqueued seed exists", async () => {
    mocks.allowed.mockResolvedValue(false);
    const cache = new MemoryCacheStore();
    await processClimbingCatalogueJob(data, Object.create(null), cache);
    expect((await new ClimbingCatalogueService(cache, []).read(seed)).status).toBe("missing");
  });
});
