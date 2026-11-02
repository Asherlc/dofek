import type { CatalogueSeed } from "@dofek/training/climbing-catalogue";
import { ClimbingCatalogueService } from "dofek/climbing-catalogue";
import { MemoryCacheStore } from "dofek/lib/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClimbingStrengthsEnrichmentRepository } from "./climbing-strengths-enrichment-repository.ts";

const mocks = vi.hoisted(() => ({
  seeds: vi.fn(),
  enqueue: vi.fn(),
  state: vi.fn(),
  fence: vi.fn(),
}));
vi.mock("dofek/db/climbing-catalogue-seed", () => ({ loadCatalogueSeeds: mocks.seeds }));
vi.mock("dofek/jobs/queues", async (original) => ({
  ...(await original<typeof import("dofek/jobs/queues")>()),
  enqueueClimbingCatalogueRefresh: mocks.enqueue,
  getClimbingCatalogueRefreshState: mocks.state,
}));
vi.mock("dofek/db/account-erasure", () => ({ withAccountErasureUserWriteFence: mocks.fence }));
const seed: CatalogueSeed = {
  userId: "user-a",
  logEntryId: "log-a",
  providerId: "thecrag",
  externalId: "123",
  sourceUrl: null,
  name: "Route",
  kind: "route",
  setting: "outdoor",
  locations: [],
};
const repeat = { ...seed, logEntryId: "log-b" };
function setup() {
  const db = Object.create(null);
  const service = new ClimbingCatalogueService(new MemoryCacheStore(), []);
  return {
    db,
    service,
    repository: new ClimbingStrengthsEnrichmentRepository(
      db,
      seed.userId,
      "UTC",
      undefined,
      service,
    ),
  };
}
describe("ClimbingStrengthsEnrichmentRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.seeds.mockResolvedValue([seed, repeat]);
    mocks.enqueue.mockResolvedValue(undefined);
    mocks.state.mockResolvedValue(null);
    mocks.fence.mockImplementation(async (_db, _userId, operation) =>
      operation(Object.create(null)),
    );
  });
  it("batch-loads only supplied IDs and enqueues once per source under the user fence", async () => {
    const { db, repository } = setup();
    const result = await repository.getContexts(["log-a", "log-b"]);
    expect(mocks.seeds).toHaveBeenCalledWith(db, "user-a", ["log-a", "log-b"]);
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith(seed);
    expect(mocks.fence).toHaveBeenCalledWith(db, "user-a", expect.any(Function));
    expect(result.pending).toBe(true);
    expect(result.contexts.get("log-a")?.status).toBe("pending");
    expect(result.contexts.get("log-b")).toEqual(result.contexts.get("log-a"));
  });
  it("reuses cached source context for all repeats without upstream requests or requeue", async () => {
    const { service, repository } = setup();
    const context = await service.refresh(seed);
    const result = await repository.getContexts(["log-a", "log-b"]);
    expect(result).toEqual({
      seeds: new Map([
        ["log-a", seed],
        ["log-b", repeat],
      ]),
      contexts: new Map([
        ["log-a", context],
        ["log-b", context],
      ]),
      pending: false,
      errors: [],
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("uses live queue state and does not enqueue an already pending representative", async () => {
    const { repository } = setup();
    mocks.state.mockResolvedValue("pending");
    expect((await repository.getContexts(["log-a", "log-b"])).pending).toBe(true);
    expect(mocks.state).toHaveBeenCalledExactlyOnceWith("user-a", "log-a");
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("keeps cached actionable errors and does not automatically retry them", async () => {
    const { service, repository } = setup();
    await service.markFailed(seed, new Error("Source is blocked. Refresh later."));
    const result = await repository.getContexts(["log-a", "log-b"]);
    expect(result.errors).toEqual(["Source is blocked. Refresh later."]);
    expect(result.contexts.get("log-b")?.status).toBe("error");
    expect(result.pending).toBe(false);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("reports queue errors and records failure rather than claiming pending", async () => {
    const { service, repository } = setup();
    mocks.enqueue.mockRejectedValue(new Error("Queue unavailable. Try refreshing later."));
    const result = await repository.getContexts(["log-a", "log-b"]);
    expect(result.pending).toBe(false);
    expect(result.errors).toEqual(["Queue unavailable. Try refreshing later."]);
    expect((await service.read(repeat)).error).toContain("Queue unavailable");
    expect(result.contexts.get("log-a")?.status).toBe("error");
  });
  it("does not write cache or dispatch after the account erasure fence rejects work", async () => {
    const { service, repository } = setup();
    mocks.fence.mockRejectedValue(new Error("Account erasure is in progress."));
    await expect(repository.getContexts(["log-a"])).rejects.toThrow("Account erasure");
    expect((await service.read(seed)).status).toBe("missing");
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("returns current source seeds and selects a stable representative for repeated climbs", async () => {
    const { repository } = setup();
    mocks.seeds.mockResolvedValue([repeat, seed]);
    const result = await repository.getContexts(["log-b", "log-a"]);
    expect(result.seeds).toEqual(
      new Map([
        ["log-b", repeat],
        ["log-a", seed],
      ]),
    );
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith(seed);
  });
  it("retains source seeds without an identity or name without queuing work", async () => {
    const { repository } = setup();
    const unnamed = { ...seed, name: null, externalId: null, sourceUrl: null };
    mocks.seeds.mockResolvedValue([unnamed]);
    const result = await repository.getContexts(["log-a"]);
    expect(result.seeds.get("log-a")).toEqual(unnamed);
    expect(result.contexts.size).toBe(0);
    expect(result.pending).toBe(false);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("does no work for an empty selection", async () => {
    const { repository } = setup();
    expect(await repository.getContexts([])).toEqual({
      seeds: new Map(),
      contexts: new Map(),
      pending: false,
      errors: [],
    });
    expect(mocks.seeds).not.toHaveBeenCalled();
  });
});
