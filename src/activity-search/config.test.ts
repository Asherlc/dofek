import { describe, expect, it } from "vitest";
import { createActivitySearchIndexFromEnv } from "./config.ts";

describe("activity search configuration", () => {
  it("requires each process to have its own credential when enabled", () => {
    expect(() =>
      createActivitySearchIndexFromEnv("ACTIVITY_SEARCH_WRITE_URL", {
        ACTIVITY_SEARCH_ENABLED: "true",
        ACTIVITY_SEARCH_READ_URL: "https://reader:password@search.example.test",
      }),
    ).toThrow("ACTIVITY_SEARCH_WRITE_URL is required when activity search is enabled.");
  });

  it("allows deployments without a search index to browse normally", () => {
    expect(createActivitySearchIndexFromEnv("ACTIVITY_SEARCH_READ_URL", {})).toBeUndefined();
  });
});
