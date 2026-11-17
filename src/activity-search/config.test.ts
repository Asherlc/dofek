import { describe, expect, it } from "vitest";
import {
  createActivitySearchErasureIndexFromEnv,
  createActivitySearchIndexFromEnv,
} from "./config.ts";
import { ActivitySearchIndex } from "./opensearch.ts";

const fixtureUrl = "https://reader:password@search.example.test";

describe("activity search configuration", () => {
  it("requires each process to have its own credential when enabled", () => {
    expect(() =>
      createActivitySearchIndexFromEnv("ACTIVITY_SEARCH_WRITE_URL", {
        ACTIVITY_SEARCH_ENABLED: "true",
        ACTIVITY_SEARCH_READ_URL: fixtureUrl,
      }),
    ).toThrow("ACTIVITY_SEARCH_WRITE_URL is required when activity search is enabled.");
  });

  it("allows deployments without a search index to browse normally", () => {
    expect(createActivitySearchIndexFromEnv("ACTIVITY_SEARCH_READ_URL", {})).toBeUndefined();
  });

  it("builds the selected client only when publishing or reading is enabled", () => {
    const credentials = { ACTIVITY_SEARCH_READ_URL: fixtureUrl };
    expect(
      createActivitySearchIndexFromEnv("ACTIVITY_SEARCH_READ_URL", {
        ...credentials,
        ACTIVITY_SEARCH_ENABLED: "true",
      }),
    ).toBeInstanceOf(ActivitySearchIndex);
    expect(
      createActivitySearchIndexFromEnv("ACTIVITY_SEARCH_READ_URL", {
        ...credentials,
        ACTIVITY_SEARCH_ENABLED: "false",
      }),
    ).toBeUndefined();
  });

  it("rejects invalid enablement explicitly", () => {
    expect(() =>
      createActivitySearchIndexFromEnv("ACTIVITY_SEARCH_READ_URL", {
        ACTIVITY_SEARCH_ENABLED: "yes",
      }),
    ).toThrow("ACTIVITY_SEARCH_ENABLED must be true or false.");
  });

  it("keeps the erasure client available with search paused", () => {
    expect(
      createActivitySearchErasureIndexFromEnv({
        ACTIVITY_SEARCH_ENABLED: "false",
        ACTIVITY_SEARCH_ERASE_URL: fixtureUrl,
      }),
    ).toBeInstanceOf(ActivitySearchIndex);
    expect(createActivitySearchErasureIndexFromEnv({})).toBeUndefined();
  });

  it.each([
    { ACTIVITY_SEARCH_ENABLED: "true" },
    { ACTIVITY_SEARCH_ENABLED: "false", ACTIVITY_SEARCH_RETENTION_TOKEN: "fixture-token" },
  ])(
    "requires the erasure URL with active search or a retained retention credential",
    (environment) => {
      expect(() => createActivitySearchErasureIndexFromEnv(environment)).toThrow(
        "ACTIVITY_SEARCH_ERASE_URL is required for activity search erasure.",
      );
    },
  );
});
