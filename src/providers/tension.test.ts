import { describe, expect, it } from "vitest";
import { TensionProvider } from "./tension.ts";

describe("TensionProvider", () => {
  it("connects the user's own account on the correct upstream host", async () => {
    const provider = new TensionProvider(async (input) => {
      expect(String(input)).toBe("https://tensionboardapp2.com/sessions");
      return Response.json({ session: { user_id: 42, token: "account-session" } });
    });
    expect(provider.id).toBe("tension");
    expect(provider.name).toBe("Tension Board");
    expect(provider.validate()).toBeNull();
    const setup = provider.authSetup();
    expect(setup.apiBaseUrl).toBe("https://tensionboardapp2.com");
    expect(setup.automatedLogin).toBeTypeOf("function");
    expect(await setup.automatedLogin?.("climber", "password")).toMatchObject({
      accessToken: "account-session",
    });
  });

  it("reports rejected account credentials without exposing upstream response bodies", async () => {
    const provider = new TensionProvider(
      async () => new Response("sensitive upstream detail", { status: 422 }),
    );
    await expect(provider.authSetup().automatedLogin?.("climber", "password")).rejects.toThrow(
      /^Sign in failed$/,
    );
  });
});
