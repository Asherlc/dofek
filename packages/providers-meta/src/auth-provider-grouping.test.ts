import { describe, expect, it } from "vitest";
import { groupConfiguredAuthProviders } from "./auth-provider-grouping.ts";

describe("groupConfiguredAuthProviders", () => {
  it("keeps identity and data providers separate and excludes native identity flows", () => {
    expect(
      groupConfiguredAuthProviders({ identity: ["google", "apple"], data: ["strava", "wahoo"] }, [
        "apple",
      ]),
    ).toEqual({
      identityProviders: ["google"],
      dataProviders: ["strava", "wahoo"],
      showIdentityProviders: true,
      showDataProviders: true,
      showOAuthProviders: true,
    });
  });
});
