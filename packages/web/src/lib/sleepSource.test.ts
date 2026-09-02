import { describe, expect, it } from "vitest";
import { formatProviderId, formatSleepProvenance } from "./sleepSource.ts";

describe("formatProviderId", () => {
  it("formats snake_case provider ids", () => {
    expect(formatProviderId("apple_health")).toBe("Apple Health");
    expect(formatProviderId("eight-sleep")).toBe("Eight Sleep");
  });
});

describe("formatSleepProvenance", () => {
  it("shows provider and device when source name differs", () => {
    expect(
      formatSleepProvenance({
        providerId: "apple_health",
        sourceName: "Apple Watch",
        sourceProviders: ["apple_health", "whoop"],
      }),
    ).toEqual({
      primary: "Apple Health · Apple Watch",
      alsoFrom: "WHOOP (Cloud)",
    });
  });

  it("omits duplicate source name and empty also-from list", () => {
    expect(
      formatSleepProvenance({
        provider_id: "whoop",
        source_name: "whoop",
        source_providers: ["whoop"],
      }),
    ).toEqual({
      primary: "WHOOP (Cloud)",
      alsoFrom: null,
    });
  });
});
