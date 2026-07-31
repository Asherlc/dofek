import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posthogMocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  register: vi.fn(),
  shutdown: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("posthog-node", () => ({
  PostHog: vi.fn().mockImplementation(() => posthogMocks),
}));

vi.mock("@sentry/node", () => ({
  captureException: vi.fn().mockReturnValue("sentry-event-id"),
}));

describe("captureException dual reporting", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    delete process.env.DEPLOY_ENVIRONMENT;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports to Sentry and PostHog in production", async () => {
    vi.stubEnv("DEPLOY_ENVIRONMENT", "production");
    const { initProductionPostHog } = await import("./posthog.ts");
    const { captureException } = await import("./error-reporting.ts");
    const { captureException: sentryCaptureException } = await import("@sentry/node");

    initProductionPostHog();
    const error = new Error("dual report");
    const eventId = captureException(error, { tags: { source: "test" } });

    expect(eventId).toBe("sentry-event-id");
    expect(sentryCaptureException).toHaveBeenCalledWith(error, { tags: { source: "test" } });
    expect(posthogMocks.captureException).toHaveBeenCalledWith(
      error,
      "dofek-server",
      expect.objectContaining({ tag_source: "test" }),
    );
  });

  it("only reports to Sentry when PostHog is not initialized", async () => {
    const { captureException } = await import("./error-reporting.ts");
    const { captureException: sentryCaptureException } = await import("@sentry/node");

    const error = new Error("sentry only");
    captureException(error);

    expect(sentryCaptureException).toHaveBeenCalledWith(error);
    expect(posthogMocks.captureException).not.toHaveBeenCalled();
  });

  it("flattens capture context fields for PostHog", async () => {
    vi.stubEnv("DEPLOY_ENVIRONMENT", "production");
    const { initProductionPostHog } = await import("./posthog.ts");
    const { captureException } = await import("./error-reporting.ts");

    initProductionPostHog();
    const error = new Error("rich context");
    captureException(error, {
      tags: { source: "test", ignored: 42 },
      extra: { userId: "user-1" },
      contexts: { runtime: { name: "node" } },
      fingerprint: ["sync", "failure"],
      level: "warning",
    });

    expect(posthogMocks.captureException).toHaveBeenCalledWith(
      error,
      "dofek-server",
      expect.objectContaining({
        tag_source: "test",
        userId: "user-1",
        contexts: { runtime: { name: "node" } },
        fingerprint: ["sync", "failure"],
        level: "warning",
      }),
    );
    expect(posthogMocks.captureException).not.toHaveBeenCalledWith(
      error,
      "dofek-server",
      expect.objectContaining({ tag_ignored: 42 }),
    );
  });

  it("maps string and function capture contexts for PostHog", async () => {
    vi.stubEnv("DEPLOY_ENVIRONMENT", "production");
    const { initProductionPostHog } = await import("./posthog.ts");
    const { captureException } = await import("./error-reporting.ts");

    initProductionPostHog();
    const error = new Error("context variants");

    captureException(error, "hint");
    expect(posthogMocks.captureException).toHaveBeenLastCalledWith(error, "dofek-server", {
      captureContext: "string",
    });

    captureException(error, () => undefined);
    expect(posthogMocks.captureException).toHaveBeenLastCalledWith(error, "dofek-server", {
      captureContext: "function",
    });
  });

  it("ignores non-record capture contexts for PostHog", async () => {
    vi.stubEnv("DEPLOY_ENVIRONMENT", "production");
    const { initProductionPostHog } = await import("./posthog.ts");
    const { captureException } = await import("./error-reporting.ts");

    initProductionPostHog();
    const error = new Error("invalid context");

    captureException(error, null as unknown as undefined);
    expect(posthogMocks.captureException).toHaveBeenCalledWith(error, "dofek-server", {});
  });

  it("skips non-string tag values and non-record context sections", async () => {
    vi.stubEnv("DEPLOY_ENVIRONMENT", "production");
    const { initProductionPostHog } = await import("./posthog.ts");
    const { captureException } = await import("./error-reporting.ts");

    initProductionPostHog();
    const error = new Error("partial context");

    captureException(error, {
      tags: ["ignored"] as unknown as Record<string, string>,
      extra: "ignored" as unknown as Record<string, unknown>,
      contexts: "ignored" as unknown as Record<string, unknown>,
      fingerprint: "ignored" as unknown as string[],
      level: 1 as unknown as "warning",
    });

    expect(posthogMocks.captureException).toHaveBeenCalledWith(error, "dofek-server", {});
  });
});

describe("initProductionPostHog", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    delete process.env.DEPLOY_ENVIRONMENT;
  });

  it("does not initialize outside production deployments", async () => {
    vi.stubEnv("DEPLOY_ENVIRONMENT", "local");
    const { initProductionPostHog, getPostHogClient } = await import("./posthog.ts");

    initProductionPostHog();
    expect(getPostHogClient()).toBeUndefined();
  });

  it("initializes once in production with exception autocapture", async () => {
    vi.stubEnv("DEPLOY_ENVIRONMENT", "production");
    const { PostHog } = await import("posthog-node");
    const { initProductionPostHog, getPostHogClient } = await import("./posthog.ts");

    initProductionPostHog("dofek-test");
    initProductionPostHog("dofek-test");

    expect(PostHog).toHaveBeenCalledOnce();
    expect(PostHog).toHaveBeenCalledWith(
      "phc_GsvyihTLSXrWGKYYGz84m44nuT59kYEwEXNnI0JICtg",
      expect.objectContaining({
        host: "https://us.i.posthog.com",
        enableExceptionAutocapture: true,
      }),
    );
    expect(posthogMocks.register).toHaveBeenCalledWith({ service: "dofek-test" });
    expect(getPostHogClient()).toBeDefined();
  });
});
