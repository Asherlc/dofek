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
type SentrySpan = Parameters<NonNullable<NodeOptions["beforeSendSpan"]>>[0];
type SentryTransaction = Parameters<NonNullable<NodeOptions["beforeSendTransaction"]>>[0];

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

  it.each(["prod", "production"])(
    "initializes the %s deployment with the production Sentry environment",
    async (deploymentEnvironment) => {
      vi.stubEnv("DEPLOY_ENVIRONMENT", deploymentEnvironment);
      vi.stubEnv("SENTRY_RELEASE", "0123456789abcdef");
      const initProductionSentry = await loadInitProductionSentry();

      initProductionSentry("https://key@sentry.example/456");

      expect(mocks.initProductionPostHog).toHaveBeenCalledWith("dofek-worker");
      expect(mocks.init).toHaveBeenCalledWith(
        expect.objectContaining({
          beforeSend: expect.any(Function),
          dsn: "https://key@sentry.example/456",
          environment: "production",
          release: "0123456789abcdef",
          skipOpenTelemetrySetup: true,
        }),
      );
    },
  );

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

  it("does not classify malformed database-like errors as account-erasure fences", async () => {
    vi.stubEnv("DEPLOY_ENVIRONMENT", "production");
    const initProductionSentry = await loadInitProductionSentry();
    initProductionSentry("https://key@sentry.example/456");
    const beforeSend = mocks.init.mock.calls[0]?.[0].beforeSend;
    if (!beforeSend) throw new Error("Sentry beforeSend was not configured");

    const event = { event_id: "unexpected-fence-shape", type: undefined } satisfies ErrorEvent;
    expect(
      beforeSend(event, {
        originalException: Object.assign(new Error("Account erasure is active for user"), {
          code: "55001",
          name: 42,
        }),
      }),
    ).toBe(event);
    expect(
      beforeSend(event, {
        originalException: Object.assign(new Error("database unavailable"), {
          code: "55000",
        }),
      }),
    ).toBe(event);
  });

  it("stops traversing a cyclic error cause chain", async () => {
    vi.stubEnv("DEPLOY_ENVIRONMENT", "production");
    const initProductionSentry = await loadInitProductionSentry();
    initProductionSentry("https://key@sentry.example/456");
    const beforeSend = mocks.init.mock.calls[0]?.[0].beforeSend;
    if (!beforeSend) throw new Error("Sentry beforeSend was not configured");

    const first = new Error("first");
    const second = new Error("second");
    Object.defineProperty(first, "cause", { value: second });
    Object.defineProperty(second, "cause", { value: first });
    const event = { event_id: "cyclic-cause", type: undefined } satisfies ErrorEvent;

    expect(beforeSend(event, { originalException: first })).toBe(event);
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

  it("redacts receiver credentials from error requests and HTTP breadcrumbs", async () => {
    vi.stubEnv("DEPLOY_ENVIRONMENT", "production");
    (await loadInitProductionSentry())("https://key@sentry.example/456");
    const beforeSend = mocks.init.mock.calls[0]?.[0].beforeSend;
    if (!beforeSend) throw new Error("Sentry beforeSend was not configured");
    const event: ErrorEvent = {
      type: undefined,
      request: {
        url: "https://dofek.example/api/webhooks/garmin?token=synthetic-event-secret&feed=dailies",
        query_string: { token: "synthetic-event-secret", feed: "dailies" },
      },
      breadcrumbs: [
        {
          category: "http",
          data: {
            url: "https://apis.garmin.com/file?token=synthetic-breadcrumb-secret&feed=fit",
            "http.query": "token=synthetic-breadcrumb-secret&feed=fit",
          },
        },
      ],
    };
    const result = await beforeSend(event, {});
    expect(JSON.stringify(result)).not.toContain("synthetic-event-secret");
    expect(JSON.stringify(result)).not.toContain("synthetic-breadcrumb-secret");
    expect(result?.request?.url).toContain("feed=dailies");
    expect(result?.request?.query_string).toEqual({ token: "REDACTED", feed: "dailies" });
  });

  it("redacts full URLs, legacy attributes and descriptions on Sentry spans", async () => {
    vi.stubEnv("DEPLOY_ENVIRONMENT", "production");
    (await loadInitProductionSentry())("https://key@sentry.example/456");
    const beforeSendSpan = mocks.init.mock.calls[0]?.[0].beforeSendSpan;
    const span: SentrySpan = {
      trace_id: "trace",
      span_id: "span",
      start_timestamp: 1,
      description: "GET https://apis.garmin.com/file?token=synthetic-span-secret&feed=fit",
      data: {
        "url.full": "https://apis.garmin.com/file?token=synthetic-span-secret&feed=fit",
        "http.url": "https://apis.garmin.com/file?token=synthetic-span-secret",
        "http.target": "/file?token=synthetic-span-secret",
        "url.query": "token=synthetic-span-secret&feed=fit",
        "http.query": "?token=synthetic-span-secret&feed=fit",
      },
    };
    const result = beforeSendSpan?.(span) ?? span;
    expect(JSON.stringify(result)).not.toContain("synthetic-span-secret");
    expect(result.data["url.full"]).toContain("feed=fit");
    expect(result.description).toContain("token=REDACTED");
  });

  it("redacts root transaction data and child spans before sending a transaction", async () => {
    vi.stubEnv("DEPLOY_ENVIRONMENT", "production");
    (await loadInitProductionSentry())("https://key@sentry.example/456");
    const beforeSendTransaction = mocks.init.mock.calls[0]?.[0].beforeSendTransaction;
    const event: SentryTransaction = {
      type: "transaction",
      transaction: "POST /api/webhooks/garmin?token=synthetic-transaction-secret",
      contexts: {
        trace: {
          span_id: "span",
          trace_id: "trace",
          data: { "url.query": "token=synthetic-transaction-secret&feed=dailies" },
        },
      },
      request: {
        query_string: [
          ["token", "synthetic-transaction-secret"],
          ["feed", "dailies"],
        ],
      },
      spans: [
        {
          trace_id: "trace",
          span_id: "span",
          start_timestamp: 1,
          data: {
            "http.url": "https://apis.garmin.com/file?token=synthetic-transaction-secret&feed=fit",
          },
        },
      ],
    };
    const result = (await beforeSendTransaction?.(event, {})) ?? event;
    expect(JSON.stringify(result)).not.toContain("synthetic-transaction-secret");
    expect(result.contexts?.trace?.data?.["url.query"]).toContain("feed=dailies");
  });
});
