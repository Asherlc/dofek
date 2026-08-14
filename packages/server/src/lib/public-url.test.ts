import { afterEach, describe, expect, it } from "vitest";
import { getPublicUrlBase, getPublicUrlOrigin, normalizePublicUrl } from "./public-url.ts";

const originalPublicUrl = process.env.PUBLIC_URL;

describe("public URL helpers", () => {
  afterEach(() => {
    if (originalPublicUrl === undefined) {
      delete process.env.PUBLIC_URL;
    } else {
      process.env.PUBLIC_URL = originalPublicUrl;
    }
  });

  it("normalizes a public URL by trimming whitespace and trailing slashes", () => {
    expect(normalizePublicUrl(" https://app.example.test/// ")).toBe("https://app.example.test");
  });

  it("accepts HTTP public URLs", () => {
    expect(normalizePublicUrl("http://app.example.test")).toBe("http://app.example.test");
  });

  it("fails fast when the public URL is missing or blank", () => {
    expect(() => normalizePublicUrl(undefined)).toThrow(
      "PUBLIC_URL environment variable is required",
    );
    expect(() => normalizePublicUrl("   ")).toThrow("PUBLIC_URL environment variable is required");
  });

  it("fails fast when the public URL is invalid", () => {
    expect(() => normalizePublicUrl("not a url")).toThrow(
      "PUBLIC_URL environment variable must be a valid URL",
    );
  });

  it("fails fast when the public URL does not use HTTP", () => {
    expect(() => normalizePublicUrl("file:///tmp/dofek")).toThrow(
      "PUBLIC_URL environment variable must use http or https",
    );
  });

  it("reads the normalized base URL from the environment", () => {
    process.env.PUBLIC_URL = " https://app.example.test/path/// ";

    expect(getPublicUrlBase()).toBe("https://app.example.test/path");
  });

  it("reads only the public origin from the environment", () => {
    process.env.PUBLIC_URL = " https://app.example.test/path/// ";

    expect(getPublicUrlOrigin()).toBe("https://app.example.test");
  });
});
