import { describe, expect, it, vi } from "vitest";
import { ClimbingBoardAccount } from "../lib/climbing-board-account.ts";
import { AuroraBoardProvider } from "./aurora-board.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { createMockDatabase } from "./test-helpers.ts";

describe("AuroraBoardProvider", () => {
  it("passes the complete sync context to its account and returns the sync result", async () => {
    const { db } = createMockDatabase();
    const run = new SyncRun({
      db,
      window: SyncWindow.full(new Date("2026-09-01T00:00:00Z")),
      userId: "board-owner",
      signal: new AbortController().signal,
    });
    const result = { provider: "aurora-board", recordsSynced: 7, errors: [], duration: 25 };
    const sync = vi.spyOn(ClimbingBoardAccount.prototype, "sync").mockResolvedValueOnce(result);
    try {
      expect(await new AuroraBoardProvider().sync(run)).toBe(result);
      expect(sync).toHaveBeenCalledExactlyOnceWith(run);
    } finally {
      sync.mockRestore();
    }
  });

  it("connects the user's own account on the correct upstream host", async () => {
    const provider = new AuroraBoardProvider(async (input) => {
      expect(String(input)).toBe("https://auroraboardapp.com/sessions");
      return Response.json({ session: { user_id: 42, token: "account-session" } });
    });
    expect(provider.id).toBe("aurora-board");
    expect(provider.name).toBe("Aurora Board");
    expect(provider.validate()).toBeNull();
    const setup = provider.authSetup();
    expect(setup.apiBaseUrl).toBe("https://auroraboardapp.com");
    expect(setup.automatedLogin).toBeTypeOf("function");
    expect(await setup.automatedLogin?.("climber", "password")).toMatchObject({
      accessToken: "account-session",
    });
  });

  it("reports rejected account credentials without exposing upstream response bodies", async () => {
    const provider = new AuroraBoardProvider(
      async () => new Response("sensitive upstream detail", { status: 422 }),
    );
    await expect(provider.authSetup().automatedLogin?.("climber", "password")).rejects.toThrow(
      /^Sign in failed$/,
    );
  });
});
