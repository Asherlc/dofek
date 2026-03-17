import { describe, expect, it } from "vitest";
import { VeloHeroProvider } from "./velohero.ts";

describe("VeloHeroProvider", () => {
  it("has correct id and name", () => {
    const provider = new VeloHeroProvider();
    expect(provider.id).toBe("velohero");
    expect(provider.name).toBe("VeloHero");
  });

  describe("validate", () => {
    it("always returns null (no env vars required)", () => {
      const provider = new VeloHeroProvider();
      expect(provider.validate()).toBeNull();
    });
  });

  describe("authSetup", () => {
    it("returns auth setup with SSO URLs", () => {
      const provider = new VeloHeroProvider();
      const setup = provider.authSetup();
      expect(setup.oauthConfig.authorizeUrl).toBe("https://app.velohero.com/sso");
      expect(setup.oauthConfig.tokenUrl).toBe("https://app.velohero.com/sso");
      expect(setup.oauthConfig.clientId).toBe("");
      expect(setup.oauthConfig.clientSecret).toBe("");
      expect(setup.oauthConfig.redirectUri).toBe("");
      expect(setup.oauthConfig.scopes).toEqual([]);
    });

    it("has automatedLogin function", () => {
      const provider = new VeloHeroProvider();
      const setup = provider.authSetup();
      expect(setup.automatedLogin).toBeDefined();
    });

    it("exchangeCode throws error", async () => {
      const provider = new VeloHeroProvider();
      const setup = provider.authSetup();
      await expect(setup.exchangeCode("some-code")).rejects.toThrow(
        "VeloHero uses automated login, not OAuth code exchange",
      );
    });
  });
});
