import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  initProductionPostHog: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
  init: mocks.init,
}));

vi.mock("./posthog.ts", () => ({
  initProductionPostHog: mocks.initProductionPostHog,
}));

const originalDeployEnvironment = process.env.DEPLOY_ENVIRONMENT;
const originalSentryRelease = process.env.SENTRY_RELEASE;

async function loadInitProductionSentry() {
  return (await import("./sentry.ts")).initProductionSentry;
}

describe("initProductionSentry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    delete process.env.DEPLOY_ENVIRONMENT;
    delete process.env.SENTRY_RELEASE;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalDeployEnvironment === undefined) {
      delete process.env.DEPLOY_ENVIRONMENT;
    } else {
      process.env.DEPLOY_ENVIRONMENT = originalDeployEnvironment;
    }
    if (originalSentryRelease === undefined) {
      delete process.env.SENTRY_RELEASE;
    } else {
      process.env.SENTRY_RELEASE = originalSentryRelease;
    }
  });

  it("does not initialize without a DSN", async () => {
    vi.stubEnv("DEPLOY_ENVIRONMENT", "production");
    const initProductionSentry = await loadInitProductionSentry();

    initProductionSentry(undefined);

    expect(mocks.init).not.toHaveBeenCalled();
    expect(mocks.initProductionPostHog).not.toHaveBeenCalled();
  });

  it("does not initialize without a deployment environment", async () => {
    const initProductionSentry = await loadInitProductionSentry();

    initProductionSentry("https://key@sentry.example/456");

    expect(mocks.init).not.toHaveBeenCalled();
    expect(mocks.initProductionPostHog).not.toHaveBeenCalled();
  });

  it("does not initialize outside production", async () => {
    vi.stubEnv("DEPLOY_ENVIRONMENT", "local");
    const initProductionSentry = await loadInitProductionSentry();

    initProductionSentry("https://key@sentry.example/456");

    expect(mocks.init).not.toHaveBeenCalled();
    expect(mocks.initProductionPostHog).not.toHaveBeenCalled();
  });

  it.each([
    "prod",
    "production",
  ])("initializes the %s deployment with the production Sentry environment", async (deploymentEnvironment) => {
    vi.stubEnv("DEPLOY_ENVIRONMENT", deploymentEnvironment);
    vi.stubEnv("SENTRY_RELEASE", "0123456789abcdef");
    const initProductionSentry = await loadInitProductionSentry();

    initProductionSentry("https://key@sentry.example/456");

    expect(mocks.initProductionPostHog).toHaveBeenCalledWith("dofek-worker");
    expect(mocks.init).toHaveBeenCalledWith({
      dsn: "https://key@sentry.example/456",
      environment: "production",
      release: "0123456789abcdef",
      skipOpenTelemetrySetup: true,
    });
  });

  it("initializes Sentry only once", async () => {
    vi.stubEnv("DEPLOY_ENVIRONMENT", "production");
    const initProductionSentry = await loadInitProductionSentry();

    initProductionSentry("https://key@sentry.example/456");
    initProductionSentry("https://key@sentry.example/456");

    expect(mocks.init).toHaveBeenCalledOnce();
    expect(mocks.initProductionPostHog).toHaveBeenCalledOnce();
  });
});
