import { describe, expect, it } from "vitest";
import { requestTimezoneSchema } from "./request-timezone.ts";

describe("requestTimezoneSchema", () => {
  it("accepts IANA timezones", () => {
    expect(requestTimezoneSchema.parse("America/Los_Angeles")).toBe("America/Los_Angeles");
  });

  it("defaults an absent timezone to UTC", () => {
    expect(requestTimezoneSchema.parse(undefined)).toBe("UTC");
  });

  it("rejects malformed timezones", () => {
    expect(() => requestTimezoneSchema.parse("Not/A_Timezone")).toThrow(
      "Invalid x-timezone header",
    );
  });
});
