import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

const { mockAlerts, mockHistory, mockStatus } = vi.hoisted(() => ({
  mockAlerts: vi.fn(),
  mockHistory: vi.fn(),
  mockStatus: vi.fn(),
}));

vi.mock("../repositories/processing-repository.ts", () => ({
  ProcessingRepository: class {
    alerts = mockAlerts;
    status = mockStatus;
    history = mockHistory;
  },
}));

import { processingRouter } from "./processing.ts";

const createCaller = createTestCallerFactory(processingRouter);
const userId = "10000000-0000-4000-8000-000000000001";

describe("processingRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("validates the processing history response at runtime", async () => {
    mockHistory.mockResolvedValue({
      operations: [
        {
          id: "10000000-0000-4000-8000-000000000002",
          userId,
          providerId: "kaya-export",
          kind: "file_import",
          externalCorrelationKey: "import-1",
          datasetKeys: ["activity"],
          createdAt: "not-a-date",
        },
      ],
      nextCursor: null,
    });
    const caller = createCaller({ db: {}, userId, timezone: "UTC" });

    await expect(caller.history({ limit: 20 })).rejects.toThrow();
  });

  it("normalizes processing history timestamps to ISO strings", async () => {
    mockHistory.mockResolvedValue({
      operations: [
        {
          id: "10000000-0000-4000-8000-000000000002",
          userId,
          providerId: "kaya-export",
          kind: "file_import",
          externalCorrelationKey: "import-1",
          datasetKeys: ["activity"],
          createdAt: new Date("2026-07-22T12:00:00.000Z"),
        },
      ],
      nextCursor: null,
    });
    const caller = createCaller({ db: {}, userId, timezone: "UTC" });

    const result = await caller.history({ limit: 20 });

    expect(result.operations[0]?.createdAt).toBe("2026-07-22T12:00:00.000Z");
  });

  it("returns structured customer alerts", async () => {
    mockAlerts.mockResolvedValue({
      generatedAt: "2026-07-22T12:00:00.000Z",
      alerts: [
        {
          id: "10000000-0000-4000-8000-000000000002:providers",
          providerId: "garmin",
          providerLabel: "Garmin",
          datasetKey: "providers",
          occurredAt: "2026-07-22T11:59:00.000Z",
          title: "Garmin summary wasn’t updated",
          message: "Your Garmin data is still available.",
          action: "retry_sync",
          actionLabel: "Retry Garmin sync",
        },
      ],
    });
    const caller = createCaller({ db: {}, userId, timezone: "UTC" });

    await expect(caller.alerts()).resolves.toEqual({
      generatedAt: "2026-07-22T12:00:00.000Z",
      alerts: [
        expect.objectContaining({
          providerLabel: "Garmin",
          action: "retry_sync",
        }),
      ],
    });
  });
});
