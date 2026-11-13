import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTransactionalTestDatabase } from "../providers/test-helpers.ts";
import { persistClimbingLogEntries } from "./climbing-log-sync.ts";

const mocks = vi.hoisted(() => ({ observe: vi.fn(), restore: vi.fn() }));
vi.mock("./climbing-log-activity.ts", () => ({
  persistClimbingLogActivityObservation: mocks.observe,
}));
vi.mock("./provider-activity-absence.ts", () => ({
  restoreProviderActivityPresence: mocks.restore,
}));

const userId = "00000000-0000-4000-8000-000000000001";
const providerId = "kilter";
const selectedActivityId = "00000000-0000-4000-8000-000000000002";
function makeDatabase() {
  const write = vi.fn().mockResolvedValue(undefined);
  const db = makeTransactionalTestDatabase({
    select: vi.fn().mockReturnValue({
      from: () => ({
        where: () => Object.assign(Promise.resolve([]), { orderBy: () => Promise.resolve([]) }),
      }),
    }),
    insert: vi.fn().mockReturnValue({ values: write }),
    delete: vi.fn(),
    execute: vi.fn().mockResolvedValue([]),
  });
  return { db, write };
}

describe("climbing log batch presence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.restore.mockResolvedValue(undefined);
  });

  it("restores only observed identities once after writing the complete batch", async () => {
    const { db, write } = makeDatabase();
    mocks.observe
      .mockResolvedValueOnce({ activityId: "point-a", observed: true })
      .mockResolvedValueOnce({ activityId: selectedActivityId, observed: false })
      .mockResolvedValueOnce({ activityId: "point-b", observed: true });

    const result = await persistClimbingLogEntries(db, {
      userId,
      providerId,
      entries: ["observed-a", "attached-elsewhere", "observed-b"].map((externalId) => ({
        externalId,
        attempts: [],
        activityId: externalId === "attached-elsewhere" ? selectedActivityId : null,
        activityObservation: { recordedAt: "2026-11-10T01:48:51.544Z" },
      })),
    });

    expect(result.recordsSynced).toBe(3);
    expect(write.mock.calls.map(([row]) => row.activityId)).toEqual([
      "point-a",
      selectedActivityId,
      "point-b",
    ]);
    expect(mocks.restore).toHaveBeenCalledExactlyOnceWith(db, {
      userId,
      providerId,
      externalIds: ["observed-a", "observed-b"],
    });
    expect(mocks.restore.mock.invocationCallOrder[0]).toBeGreaterThan(
      write.mock.invocationCallOrder[2] ?? 0,
    );
  });

  it("propagates a failed presence restoration instead of reporting a completed batch", async () => {
    const { db } = makeDatabase();
    const failure = new Error("Presence update failed");
    mocks.observe.mockResolvedValue({ activityId: "point-a", observed: true });
    mocks.restore.mockRejectedValue(failure);

    await expect(
      persistClimbingLogEntries(db, {
        userId,
        providerId,
        entries: [
          {
            externalId: "observed-a",
            attempts: [],
            activityObservation: { recordedAt: "2026-11-10T01:48:51.544Z" },
          },
        ],
      }),
    ).rejects.toBe(failure);
  });
});
