import { describe, expect, it, vi } from "vitest";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { createMockDatabase } from "./test-helpers.ts";

const mocks = vi.hoisted(() => ({
  activities: vi.fn(async () => [
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
