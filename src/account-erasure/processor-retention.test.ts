import { describe, expect, it } from "vitest";
import { processorRetentionConfigFromEnv } from "./processor-retention.ts";

describe("processorRetentionConfigFromEnv", () => {
  it("loads the required processor retention credentials", () => {
    expect(
      processorRetentionConfigFromEnv({
        AXIOM_API_TOKEN: "axiom-key",
        SENTRY_AUTH_TOKEN: "sentry-key",
        SENTRY_ORG: "east-bay-software",
      }),
    ).toEqual({
      axiomApiToken: "axiom-key",
      axiomDataset: "dofek-logs",
      sentryApiHost: "https://us.sentry.io",
      sentryAuthToken: "sentry-key",
      sentryOrg: "east-bay-software",
    });
  });

  it("rejects whitespace-only credentials before worker startup", () => {
    expect(() =>
      processorRetentionConfigFromEnv({
        AXIOM_API_TOKEN: "axiom-key",
        SENTRY_AUTH_TOKEN: " ",
        SENTRY_ORG: "east-bay-software",
      }),
    ).toThrow("SENTRY_AUTH_TOKEN is required for account erasure");
  });

  it("trims credentials before they are used in outbound requests", () => {
    expect(
      processorRetentionConfigFromEnv({
        AXIOM_API_TOKEN: " axiom-key ",
        AXIOM_LOG_DATASET: " dofek-logs ",
        SENTRY_AUTH_TOKEN: " sentry-key ",
        SENTRY_ORG: " east-bay-software ",
      }),
    ).toMatchObject({
      axiomApiToken: "axiom-key",
      axiomDataset: "dofek-logs",
      sentryAuthToken: "sentry-key",
      sentryOrg: "east-bay-software",
    });
  });
});
