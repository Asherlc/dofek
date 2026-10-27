import { describe, expect, it } from "vitest";
import { isTheCragPublicProfileScope, THECRAG_PUBLIC_PROFILE_SCOPE } from "./identity.ts";

describe("theCrag saved public identity", () => {
  it("recognizes only the exact public-profile marker", () => {
    expect(THECRAG_PUBLIC_PROFILE_SCOPE).toBe("thecrag:public-profile");
    expect(isTheCragPublicProfileScope(THECRAG_PUBLIC_PROFILE_SCOPE)).toBe(true);
    for (const scopes of [
      null,
      undefined,
      "",
      "logbook:read",
      "public-profile",
      "thecrag:public-profile logbook:read",
    ])
      expect(isTheCragPublicProfileScope(scopes)).toBe(false);
  });
});
