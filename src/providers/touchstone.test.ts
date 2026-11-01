import { describe, expect, it } from "vitest";
import { TouchstoneProvider } from "./touchstone.ts";

describe("TouchstoneProvider", () => {
  it("connects the user's own account on the correct upstream host", async () => {
    const provider = new TouchstoneProvider(async (input) => {
      expect(String(input)).toBe("https://touchstoneboardapp.com/sessions");
      return Response.json({ session: { user_id: 42, token: "account-session" } });
    });
    expect(provider.id).toBe("touchstone");
    expect(provider.name).toBe("Touchstone Board");
    expect(provider.validate()).toBeNull();
    const setup = provider.authSetup();
    expect(setup.apiBaseUrl).toBe("https://touchstoneboardapp.com");
    expect(setup.automatedLogin).toBeTypeOf("function");
    expect(await setup.automatedLogin?.("climber", "password")).toMatchObject({
      accessToken: "account-session",
    });
  });

  it("reports rejected account credentials without exposing upstream response bodies", async () => {
    const provider = new TouchstoneProvider(
      async () => new Response("sensitive upstream detail", { status: 422 }),
    );
    await expect(provider.authSetup().automatedLogin?.("climber", "password")).rejects.toThrow(
      /^Sign in failed$/,
    );
  });
});
