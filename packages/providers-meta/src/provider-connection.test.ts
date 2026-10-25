import { describe, expect, it } from "vitest";
import { isCloudPushProvider } from "./provider-connection.ts";

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
