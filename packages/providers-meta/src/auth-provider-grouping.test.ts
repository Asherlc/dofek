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

  it("does not show an identity section when every identity provider is excluded", () => {
    expect(
      groupConfiguredAuthProviders({ identity: ["apple"], data: ["strava"] }, ["apple"]),
    ).toMatchObject({
      identityProviders: [],
      showIdentityProviders: false,
      showDataProviders: true,
      showOAuthProviders: true,
    });
  });

  it("does not show a data section when no data providers are configured", () => {
    expect(groupConfiguredAuthProviders({ identity: ["google"], data: [] })).toMatchObject({
      identityProviders: ["google"],
      dataProviders: [],
      showIdentityProviders: true,
      showDataProviders: false,
      showOAuthProviders: true,
    });
  });

  it("hides OAuth sections when no providers remain", () => {
    expect(groupConfiguredAuthProviders({ identity: [], data: [] })).toEqual({
      identityProviders: [],
      dataProviders: [],
      showIdentityProviders: false,
      showDataProviders: false,
      showOAuthProviders: false,
    });
  });
});
