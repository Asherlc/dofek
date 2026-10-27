import { describe, expect, it } from "vitest";
import { getTokenUserId, runWithTokenUser } from "../db/token-user-context.ts";
import {
  getProviderTokenDiagnostic,
  setProviderTokenDiagnostic,
} from "./provider-token-diagnostic-context.ts";

describe("provider token diagnostic context", () => {
  it("isolates credentials between concurrent users and providers", async () => {
    const first = { expiresAt: "2026-10-08T20:00:00Z", hasRefreshToken: true };
    const second = { expiresAt: "2026-10-08T21:00:00Z", hasRefreshToken: false };
    await Promise.all([
      runWithTokenUser("first", async () => {
        setProviderTokenDiagnostic("strava", "first", first);
        await Promise.resolve();
        expect(getTokenUserId()).toBe("first");
        expect(getProviderTokenDiagnostic("strava", "first")).toEqual(first);
        expect(getProviderTokenDiagnostic("strava", "second")).toBeUndefined();
        expect(getProviderTokenDiagnostic("wahoo", "first")).toBeUndefined();
      }),
      runWithTokenUser("second", async () => {
        setProviderTokenDiagnostic("strava", "second", second);
        await Promise.resolve();
        expect(getProviderTokenDiagnostic("strava", "second")).toEqual(second);
      }),
    ]);
    expect(getProviderTokenDiagnostic("strava", "first")).toBeUndefined();
  });

  it("updates refreshed metadata and clears deleted credentials", async () => {
    await runWithTokenUser("user", async () => {
      setProviderTokenDiagnostic("strava", "user", {
        expiresAt: "2026-10-08T20:00:00Z",
        hasRefreshToken: true,
      });
      setProviderTokenDiagnostic("strava", "other", {
        expiresAt: "2026-10-08T21:00:00Z",
        hasRefreshToken: false,
      });
      expect(getProviderTokenDiagnostic("strava", "user")?.hasRefreshToken).toBe(true);
      setProviderTokenDiagnostic("strava", "user", {
        expiresAt: "2026-10-08T22:00:00Z",
        hasRefreshToken: true,
      });
      expect(getProviderTokenDiagnostic("strava", "user")?.expiresAt).toBe("2026-10-08T22:00:00Z");
      setProviderTokenDiagnostic("strava", "user", undefined);
      expect(getProviderTokenDiagnostic("strava", "user")).toBeUndefined();
    });
  });
});
