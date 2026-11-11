import { describe, expect, it } from "vitest";
import { KilterProvider } from "./kilter.ts";

describe("KilterProvider", () => {
  it("connects the user's own account on the correct upstream host", async () => {
    const provider = new KilterProvider(async (input) => {
      expect(String(input)).toBe(
        "https://idp.kiltergrips.com/realms/kilter/protocol/openid-connect/token",
      );
      return Response.json({
        access_token: "account-access",
        refresh_token: "account-refresh",
        expires_in: 300,
      });
    });
    expect(provider.id).toBe("kilter");
    expect(provider.name).toBe("Kilter Board");
    expect(provider.validate()).toBeNull();
    const setup = provider.authSetup();
    expect(setup.apiBaseUrl).toBe("https://portal.kiltergrips.com");
    expect(setup.automatedLogin).toBeTypeOf("function");
    expect(await setup.automatedLogin?.("climber", "password")).toMatchObject({
      accessToken: "account-access",
    });
  });

  it("reports rejected account credentials without exposing upstream response bodies", async () => {
    const provider = new KilterProvider(
      async () => new Response("sensitive upstream detail", { status: 400 }),
    );
    await expect(provider.authSetup().automatedLogin?.("climber", "password")).rejects.toThrow(
      /reconnect/i,
    );
  });
});
