import { describe, expect, it } from "vitest";
import { SyncRun } from "../sync-run.ts";
import { SyncWindow } from "../sync-window.ts";
import { createMockDatabase } from "../test-helpers.ts";
import { CrimpdProvider } from "./provider.ts";

describe("Crimpd account connection", () => {
  it("connects per-user credentials through the current login endpoint", async () => {
    const provider = new CrimpdProvider(async (input) => {
      expect(String(input)).toBe("https://api.crimpd.com/auth/jwt");
      return Response.json({
        success: true,
        user: { _id: "owner" },
        token: "access",
        refreshToken: "refresh",
        expiresIn: 3600,
        refreshExpiresIn: 7200,
      });
    });
    const setup = provider.authSetup();
    expect(setup.apiBaseUrl).toBe("https://api.crimpd.com");
    expect(await setup.automatedLogin?.("climber", "password")).toMatchObject({
      accessToken: "access",
      refreshToken: "refresh",
      providerAccountId: "owner",
    });
  });

  it("rejects a sync without an explicit owner", async () => {
    const { db } = createMockDatabase();
    const result = await new CrimpdProvider().sync(new SyncRun({ db, window: SyncWindow.full() }));
    expect(result).toMatchObject({
      recordsSynced: 0,
      errors: [expect.objectContaining({ message: "Crimpd sync requires a user context." })],
    });
  });

  it("tells an unconnected owner how to connect before requesting an export", async () => {
    const { db } = createMockDatabase();
    const provider = new CrimpdProvider(async () => {
      throw new Error("An unconnected account must not request data");
    });
    const result = await provider.sync(
      new SyncRun({ db, userId: "owner", window: SyncWindow.full() }),
    );
    expect(result).toMatchObject({
      recordsSynced: 0,
      errors: [
        expect.objectContaining({ message: expect.stringMatching(/Connect.*Data Sources/) }),
      ],
    });
  });
});
