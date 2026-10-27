import type { CatalogueSeed } from "@dofek/training/climbing-catalogue";
import { ClimbingCatalogueService } from "dofek/climbing-catalogue";
import { MemoryCacheStore } from "dofek/lib/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClimbingCatalogueRepository } from "./climbing-catalogue-repository.ts";

const mocks = vi.hoisted(() => ({
  construct: vi.fn(),
  logs: vi.fn(),
  seed: vi.fn(),
  enqueue: vi.fn(),
  refreshState: vi.fn(),
  fence: vi.fn(),
}));
vi.mock("./climbing-activity-log-entry-repository.ts", () => ({
  ClimbingActivityLogEntryRepository: class {
    constructor(...args: unknown[]) {
      mocks.construct(...args);
    }
    getLogEntries = mocks.logs;
  },
}));
vi.mock("dofek/db/climbing-catalogue-seed", () => ({ loadCatalogueSeed: mocks.seed }));
vi.mock("dofek/jobs/queues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("dofek/jobs/queues")>()),
  enqueueClimbingCatalogueRefresh: mocks.enqueue,
  getClimbingCatalogueRefreshState: mocks.refreshState,
}));
vi.mock("dofek/db/account-erasure", () => ({ withAccountErasureUserWriteFence: mocks.fence }));

const seed: CatalogueSeed = {
  userId: "user-a",
  logEntryId: "log-a",
  providerId: "thecrag",
  externalId: "123",
  sourceUrl: null,
  name: "Test route",
  kind: "route",
  setting: "outdoor",
  locations: [],
};

describe("ClimbingCatalogueRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logs.mockResolvedValue([{}]);
    mocks.seed.mockResolvedValue(seed);
    mocks.fence.mockImplementation(async (_db, _userId, work) => work());
    mocks.enqueue.mockResolvedValue(undefined);
    mocks.refreshState.mockResolvedValue(null);
  });
  const setup = () => {
    const cache = new MemoryCacheStore();
    const service = new ClimbingCatalogueService(cache, []);
    const repository = new ClimbingCatalogueRepository(
      Object.create(null),
      "user-a",
      "UTC",
      undefined,
      service,
    );
    return { repository, service };
  };
  it("reads cache after checking the requested log is visible in the access window", async () => {
    const { repository } = setup();
    expect((await repository.read("log-a")).status).toBe("missing");
    expect(mocks.logs).toHaveBeenCalledWith(["log-a"]);
  });
  it("passes the caller access window to log authorization", async () => {
    const db = Object.create(null);
    const access = {
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: "2026-10-01",
      endDateExclusive: "2026-11-01",
    } as const;
    const service = new ClimbingCatalogueService(new MemoryCacheStore(), []);
    await new ClimbingCatalogueRepository(
      db,
      "user-a",
      "America/Los_Angeles",
      access,
      service,
    ).read("log-a");
    expect(mocks.construct).toHaveBeenCalledWith(db, "user-a", "America/Los_Angeles", access);
  });
  it("preserves ready metadata when a duplicate refresh races with worker completion", async () => {
    const { repository, service } = setup();
    mocks.refreshState.mockResolvedValue("pending");
    expect((await repository.requestRefresh("log-a")).status).toBe("pending");
    // The first worker writes its result while its BullMQ job is still active.
    const cached = await service.refresh(seed);
    // The second add coalesces with that job, so it will not run another refresh.
    await repository.requestRefresh("log-a");
    expect(await service.read(seed)).toEqual(cached);
    mocks.refreshState.mockResolvedValue(null);
    expect(await repository.read("log-a")).toEqual(cached);
  });
  it("returns ready when a fast worker finishes before enqueue returns", async () => {
    const { repository, service } = setup();
    mocks.enqueue.mockImplementation(async () => {
      await service.refresh(seed);
    });
    expect((await repository.requestRefresh("log-a")).status).toBe("ready");
  });
  it("derives pending only while queued work exists and retains cached source context", async () => {
    const { repository, service } = setup();
    const cached = await service.refresh(seed);
    mocks.refreshState.mockResolvedValue("pending");
    expect(await repository.read("log-a")).toEqual({ ...cached, status: "pending", error: null });
    expect(await service.read(seed)).toEqual(cached);
    mocks.refreshState.mockResolvedValue(null);
    expect(await repository.read("log-a")).toEqual(cached);
  });
  it("uses the erasure-fenced transaction for refresh authorization", async () => {
    const { repository } = setup();
    const transaction = Object.create(null);
    mocks.fence.mockImplementation(async (_db, _userId, work) => work(transaction));
    await repository.requestRefresh("log-a");
    expect(mocks.seed).toHaveBeenCalledWith(transaction, "user-a", "log-a");
  });
  it("rejects hidden or foreign logs before reading cached information", async () => {
    mocks.logs.mockResolvedValue([]);
    await expect(setup().repository.read("foreign")).rejects.toThrow("Climbing log not found");
    expect(mocks.seed).not.toHaveBeenCalled();
  });
  it("rejects source records that disappeared between authorization and cache access", async () => {
    mocks.seed.mockResolvedValue(null);
    await expect(setup().repository.read("log-a")).rejects.toThrow("Climbing log not found");
  });
  it("enqueues refresh inside the erasure fence and returns pending context", async () => {
    const { repository } = setup();
    mocks.refreshState.mockResolvedValue("pending");
    expect((await repository.requestRefresh("log-a")).status).toBe("pending");
    expect(mocks.enqueue).toHaveBeenCalledWith(seed);
    expect(mocks.fence).toHaveBeenCalled();
  });
  it("reports queue failures without leaving a false pending state", async () => {
    const { repository, service } = setup();
    mocks.enqueue.mockRejectedValue(new Error("Catalogue refresh could not be queued. Try again."));
    await expect(repository.requestRefresh("log-a")).rejects.toThrow("could not be queued");
    expect(await service.read(seed)).toMatchObject({
      status: "error",
      error: "Catalogue refresh could not be queued. Try again.",
    });
  });
});
