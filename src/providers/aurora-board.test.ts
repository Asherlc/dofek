import { describe, expect, it } from "vitest";
import { AuroraBoardProvider } from "./aurora-board.ts";

describe("AuroraBoardProvider", () => {
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
      /reconnect/i,
    );
  });
});
