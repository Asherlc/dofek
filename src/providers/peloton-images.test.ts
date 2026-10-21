import { expect, it, vi } from "vitest";
import { resolveOAuthTokens } from "../auth/resolve-tokens.ts";
import { PelotonProvider } from "./peloton.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { createMockDatabase } from "./test-helpers.ts";

vi.mock("../auth/resolve-tokens.ts", () => ({ resolveOAuthTokens: vi.fn() }));
it.each([119999, 120000, 120001])(
  "refreshes media credentials at the request safety boundary (%i ms)",
  async (remaining) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01"));
    const token = {
      accessToken: "old",
      refreshToken: null,
      expiresAt: new Date(Date.now() + remaining),
      scopes: null,
    };
    vi.mocked(resolveOAuthTokens)
      .mockReset()
      .mockResolvedValueOnce(token)
      .mockResolvedValueOnce({
        ...token,
        accessToken: "fresh",
        expiresAt: new Date(Date.now() + 3600000),
      });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: "ride",
        status: "COMPLETE",
        fitness_discipline: "cycling",
        created_at: 1,
        start_time: 1,
        end_time: 2,
        is_total_work_personal_record: false,
        ride: { id: "class", title: "Class", duration: 1, image_url: "https://cdn.test/art.jpg" },
      }),
    );
    const { db } = createMockDatabase();
    try {
      const result = await new PelotonProvider(fetchFn).discoverActivityImages(
        new SyncRun({ db, userId: "owner", window: SyncWindow.fromSince({ since: new Date(0) }) }),
        "ride",
      );
      expect(resolveOAuthTokens).toHaveBeenCalledTimes(remaining <= 120000 ? 2 : 1);
      expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
        remaining <= 120000 ? "Bearer fresh" : "Bearer old",
      );
      expect(result.images[0]?.variants[0]?.url).toBe("https://cdn.test/art.jpg");
    } finally {
      vi.useRealTimers();
    }
  },
);
