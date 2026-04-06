import { describe, expect, it } from "vitest";
import { redirectSystemPath } from "./+native-intent";

describe("redirectSystemPath", () => {
  it("routes shared files to providers import flow", () => {
    const result = redirectSystemPath({
      path: "file:///tmp/Strong%20Export.csv",
      initial: true,
    });
    expect(result).toBe("/providers?sharedFile=file%3A%2F%2F%2Ftmp%2FStrong%2520Export.csv");
  });

  it("keeps non-file paths unchanged", () => {
    const result = redirectSystemPath({
      path: "/providers",
      initial: false,
    });
    expect(result).toBe("/providers");
  });

  it("routes preview deep link to preview screen with PR number", () => {
    const result = redirectSystemPath({
      path: "/preview/pr-42",
      initial: false,
    });
    expect(result).toBe("/preview?pr=42");
  });

  it("routes preview deep link with just a number", () => {
    const result = redirectSystemPath({
      path: "/preview/pr-123",
      initial: true,
    });
    expect(result).toBe("/preview?pr=123");
  });

  it("keeps preview path without PR number unchanged", () => {
    const result = redirectSystemPath({
      path: "/preview",
      initial: false,
    });
    expect(result).toBe("/preview");
  });
});
