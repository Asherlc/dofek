import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAdd = vi.fn((..._args: unknown[]) => Promise.resolve());
const mockClose = vi.fn(() => Promise.resolve());
const mockLoggerInfo = vi.fn();

vi.mock("./queues.ts", () => ({
  createSyncQueue: vi.fn(() => ({
    add: (...args: unknown[]) => mockAdd(...args),
    close: () => mockClose(),
  })),
}));

vi.mock("../logger.ts", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
  },
}));

vi.mock("../providers/index.ts", () => ({
  getProvider: (providerId: string) => {
    if (providerId === "strong-csv") return { id: providerId, importOnly: true as const };
    return { id: providerId };
  },
  isSyncEligibleProvider: (provider: { importOnly?: boolean }) => !provider.importOnly,
}));

vi.mock("./provider-registration.ts", () => ({
  ensureProvidersRegistered: vi.fn().mockResolvedValue(undefined),
}));

const { processScheduledSyncJob } = await import("./process-scheduled-sync-job.ts");

describe("processScheduledSyncJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enqueues sync jobs for non-CSV providers only", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([
        { user_id: "user-1", provider_id: "strava" },
        { user_id: "user-1", provider_id: "strong-csv" },
        { user_id: "user-2", provider_id: "wahoo" },
      ]),
    };

    await Reflect.apply(processScheduledSyncJob, undefined, [{}, db]);

    expect(mockAdd).toHaveBeenCalledTimes(2);
    expect(mockAdd).toHaveBeenCalledWith("sync", {
      userId: "user-1",
      providerId: "strava",
      sinceDays: 1,
    });
    expect(mockAdd).toHaveBeenCalledWith("sync", {
      userId: "user-2",
      providerId: "wahoo",
      sinceDays: 1,
    });
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[scheduled-sync] Skipping CSV provider strong-csv",
    );
  });
});
