import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

const { mockHistory, mockStatus } = vi.hoisted(() => ({
  mockHistory: vi.fn(),
  mockStatus: vi.fn(),
}));

vi.mock("../repositories/processing-repository.ts", () => ({
  ProcessingRepository: class {
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
});
