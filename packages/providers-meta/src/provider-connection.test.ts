import { describe, expect, it } from "vitest";
import {
  isCloudPushProvider,
  providerCredentialInput,
  providerCredentialSubmitHint,
} from "./provider-connection.ts";

describe("credential input presentation", () => {
  it("defaults unfamiliar providers to email", () => {
    expect(providerCredentialInput("unfamiliar-provider")).toMatchObject({
      identifier: "email",
      label: "Email",
      placeholder: "you@example.com",
    });
  });

  it.each([
    {
      username: "",
      password: "",
      loading: false,
      want: "Enter your username and password to continue.",
    },
    { username: " ", password: "secret", loading: false, want: "Enter your username to continue." },
    { username: "climber", password: "", loading: false, want: "Enter your password to continue." },
    { username: "climber", password: "secret", loading: false, want: null },
    { username: "", password: "", loading: true, want: null },
  ])("describes the missing username credentials: %j", ({ username, password, loading, want }) => {
    expect(providerCredentialSubmitHint(username, password, loading, "username")).toBe(want);
  });

  it("uses email wording by default for existing credential flows", () => {
    expect(providerCredentialSubmitHint("", "", false)).toBe(
      "Enter your email and password to continue.",
    );
  });
});

describe("isCloudPushProvider", () => {
  it.each([
    { pushOnly: true, authType: "oauth", expected: true },
    { pushOnly: true, authType: "token", expected: true },
    { pushOnly: true, authType: "credentials", expected: true },
    { pushOnly: true, authType: "public-profile", expected: true },
    { pushOnly: true, authType: "custom:whoop", expected: true },
    { pushOnly: false, authType: "oauth", expected: false },
    { pushOnly: true, authType: "none", expected: false },
    { pushOnly: true, authType: "push:mobile", expected: false },
    { pushOnly: true, authType: "file-import", expected: false },
  ])(
    "classifies pushOnly=$pushOnly and authType=$authType as cloud push=$expected",
    ({ pushOnly, authType, expected }) => {
      expect(isCloudPushProvider({ pushOnly, authType })).toBe(expected);
    },
  );
});
