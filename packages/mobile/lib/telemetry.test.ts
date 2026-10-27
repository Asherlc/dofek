import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const mockInit = vi.fn();
  const mockCaptureException = vi.fn();
  const mockCaptureMessage = vi.fn();
  const mockAddBreadcrumb = vi.fn();
  const mockSetUser = vi.fn();
  const mockEmit = vi.fn();
  const mockGetLogger = vi.fn().mockReturnValue({ emit: mockEmit });
  const mockResourceFromAttributes = vi.fn().mockReturnValue({ resource: "mock" });
  const mockBatchLogRecordProcessor = vi.fn(function batchLogRecordProcessorConstructor(_options: {
    exporter: LogRecordExporter;
  }) {
    return { processor: "mock" };
  });
  const mockLoggerProvider = vi.fn(function loggerProviderConstructor() {
    return {
      getLogger: mocks.mockGetLogger,
    };
  });
  return {
    mockInit,
    mockCaptureException,
    mockCaptureMessage,
    mockAddBreadcrumb,
    mockSetUser,
    mockEmit,
    mockGetLogger,
    mockResourceFromAttributes,
    mockBatchLogRecordProcessor,
    mockLoggerProvider,
  };
});

vi.mock("@sentry/react-native", () => ({
  init: mocks.mockInit,
  captureException: mocks.mockCaptureException,
  captureMessage: mocks.mockCaptureMessage,
  addBreadcrumb: mocks.mockAddBreadcrumb,
  setUser: mocks.mockSetUser,
}));

const versionMocks = vi.hoisted(() => ({
  manifest: { version: "1.2.3" },
  runtimeVersion: "1.12",
  updateId: "ota-update-id",
}));
const constantsMock = vi.hoisted(
  (): {
    platform?: { ios?: { buildNumber: string | null }; android?: { versionCode: number } };
  } => ({ platform: { ios: { buildNumber: "123" } } }),
);

vi.mock("expo-updates", () => versionMocks);
vi.mock("expo-constants", () => ({
  default: constantsMock,
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "runtime-instance-id" }));

const runtimeContext = {
  appVersion: "1.2.3",
  appBuild: "123",
  assetsVersion: "ota-update-id",
  runtimeVersion: "1.12",
  runtimeId: "runtime-instance-id",
};

const posthogMocks = vi.hoisted(() => {
  const captureException = vi.fn();
  const capture = vi.fn();
  const registeredProperties: Record<string, unknown> = {};
  const register = vi.fn((properties: Record<string, unknown>) => {
    Object.assign(registeredProperties, properties);
  });
  const identify = vi.fn();
  const reset = vi.fn(() => {
    for (const key of Object.keys(registeredProperties)) delete registeredProperties[key];
  });
  const mockPosthogConstructor = vi.fn(function posthogConstructor(
    _apiKey: string,
    _options: PostHogClientOptions,
  ) {
    return {
      captureException,
      capture,
      register,
      identify,
      reset,
    };
  });
  return {
    captureException,
    capture,
    register,
    registeredProperties,
    identify,
    reset,
    mockPosthogConstructor,
  };
});

type PostHogClientOptions = {
  host: string;
  errorTracking: {
    autocapture: {
      uncaughtExceptions: boolean;
      unhandledRejections: boolean;
    };
  };
};

vi.mock("posthog-react-native", () => ({
  default: posthogMocks.mockPosthogConstructor,
}));

vi.mock("@opentelemetry/sdk-logs", () => ({
  LoggerProvider: mocks.mockLoggerProvider,
  BatchLogRecordProcessor: mocks.mockBatchLogRecordProcessor,
}));

vi.mock("@opentelemetry/exporter-logs-otlp-http", () => ({
  OTLPLogExporter: vi.fn(function otlpLogExporterConstructor(this: LogRecordExporter) {
    this.export = vi.fn<LogRecordExporter["export"]>();
    this.forceFlush = vi.fn<LogRecordExporter["forceFlush"]>().mockResolvedValue(undefined);
    this.shutdown = vi.fn<LogRecordExporter["shutdown"]>().mockResolvedValue(undefined);
  }),
}));

vi.mock("@opentelemetry/resources", () => ({
  resourceFromAttributes: mocks.mockResourceFromAttributes,
}));

