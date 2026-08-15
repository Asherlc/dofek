import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

const { mockCurrentPhase, mockHistory, mockRepository } = vi.hoisted(() => ({
  mockCurrentPhase: vi.fn(),
  mockHistory: vi.fn(),
  mockRepository: vi.fn(),
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC.context<{ db: unknown; userId: string; timezone: string }>().create();
  return {
    router: trpc.router,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000 },
  };
});

vi.mock("../repositories/menstrual-cycle-repository.ts", () => ({
  MenstrualCycleRepository: mockRepository,
}));

import { menstrualCycleRouter } from "./menstrual-cycle.ts";

const createCaller = createTestCallerFactory(menstrualCycleRouter);

describe("menstrualCycleRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRepository.mockImplementation(() => ({
      getCurrentPhase: mockCurrentPhase,
      getHistory: mockHistory,
    }));
  });

  it("returns the server-authored current phase result", async () => {
    const result = {
      phase: null,
      dayOfCycle: null,
      cycleLength: null,
      estimate: null,
      latestCycleStart: null,
      availability: {
        status: "no-history" as const,
        label: "No cycle starts are available from provider records.",
      },
    };
    mockCurrentPhase.mockResolvedValue(result);
    const caller = createCaller({ db: {}, userId: "user-1", timezone: "America/Los_Angeles" });

    await expect(caller.currentPhase()).resolves.toEqual(result);
    expect(mockRepository).toHaveBeenCalledWith({}, "user-1", "America/Los_Angeles");
  });

  it("returns provider-attributed history with a default six-month range", async () => {
    const history = [
      {
        id: "cycle-start:2026-08-01",
        startDate: "2026-08-01",
        sources: [
          {
            providerId: "apple_health",
            sourceName: "Cycle Source",
            sourceBundle: "com.example.cycle",
          },
        ],
      },
    ];
    mockHistory.mockResolvedValue(history);
    const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

    await expect(caller.history({})).resolves.toEqual(history);
    expect(mockHistory).toHaveBeenCalledWith(6);
  });

  it("validates the history month range", async () => {
    const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });
    await expect(caller.history({ months: 0 })).rejects.toThrow();
    await expect(caller.history({ months: 25 })).rejects.toThrow();
    await expect(caller.history({ months: 1.5 })).rejects.toThrow();
  });
});
