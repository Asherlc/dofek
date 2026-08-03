import type { ErrorEvent, NodeOptions } from "@sentry/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  init: vi.fn<(options: NodeOptions) => void>(),
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
      beforeSend: expect.any(Function),
      dsn: "https://key@sentry.example/456",
      environment: "production",
      release: "0123456789abcdef",
      skipOpenTelemetrySetup: true,
    });
  });

  it("drops an expected account-erasure fence before its database cause reaches Sentry", async () => {
    vi.stubEnv("DEPLOY_ENVIRONMENT", "production");
    const initProductionSentry = await loadInitProductionSentry();
    initProductionSentry("https://key@sentry.example/456");
    const beforeSend = mocks.init.mock.calls[0]?.[0].beforeSend;
    if (!beforeSend) throw new Error("Sentry beforeSend was not configured");
    const userId = "10000000-0000-4000-8000-000000001994";
    const databaseCause = Object.assign(new Error(`Account erasure is active for user ${userId}`), {
      code: "55000",
    });
    const fence = new Error("Account deletion is active for this user.", {
      cause: databaseCause,
    });
    fence.name = "AccountErasureUserFencedError";

    expect(
      beforeSend(
        { event_id: "fenced-event", message: databaseCause.message, type: undefined },
        { originalException: fence },
      ),
    ).toBeNull();
  });

  it("drops a raw account-erasure database fence before its user ID reaches Sentry", async () => {
    vi.stubEnv("DEPLOY_ENVIRONMENT", "production");
    const initProductionSentry = await loadInitProductionSentry();
    initProductionSentry("https://key@sentry.example/456");
    const beforeSend = mocks.init.mock.calls[0]?.[0].beforeSend;
    if (!beforeSend) throw new Error("Sentry beforeSend was not configured");
    const databaseFence = Object.assign(
      new Error("Account erasure is active for user 10000000-0000-4000-8000-000000001994"),
      { code: "55000" },
    );

    expect(
      beforeSend(
        { event_id: "database-fence", message: databaseFence.message, type: undefined },
        { originalException: databaseFence },
      ),
    ).toBeNull();
  });

  it("preserves unexpected errors", async () => {
    vi.stubEnv("DEPLOY_ENVIRONMENT", "production");
    const initProductionSentry = await loadInitProductionSentry();
    initProductionSentry("https://key@sentry.example/456");
    const beforeSend = mocks.init.mock.calls[0]?.[0].beforeSend;
    if (!beforeSend) throw new Error("Sentry beforeSend was not configured");
    const event = {
      event_id: "unexpected-event",
      message: "database unavailable",
      type: undefined,
    } satisfies ErrorEvent;

    expect(beforeSend(event, { originalException: new Error("database unavailable") })).toBe(event);
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
