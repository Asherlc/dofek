import { describe, expect, it } from "vitest";
import { KAYA_PROVIDER_ID, KayaProvider } from "./provider.ts";

describe("KayaProvider", () => {
  it("is always available as a file-import provider", () => {
    const provider = new KayaProvider();

    expect(provider.id).toBe(KAYA_PROVIDER_ID);
    expect(provider.name).toBe("Kaya");
    expect(provider.importOnly).toBe(true);
    expect(provider.validate()).toBeNull();
  });
});
