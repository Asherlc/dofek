import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
  init: mocks.init,
}));

import { initProductionSentry } from "./sentry.ts";

describe("initProductionSentry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not initialize without a DSN", () => {
    vi.stubEnv("DEPLOY_ENVIRONMENT", "production");

    initProductionSentry(undefined);

    expect(mocks.init).not.toHaveBeenCalled();
  });

  it("does not initialize outside production", () => {
    vi.stubEnv("DEPLOY_ENVIRONMENT", "local");

    initProductionSentry("https://key@sentry.example/456");

    expect(mocks.init).not.toHaveBeenCalled();
  });

  it.each([
    "prod",
    "production",
  ])("initializes the %s deployment with the production Sentry environment", (deploymentEnvironment) => {
    vi.stubEnv("DEPLOY_ENVIRONMENT", deploymentEnvironment);

    initProductionSentry("https://key@sentry.example/456");

    expect(mocks.init).toHaveBeenCalledWith({
      dsn: "https://key@sentry.example/456",
      environment: "production",
      skipOpenTelemetrySetup: true,
    });
  });
});
