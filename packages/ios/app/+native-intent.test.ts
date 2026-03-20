import { describe, expect, it } from "vitest";
import { redirectSystemPath } from "./+native-intent";

describe("redirectSystemPath", () => {
  it("routes shared files to providers import flow", () => {
    const result = redirectSystemPath({
      path: "file:///tmp/Strong%20Export.csv",
      initial: true,
    });
    expect(result).toBe(
      "/providers?sharedFile=file%3A%2F%2F%2Ftmp%2FStrong%2520Export.csv",
    );
  });

  it("keeps non-file paths unchanged", () => {
    const result = redirectSystemPath({
      path: "/providers",
      initial: false,
    });
    expect(result).toBe("/providers");
  });
});