vi.mock("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
}));

describe("ios telemetry", () => {
  it.each([
    new Error("HTTP 403"),
    new SyntaxError("Invalid JSON"),
    new Error("Failed to write value."),
  ])("reports unexpected outcome %# to both error trackers", async (error) => {
    vi.stubGlobal("__DEV__", false);
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
    const mod = await import("./telemetry");
    mod.initTelemetry();
    mod.captureException(error, { source: "whoop-ble-realtime-upload" });
    expect(mocks.mockCaptureException).toHaveBeenCalledWith(error, expect.any(Object));
    expect(posthogMocks.captureException).toHaveBeenCalledWith(error, expect.any(Object));
    expect(posthogMocks.capture).not.toHaveBeenCalled();
  });
  it.each([
    [new Error("fetch failed: cancelled"), "cancelled"],
    [new Error("fetch failed: The Internet connection appears to be offline."), "offline"],
    [
      Object.assign(new Error("Check credentials"), {
        data: { handledFailure: "invalid_credentials" },
      }),
      "invalid_credentials",
    ],
  ])(
    "counts handled outcome %# and retains a log without an exception issue",
    async (error, kind) => {
      vi.stubGlobal("__DEV__", false);
      process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
      process.env.EXPO_PUBLIC_OTEL_ENDPOINT = "https://api.axiom.co/v1/logs";
      const mod = await import("./telemetry");
      mod.initTelemetry();
      mod.captureException(error, { source: "whoop-ble-realtime-upload" });
      expect(posthogMocks.capture).toHaveBeenCalledWith("handled_failure", { kind });
      expect(mocks.mockCaptureException).not.toHaveBeenCalled();
      expect(posthogMocks.captureException).not.toHaveBeenCalled();
      expect(mocks.mockEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          severityText: "INFO",
          body: "[handled-failure] Handled operational failure",
          attributes: expect.objectContaining({ kind }),
        }),
      );
    },
  );

  let originalDsn: string | undefined;
  let originalRelease: string | undefined;
  let originalDist: string | undefined;
  let originalOtelEndpoint: string | undefined;
  let originalOtelHeaders: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal("__DEV__", true);
    constantsMock.platform = { ios: { buildNumber: "123" } };
    for (const key of Object.keys(posthogMocks.registeredProperties)) {
      delete posthogMocks.registeredProperties[key];
    }

    originalDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
    originalRelease = process.env.EXPO_PUBLIC_SENTRY_RELEASE;
    originalDist = process.env.EXPO_PUBLIC_SENTRY_DIST;
    originalOtelEndpoint = process.env.EXPO_PUBLIC_OTEL_ENDPOINT;
    originalOtelHeaders = process.env.EXPO_PUBLIC_OTEL_HEADERS;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalDsn === undefined) {
      delete process.env.EXPO_PUBLIC_SENTRY_DSN;
    } else {
      process.env.EXPO_PUBLIC_SENTRY_DSN = originalDsn;
    }
    if (originalRelease === undefined) {
      delete process.env.EXPO_PUBLIC_SENTRY_RELEASE;
    } else {
      process.env.EXPO_PUBLIC_SENTRY_RELEASE = originalRelease;
    }
    if (originalDist === undefined) {
      delete process.env.EXPO_PUBLIC_SENTRY_DIST;
    } else {
      process.env.EXPO_PUBLIC_SENTRY_DIST = originalDist;
    }
    if (originalOtelEndpoint === undefined) {
      delete process.env.EXPO_PUBLIC_OTEL_ENDPOINT;
    } else {
      process.env.EXPO_PUBLIC_OTEL_ENDPOINT = originalOtelEndpoint;
    }
    if (originalOtelHeaders === undefined) {
      delete process.env.EXPO_PUBLIC_OTEL_HEADERS;
    } else {
      process.env.EXPO_PUBLIC_OTEL_HEADERS = originalOtelHeaders;
    }
  });

  it("throws immediately when EXPO_PUBLIC_SENTRY_DSN is not set", async () => {
    delete process.env.EXPO_PUBLIC_SENTRY_DSN;

    const mod = await import("./telemetry");

    expect(() => mod.initTelemetry()).toThrow(
      "EXPO_PUBLIC_SENTRY_DSN is not set — Sentry cannot initialize",
    );
    expect(mocks.mockInit).not.toHaveBeenCalled();
  });

  it("initializes Sentry once with DSN", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";

    const mod = await import("./telemetry");
    mod.initTelemetry();
    mod.initTelemetry(); // idempotent

    expect(mocks.mockInit).toHaveBeenCalledTimes(1);
    expect(mocks.mockInit).toHaveBeenCalledWith({
      dsn: "https://key@sentry.example/789",
      debug: true,
      tracesSampler: expect.any(Function),
    });
    const options = mocks.mockInit.mock.calls[0]?.[0];
    const tracesSampler = options?.tracesSampler;
    expect(tracesSampler?.({ name: "App Start", inheritOrSampleWith: vi.fn() })).toBe(1);
    expect(tracesSampler?.({ name: "Mobile Startup", inheritOrSampleWith: vi.fn() })).toBe(1);
    expect(
      tracesSampler?.({
        name: "unrelated navigation",
        inheritOrSampleWith: vi.fn().mockReturnValue(0),
      }),
    ).toBe(0);
    expect(mocks.mockCaptureMessage).not.toHaveBeenCalled();
  });

  it("passes the bundled release and distribution to Sentry", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
    process.env.EXPO_PUBLIC_SENTRY_RELEASE = "release-sha";
    process.env.EXPO_PUBLIC_SENTRY_DIST = "build-123";

    const mod = await import("./telemetry");
    mod.initTelemetry();

    expect(mocks.mockInit).toHaveBeenCalledWith(
      expect.objectContaining({
        release: "release-sha",
        dist: "build-123",
      }),
    );
  });

  it("initializes PostHog with crash-only error autocapture in production builds", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
    vi.stubGlobal("__DEV__", false);

    const mod = await import("./telemetry");
    mod.initTelemetry();

    expect(mocks.mockInit).toHaveBeenCalledWith(expect.objectContaining({ debug: false }));
    expect(posthogMocks.mockPosthogConstructor).toHaveBeenCalledTimes(1);
    const options = posthogMocks.mockPosthogConstructor.mock.calls[0]?.[1];
    expect(options).toMatchObject({ host: "https://us.i.posthog.com" });
    expect(options?.errorTracking.autocapture).toEqual({
      uncaughtExceptions: true,
      unhandledRejections: true,
    });
    expect(posthogMocks.register).toHaveBeenCalledWith({
      service: "dofek-mobile",
      ...runtimeContext,
    });
  });

  it("delegates captureException to Sentry with a searchable source tag and extra context", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";

    const mod = await import("./telemetry");
    mod.initTelemetry();

    const error = new Error("test error");
    mod.captureException(error, {
      source: "react-native-global",
      operation: "global-handler",
    });

    expect(mocks.mockCaptureException).toHaveBeenCalledWith(error, {
      tags: { source: "react-native-global" },
      extra: {
        ...runtimeContext,
        source: "react-native-global",
        operation: "global-handler",
      },
    });
  });

  it("correlates logs and errors with the native build, OTA and JavaScript runtime", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
    process.env.EXPO_PUBLIC_OTEL_ENDPOINT = "https://api.axiom.co/v1/logs";
    vi.stubGlobal("__DEV__", false);
    const mod = await import("./telemetry");
    mod.initTelemetry();

    mod.logger.info("whoop-ble", "Buffer snapshot", { sampleCount: 12, appBuild: "spoofed" });
    const error = new Error("Upload failed");
    mod.captureException(error, { source: "whoop-ble-sync", runtimeId: "spoofed" });

    expect(mocks.mockEmit.mock.calls[0]?.[0].attributes).toEqual({
      ...runtimeContext,
      sampleCount: 12,
    });
    expect(mocks.mockCaptureException).toHaveBeenCalledWith(error, {
      tags: { source: "whoop-ble-sync" },
      extra: { ...runtimeContext, source: "whoop-ble-sync" },
    });
    expect(posthogMocks.captureException).toHaveBeenCalledWith(error, {
      ...runtimeContext,
      source: "whoop-ble-sync",
    });
    expect(posthogMocks.register).toHaveBeenCalledWith({
      ...runtimeContext,
      service: "dofek-mobile",
    });
  });

  it("uses the authenticated account ID on each record and Sentry without copying contact details", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
    process.env.EXPO_PUBLIC_OTEL_ENDPOINT = "https://api.axiom.co/v1/logs";
    vi.stubGlobal("__DEV__", false);
    const mod = await import("./telemetry");
    mod.initTelemetry();
    mod.identifyUser({ id: "first-account", email: "private@example.com", name: "Private Name" });
    mod.logger.info("whoop-ble", "Connected", { userId: "spoofed-account" });
    mod.identifyUser({ id: "second-account", email: null, name: "Second Private Name" });
    const error = new Error("Upload failed");
    mod.captureException(error, { source: "whoop-ble-sync", userId: "first-account" });

    expect(mocks.mockSetUser.mock.calls).toEqual([
      [{ id: "first-account" }],
      [{ id: "second-account" }],
    ]);
    expect(mocks.mockEmit.mock.calls[0]?.[0].attributes.userId).toBe("first-account");
    expect(mocks.mockEmit.mock.lastCall?.[0].attributes.userId).toBe("second-account");
    expect(mocks.mockCaptureException.mock.lastCall?.[1].extra.userId).toBe("second-account");
    expect(posthogMocks.captureException.mock.lastCall?.[1].userId).toBe("second-account");
    expect(posthogMocks.identify).toHaveBeenLastCalledWith("second-account", {
      email: null,
      name: "Second Private Name",
    });
    expect(
      JSON.stringify([mocks.mockEmit.mock.calls, mocks.mockCaptureException.mock.calls]),
    ).not.toContain("Private Name");
    expect(
      JSON.stringify([mocks.mockEmit.mock.calls, mocks.mockCaptureException.mock.calls]),
    ).not.toContain("private@example.com");
  });

  it.each([
    { platform: { android: { versionCode: 42 } }, expectedBuild: "42" },
    { platform: { ios: { buildNumber: null } }, expectedBuild: "unknown" },
    { platform: undefined, expectedBuild: "unknown" },
  ])(
    "records the available native build or an explicit unknown ($expectedBuild)",
    async ({ platform, expectedBuild }) => {
      process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
      process.env.EXPO_PUBLIC_OTEL_ENDPOINT = "https://api.axiom.co/v1/logs";
      constantsMock.platform = platform;
      const mod = await import("./telemetry");
      mod.initTelemetry();

      mod.logger.info("whoop-ble", "Connected");

      expect(mocks.mockEmit.mock.lastCall?.[0].attributes.appBuild).toBe(expectedBuild);
    },
  );

  it("clears account attribution on logout even if a caller passes a stale account ID", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
    process.env.EXPO_PUBLIC_OTEL_ENDPOINT = "https://api.axiom.co/v1/logs";
    vi.stubGlobal("__DEV__", false);
    const mod = await import("./telemetry");
    mod.initTelemetry();
    mod.identifyUser({ id: "first-account", email: null, name: "Private Name" });
    mod.resetUser();
    mod.logger.info("whoop-ble", "Disconnected", { userId: "first-account" });
    mod.captureException(new Error("Logged-out failure"), { userId: "first-account" });

    expect(mocks.mockSetUser).toHaveBeenLastCalledWith(null);
    expect(posthogMocks.reset).toHaveBeenCalledOnce();
    expect(mocks.mockEmit.mock.calls[0]?.[0].attributes).toEqual(runtimeContext);
    expect(mocks.mockEmit.mock.lastCall?.[0].attributes).toEqual({
      ...runtimeContext,
      errorName: "Error",
    });
    expect(mocks.mockCaptureException.mock.lastCall?.[1].extra.userId).toBeUndefined();
    expect(posthogMocks.captureException.mock.lastCall?.[1].userId).toBeUndefined();
  });

  it("restores non-user PostHog correlation properties after a user reset", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
    vi.stubGlobal("__DEV__", false);
    const mod = await import("./telemetry");
    mod.initTelemetry();
    mod.identifyUser({ id: "first-account", email: null, name: "First User" });

    mod.resetUser();

    expect(posthogMocks.reset).toHaveBeenCalledOnce();
    expect(posthogMocks.registeredProperties).toEqual({
      service: "dofek-mobile",
      ...runtimeContext,
    });
  });

  it("keeps account attribution on OTel records without retaining it in cross-account breadcrumbs", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
    process.env.EXPO_PUBLIC_OTEL_ENDPOINT = "https://api.axiom.co/v1/logs";
    const mod = await import("./telemetry");
    mod.initTelemetry();
    mod.identifyUser({ id: "first-account", email: null, name: "First User" });
    mod.logger.info("whoop-ble", "upload_started", { batchId: "first-batch" });
    mod.resetUser();
    mod.identifyUser({ id: "second-account", email: null, name: "Second User" });
    mod.captureException(new Error("Current request failed"), { source: "whoop-ble" });

    expect(mocks.mockEmit.mock.calls[0]?.[0].attributes.userId).toBe("first-account");
    expect(mocks.mockEmit.mock.lastCall?.[0].attributes.userId).toBe("second-account");
    expect(mocks.mockAddBreadcrumb.mock.calls[0]?.[0].data).toEqual({
      ...runtimeContext,
      batchId: "first-batch",
    });
    expect(mocks.mockAddBreadcrumb.mock.lastCall?.[0].data).toEqual({
      ...runtimeContext,
      source: "whoop-ble",
      errorName: "Error",
    });
  });

  it("reports retired lifetime failures anonymously without borrowing the next account's identity or route", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
    process.env.EXPO_PUBLIC_OTEL_ENDPOINT = "https://api.axiom.co/v1/logs";
    vi.stubGlobal("__DEV__", false);
    const mod = await import("./telemetry");
    mod.initTelemetry();
    mod.identifyUser({ id: "first-account", email: null, name: "First User" });
    mod.resetUser();
    mod.identifyUser({ id: "second-account", email: null, name: "Second User" });
    mod.setTelemetryRoute("/settings");
    const retiredError = new Error("Retired WHOOP worker failed");

    mod.captureException(retiredError, {
      source: "whoop-ble-sync",
      retiredLifetime: true,
      userId: "first-account",
    });

    const retiredCaptureContext = mocks.mockCaptureException.mock.calls[0]?.[1];
    expect(typeof retiredCaptureContext).toBe("function");
    if (typeof retiredCaptureContext !== "function") {
      throw new Error("Expected a local Sentry scope override for a retired failure.");
    }
    const scopeState: {
      user: { id: string } | null;
      tags: Record<string, string>;
      extra: Record<string, unknown>;
    } = { user: { id: "second-account" }, tags: {}, extra: {} };
    const scope = {
      setUser(user: { id: string } | null) {
        scopeState.user = user;
        return this;
      },
      setTag(key: string, value: string) {
        scopeState.tags[key] = value;
        return this;
      },
      setExtras(extra: Record<string, unknown>) {
        scopeState.extra = extra;
        return this;
      },
    };
    expect(retiredCaptureContext(scope)).toBe(scope);
    expect(scopeState.user).toBeNull();
    expect(scopeState.tags).toEqual({ source: "whoop-ble-sync" });
    expect(scopeState.extra).toEqual({
      ...runtimeContext,
      source: "whoop-ble-sync",
      retiredLifetime: true,
    });
    expect(mocks.mockEmit.mock.calls[0]?.[0].attributes).toEqual({
      ...runtimeContext,
      source: "whoop-ble-sync",
      retiredLifetime: true,
      errorName: "Error",
    });
    expect(posthogMocks.captureException).not.toHaveBeenCalled();
    expect(mocks.mockSetUser).toHaveBeenLastCalledWith({ id: "second-account" });

    const currentError = new Error("Current request failed");
    mod.captureException(currentError, { source: "react-query" });

    expect(mocks.mockCaptureException).toHaveBeenLastCalledWith(currentError, {
      tags: { source: "react-query" },
      extra: {
        ...runtimeContext,
        source: "react-query",
        userId: "second-account",
        route: "/settings",
      },
    });
    expect(posthogMocks.captureException).toHaveBeenCalledOnce();
    expect(posthogMocks.captureException).toHaveBeenLastCalledWith(currentError, {
      ...runtimeContext,
      source: "react-query",
      userId: "second-account",
      route: "/settings",
    });
    expect(mocks.mockEmit.mock.lastCall?.[0].attributes).toMatchObject({
      userId: "second-account",
      route: "/settings",
    });
  });

  it("adds the sanitized current route to error context", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";

    const mod = await import("./telemetry");
    mod.initTelemetry();
    mod.setTelemetryRoute("/activity/550e8400-e29b-41d4-a716-446655440000");

    mod.captureException(new Error("request failed"), { source: "react-query" });

    expect(mocks.mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: {
          ...runtimeContext,
          source: "react-query",
          route: "/activity/:id",
        },
      }),
    );
  });

  it.each([
    "550e8400-e29b-61d4-a716-446655440000",
    "550e8400-e29b-71d4-a716-446655440000",
    "550e8400-e29b-81d4-a716-446655440000",
  ])("redacts UUID routes from versions 6 through 8 (%s)", async (uuid) => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";

    const mod = await import("./telemetry");
    mod.initTelemetry();
    mod.setTelemetryRoute(`/activity/${uuid}`);

    mod.captureException(new Error("request failed"), { source: "react-query" });

    expect(mocks.mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: {
          ...runtimeContext,
          source: "react-query",
          route: "/activity/:id",
        },
      }),
    );
  });

  it("keeps an explicitly supplied route over the global route", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";

    const mod = await import("./telemetry");
    mod.initTelemetry();
    mod.setTelemetryRoute("/settings");

    mod.captureException(new Error("request failed"), {
      source: "react-query",
      route: "/providers",
    });

    expect(mocks.mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: {
          ...runtimeContext,
          source: "react-query",
          route: "/providers",
        },
      }),
    );
  });

  it("does not retain a malformed explicit route or fall back to the global route", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
    process.env.EXPO_PUBLIC_OTEL_ENDPOINT = "https://api.axiom.co/v1/logs";

    const mod = await import("./telemetry");
    mod.initTelemetry();
    mod.setTelemetryRoute("/settings");

    mod.captureException(new Error("request failed"), {
      source: "react-query",
      route: "?token=secret",
    });
    mod.logger.error("invalid-route", "request failed", { route: "?token=secret" });

    expect(mocks.mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: {
          ...runtimeContext,
          source: "react-query",
          route: undefined,
        },
      }),
    );
    expect(mocks.mockAddBreadcrumb).toHaveBeenLastCalledWith({
      category: "invalid-route",
      message: "request failed",
      level: "error",
      data: runtimeContext,
    });
    expect(mocks.mockEmit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: "[invalid-route] request failed",
        attributes: runtimeContext,
      }),
    );
    expect(
      JSON.stringify([
        mocks.mockCaptureException.mock.calls,
        mocks.mockAddBreadcrumb.mock.calls,
        mocks.mockEmit.mock.calls,
      ]),
    ).not.toContain("secret");
  });

  it("drops transient background HealthKit network errors from Sentry and PostHog", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
    process.env.EXPO_PUBLIC_OTEL_ENDPOINT = "https://api.axiom.co/v1/logs";

    const mod = await import("./telemetry");
    mod.initTelemetry();

    const connectionLostError = new Error(
      "fetch failed: UnexpectedException: The network connection was lost.",
    );
    mod.captureException(connectionLostError, { source: "bg-healthkit-sync" });

    // Neither error-tracking destination receives the suppressed error...
    expect(mocks.mockCaptureException).not.toHaveBeenCalled();
    expect(posthogMocks.captureException).not.toHaveBeenCalled();
    // ...but the failure is still logged for observability.
    expect(mocks.mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        severityText: "INFO",
        body: "[handled-failure] Handled operational failure",
      }),
    );
  });

  it("keeps expected input failures in local telemetry without reporting them", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
    process.env.EXPO_PUBLIC_OTEL_ENDPOINT = "https://api.axiom.co/v1/logs";

    const mod = await import("./telemetry");
    mod.initTelemetry();

    const error = new Error("Invalid email or password");
    mod.captureException(
      error,
      { source: "login-screen-password-auth" },
      { reportToErrorTracking: false },
    );

    expect(mocks.mockCaptureException).not.toHaveBeenCalled();
    expect(posthogMocks.captureException).not.toHaveBeenCalled();
    expect(mocks.mockAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "exception",
        message: error.message,
        level: "error",
      }),
    );
    expect(mocks.mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        severityText: "ERROR",
        body: `[exception] ${error.message}`,
      }),
    );
  });

  it("still reports transient network errors from non-HealthKit sources", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";

    const mod = await import("./telemetry");
    mod.initTelemetry();

    const connectionLostError = new Error(
      "fetch failed: UnexpectedException: The network connection was lost.",
    );
    mod.captureException(connectionLostError, { source: "react-query" });

    expect(mocks.mockCaptureException).toHaveBeenCalledWith(connectionLostError, {
      tags: { source: "react-query" },
      extra: { ...runtimeContext, source: "react-query" },
    });
  });

  it("captureException emits an OTel ERROR record when OTel is configured", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
    process.env.EXPO_PUBLIC_OTEL_ENDPOINT = "https://api.axiom.co/v1/logs";

    const mod = await import("./telemetry");
    mod.initTelemetry();

    const error = new Error("native apple failed");
    mod.captureException(error, { source: "login-screen-handle-login" });

    expect(mocks.mockGetLogger).toHaveBeenCalledWith("exception");
    expect(mocks.mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        severityText: "ERROR",
        body: "[exception] native apple failed",
        attributes: {
          ...runtimeContext,
          source: "login-screen-handle-login",
          errorName: "Error",
        },
      }),
    );
  });

  it("initializes OTel LoggerProvider when endpoint is set", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
    process.env.EXPO_PUBLIC_OTEL_ENDPOINT = "https://api.axiom.co/v1/logs";
    process.env.EXPO_PUBLIC_OTEL_HEADERS = "Authorization=Bearer tok123,x-axiom-dataset=dofek-logs";

    const mod = await import("./telemetry");
    mod.initTelemetry();

    expect(mocks.mockResourceFromAttributes).toHaveBeenCalledWith({
      "service.name": "dofek-mobile",
    });
    expect(mocks.mockBatchLogRecordProcessor).toHaveBeenCalledWith({
      exporter: expect.objectContaining({
        export: expect.any(Function),
        forceFlush: expect.any(Function),
        shutdown: expect.any(Function),
      }),
    });
    expect(mocks.mockLoggerProvider).toHaveBeenCalledWith({
      resource: { resource: "mock" },
      processors: [{ processor: "mock" }],
    });
  });

  it("logger.info emits OTel log record when provider is initialized", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
    process.env.EXPO_PUBLIC_OTEL_ENDPOINT = "https://api.axiom.co/v1/logs";

    const mod = await import("./telemetry");
    mod.initTelemetry();

    mod.logger.info("test-category", "hello world", { key: "value" });

    expect(mocks.mockGetLogger).toHaveBeenCalledWith("test-category");
    expect(mocks.mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "[test-category] hello world",
        severityText: "INFO",
        attributes: { ...runtimeContext, key: "value" },
      }),
    );
  });

  it("exports mobile metadata as an Axiom map while preserving PostHog records", async () => {
    vi.stubGlobal("__DEV__", false);
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
    process.env.EXPO_PUBLIC_OTEL_ENDPOINT = "https://api.axiom.co/v1/logs";

    const mod = await import("./telemetry");
    mod.initTelemetry();
    mod.identifyUser({ id: "mobile-user", email: null, name: "Mobile User" });
    mod.setTelemetryRoute("/activity/550e8400-e29b-41d4-a716-446655440000");
    mod.logger.warn("sensor-sync", "Upload delayed", { pending: 2, connected: false });

    const emitted = mocks.mockEmit.mock.lastCall?.[0];
    const axiomProcessorExporter = mocks.mockBatchLogRecordProcessor.mock.calls[0]?.[0].exporter;
    const posthogProcessorExporter = mocks.mockBatchLogRecordProcessor.mock.calls[1]?.[0].exporter;
    const axiomOtlpExporter = vi.mocked(OTLPLogExporter).mock.instances[0];
    const posthogOtlpExporter = vi.mocked(OTLPLogExporter).mock.instances[1];
    if (
      !emitted ||
      !axiomProcessorExporter ||
      !posthogProcessorExporter ||
      !axiomOtlpExporter ||
      !posthogOtlpExporter
    ) {
      throw new Error("Both telemetry export destinations must initialize");
    }
    const resource = resourceFromAttributes({ "service.name": "dofek-mobile" });
    const instrumentationScope = { name: "sensor-sync", version: "1.0.0" };
    const spanContext = {
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
      traceFlags: 1,
    };
    const record: ReadableLogRecord = {
      get hrTime() {
        return [1, 2];
      },
      get hrTimeObserved() {
        return [3, 4];
      },
      get body() {
        return emitted.body;
      },
      get severityNumber() {
        return emitted.severityNumber;
      },
      get severityText() {
        return emitted.severityText;
      },
      get spanContext() {
        return spanContext;
      },
      get eventName() {
        return "sensor_upload";
      },
      resource,
      instrumentationScope,
      droppedAttributesCount: 0,
      attributes: emitted.attributes,
    };
    const callback = vi.fn();

    axiomProcessorExporter.export([record], callback);
    posthogProcessorExporter.export([record], callback);

    const exported = vi.mocked(axiomOtlpExporter.export).mock.lastCall?.[0][0];
    expect(exported).toEqual({
      hrTime: [1, 2],
      hrTimeObserved: [3, 4],
      body: "[sensor-sync] Upload delayed",
      severityNumber: 13,
      severityText: "WARN",
      spanContext,
      eventName: "sensor_upload",
      resource,
      instrumentationScope,
      droppedAttributesCount: 0,
      attributes: {
        custom: {
          ...runtimeContext,
          userId: "mobile-user",
          route: "/activity/:id",
          pending: 2,
          connected: false,
        },
      },
    });
    expect(axiomOtlpExporter.export).toHaveBeenCalledWith([exported], callback);
    expect(posthogOtlpExporter.export).toHaveBeenCalledWith([record], callback);
    expect(record.attributes).toEqual({
      ...runtimeContext,
      userId: "mobile-user",
      route: "/activity/:id",
      pending: 2,
      connected: false,
    });
    expect(mocks.mockAddBreadcrumb).toHaveBeenLastCalledWith({
      category: "sensor-sync",
      message: "Upload delayed",
      level: "warning",
      data: {
        ...runtimeContext,
        route: "/activity/:id",
        pending: 2,
        connected: false,
      },
    });
  });

  it("adds the current route to structured log breadcrumbs and OTel records", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
    process.env.EXPO_PUBLIC_OTEL_ENDPOINT = "https://api.axiom.co/v1/logs";

    const mod = await import("./telemetry");
    mod.initTelemetry();
    mod.setTelemetryRoute("/activity/550e8400-e29b-41d4-a716-446655440000");

    mod.logger.info("screen-navigation", "Activity opened", { selected: true });

    expect(mocks.mockAddBreadcrumb).toHaveBeenCalledWith({
      category: "screen-navigation",
      message: "Activity opened",
      level: "info",
      data: {
        ...runtimeContext,
        selected: true,
        route: "/activity/:id",
      },
    });
    expect(mocks.mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: {
          ...runtimeContext,
          selected: true,
          route: "/activity/:id",
        },
      }),
    );
  });

  it("logger.info adds a Sentry breadcrumb with sanitized data", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";

    const mod = await import("./telemetry");
    mod.initTelemetry();

    mod.logger.info("screen-navigation", "Nutrition tab selected", {
      route: "food",
      selected: true,
      count: 1,
      ignored: { nested: "value" },
    });

    expect(mocks.mockAddBreadcrumb).toHaveBeenCalledWith({
      category: "screen-navigation",
      message: "Nutrition tab selected",
      level: "info",
      data: {
        ...runtimeContext,
        route: "/food",
        selected: true,
        count: 1,
      },
    });
  });

  it("logger works without OTel endpoint (console-only)", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
    delete process.env.EXPO_PUBLIC_OTEL_ENDPOINT;

    const mod = await import("./telemetry");
    mod.initTelemetry();

    // Should not throw
    mod.logger.info("test", "message");
    mod.logger.warn("test", "warning");
    mod.logger.error("test", "error");

    // No OTel calls
    expect(mocks.mockGetLogger).not.toHaveBeenCalled();
  });
});
