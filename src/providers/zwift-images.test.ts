import { describe, expect, it, vi } from "vitest";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { createMockDatabase } from "./test-helpers.ts";

const mocks = vi.hoisted(() => ({
  activities: vi
    .fn<() => Promise<Array<{ id_str?: string; id?: number; primaryImageUrl?: string }>>>()
    .mockResolvedValue([
      { id_str: "ride", primaryImageUrl: "https://cdn.test/ride.png?signature=fresh" },
    ]),
}));
vi.mock("@dofek/zwift/client", () => ({
  ZWIFT_API_BASE: "https://zwift.test",
  ZwiftClient: class {
    getActivities = mocks.activities;
  },
}));
vi.mock("../db/tokens.ts", () => ({
  loadTokens: vi.fn(async () => ({
    accessToken: "token",
    refreshToken: null,
    expiresAt: new Date("2099-01-01"),
    scopes: "athleteId:123",
  })),
  saveTokens: vi.fn(),
  ensureProvider: vi.fn(),
}));

import { ZwiftProvider } from "./zwift.ts";

describe("Zwift image URL refresh", () => {
  it("bypasses archived URLs after a download authorization failure", async () => {
    const { db } = createMockDatabase({
      executeResult: [{ raw: { primaryImageUrl: "https://cdn.test/ride.png?signature=expired" } }],
    });
    const run = new SyncRun({
      db,
      window: SyncWindow.fromSince({ since: new Date(0) }),
      userId: "00000000-0000-4000-8000-000000000001",
    });
    const provider = new ZwiftProvider();
    const result = await provider.discoverActivityImages(run, "ride", { refresh: true });
    expect(result.images[0]?.variants[0]?.url).toContain("signature=fresh");
    expect(mocks.activities).toHaveBeenCalledOnce();
  });
});

it("uses archived primary media without requesting a provider page", async () => {
  const { db } = createMockDatabase({
    executeResult: [{ raw: { primaryImageUrl: "https://cdn.test/stored.jpg" } }],
  });
  mocks.activities.mockClear();
  const result = await new ZwiftProvider().discoverActivityImages(
    new SyncRun({ db, userId: "owner", window: SyncWindow.fromSince({ since: new Date(0) }) }),
    "ride",
  );
  expect(result.images[0]?.variants[0]?.url).toBe("https://cdn.test/stored.jpg");
  expect(mocks.activities).not.toHaveBeenCalled();
});
it("requires an owner before reading activity metadata", async () => {
  const { db, spies } = createMockDatabase();
  await expect(
    new ZwiftProvider().discoverActivityImages(
      new SyncRun({ db, window: SyncWindow.fromSince({ since: new Date(0) }) }),
      "ride",
    ),
  ).rejects.toThrow("owner");
  expect(spies.execute).not.toHaveBeenCalled();
});
it("walks full provider pages and matches numeric activity IDs", async () => {
  const { db } = createMockDatabase();
  mocks.activities
    .mockReset()
    .mockResolvedValueOnce(Array.from({ length: 20 }, (_, i) => ({ id: i })))
    .mockResolvedValueOnce([{ id: 42, primaryImageUrl: "https://cdn.test/42.jpg" }]);
  const result = await new ZwiftProvider().discoverActivityImages(
    new SyncRun({ db, userId: "owner", window: SyncWindow.fromSince({ since: new Date(0) }) }),
    "42",
  );
  expect(result.images[0]?.variants[0]?.url).toBe("https://cdn.test/42.jpg");
  expect(mocks.activities).toHaveBeenNthCalledWith(1, 0, 20);
  expect(mocks.activities).toHaveBeenNthCalledWith(2, 20, 20);
});
it("stops on a short page and reports missing historical summaries as partial", async () => {
  const { db } = createMockDatabase();
  mocks.activities.mockReset().mockResolvedValue([{ id: 1 }]);
  expect(
    await new ZwiftProvider().discoverActivityImages(
      new SyncRun({ db, userId: "owner", window: SyncWindow.fromSince({ since: new Date(0) }) }),
      "missing",
    ),
  ).toMatchObject({ coverage: "partial", reason: "zwift_summary_not_found", images: [] });
  expect(mocks.activities).toHaveBeenCalledOnce();
});
it("bounds a provider which always returns full unmatched pages", async () => {
  const { db } = createMockDatabase();
  mocks.activities.mockReset().mockResolvedValue(Array.from({ length: 20 }, (_, i) => ({ id: i })));
  expect(
    await new ZwiftProvider().discoverActivityImages(
      new SyncRun({ db, userId: "owner", window: SyncWindow.fromSince({ since: new Date(0) }) }),
      "missing",
    ),
  ).toMatchObject({ coverage: "partial", images: [] });
  expect(mocks.activities).toHaveBeenCalledTimes(100);
});

it("reuses historical summary pages across one run and continues from the previous offset", async () => {
  const { db } = createMockDatabase();
  const run = new SyncRun({
    db,
    userId: "owner",
    window: SyncWindow.fromSince({ since: new Date(0) }),
  });
  const provider = new ZwiftProvider();
  mocks.activities
    .mockReset()
    .mockResolvedValueOnce(
      Array.from({ length: 20 }, (_, id) => ({
        id,
        primaryImageUrl: `https://cdn.test/${id}.jpg`,
      })),
    )
    .mockResolvedValueOnce([{ id: 42, primaryImageUrl: "https://cdn.test/42.jpg" }]);
  await provider.discoverActivityImages(run, "0");
  expect((await provider.discoverActivityImages(run, "1")).images).toHaveLength(1);
  expect((await provider.discoverActivityImages(run, "42")).images).toHaveLength(1);
  await provider.discoverActivityImages(run, "missing");
  expect(mocks.activities).toHaveBeenCalledTimes(2);
  expect(mocks.activities).toHaveBeenNthCalledWith(2, 20, 20);
});
