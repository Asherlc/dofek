import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureProvidersRegistered } from "../jobs/provider-registration.ts";
import { getAllProviders } from "./index.ts";
import { checkPerUserAuthCompliance } from "./provider-auth-policy.ts";

/** OAuth app credentials stubbed so authSetup() can be exercised in policy tests. */
const OAUTH_APP_ENV_VARS = [
  "STRAVA_CLIENT_ID",
  "STRAVA_CLIENT_SECRET",
  "WITHINGS_CLIENT_ID",
  "WITHINGS_CLIENT_SECRET",
  "WAHOO_CLIENT_ID",
  "WAHOO_CLIENT_SECRET",
  "POLAR_CLIENT_ID",
  "POLAR_CLIENT_SECRET",
  "FITBIT_CLIENT_ID",
  "FITBIT_CLIENT_SECRET",
  "OURA_CLIENT_ID",
  "OURA_CLIENT_SECRET",
  "FATSECRET_CONSUMER_KEY",
  "FATSECRET_CONSUMER_SECRET",
  "BODYSPEC_CLIENT_ID",
  "BODYSPEC_CLIENT_SECRET",
  "WGER_CLIENT_ID",
  "WGER_CLIENT_SECRET",
  "DECATHLON_CLIENT_ID",
  "DECATHLON_CLIENT_SECRET",
  "COROS_CLIENT_ID",
  "COROS_CLIENT_SECRET",
  "CONCEPT2_CLIENT_ID",
  "CONCEPT2_CLIENT_SECRET",
  "SUUNTO_CLIENT_ID",
  "SUUNTO_CLIENT_SECRET",
  "KOMOOT_CLIENT_ID",
  "KOMOOT_CLIENT_SECRET",
  "MAPMYFITNESS_CLIENT_ID",
  "MAPMYFITNESS_CLIENT_SECRET",
  "RWGPS_CLIENT_ID",
  "RWGPS_CLIENT_SECRET",
  "CYCLING_ANALYTICS_CLIENT_ID",
  "CYCLING_ANALYTICS_CLIENT_SECRET",
  "SUUNTO_SUBSCRIPTION_KEY",
] as const;

describe("registered provider per-user auth policy", () => {
  beforeAll(async () => {
    for (const key of OAUTH_APP_ENV_VARS) {
      vi.stubEnv(key, "test");
    }
    vi.stubEnv("OAUTH_REDIRECT_URI", "https://example.com/callback");
    await ensureProvidersRegistered();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const key of OAUTH_APP_ENV_VARS) {
      vi.stubEnv(key, "test");
    }
    vi.stubEnv("OAUTH_REDIRECT_URI", "https://example.com/callback");
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("every registered sync provider satisfies the per-user connect policy", () => {
    const violations = getAllProviders()
      .map((provider) => checkPerUserAuthCompliance(provider))
      .filter((result): result is Extract<typeof result, { ok: false }> => !result.ok);

    expect(violations, formatViolations(violations)).toEqual([]);
  });

  it("requires per-user connect for amazfit-zepp", () => {
    const provider = getAllProviders().find((entry) => entry.id === "amazfit-zepp");
    expect(provider).toBeDefined();
    if (!provider) return;
    expect(checkPerUserAuthCompliance(provider)).toEqual({ ok: true });
  });
});

function formatViolations(violations: Array<{ providerId: string; reason: string }>): string {
  if (violations.length === 0) return "";
  return violations.map((violation) => `${violation.providerId}: ${violation.reason}`).join("\n");
}
