import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capturePageLoad,
  capturePageView,
  disablePostHogForAccountErasure,
  identifyPostHogUser,
  initPostHog,
  resetPostHogUser,
} from "./posthog.ts";

vi.mock("posthog-js", () => ({
  default: {
    init: vi.fn(),
    capture: vi.fn(),
    identify: vi.fn(),
    has_opted_out_capturing: vi.fn(() => false),
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
    reset: vi.fn(),
    get_property: vi.fn(() => "sdk-device-id"),
  },
}));

import posthog from "posthog-js";

it("strips SDK enrichment and raw account identifiers from readiness exports", () => {
  initPostHog();
  const config = vi.mocked(posthog.init).mock.calls.at(-1)?.[1];
  const beforeSend = config?.before_send;
  expect(typeof beforeSend).toBe("function");
  if (typeof beforeSend !== "function") return;
  const exported = beforeSend({
    event: "page_data_readiness",
    uuid: "event-id",
    properties: {
      route: "/dashboard",
      kind: "navigation",
      durationMs: 350,
      outcome: "ready",
      release: "release",
      token: "public-api-key",
      distinct_id: "account-id",
      $current_url: "https://dofek.fit/body?date=private",
      $referrer: "private",
      accountId: "account-id",
      heartRate: 80,
      requestKey: "private",
      $set: { email: "private" },
    },
    $set: { email: "private" },
  });
  expect(exported).toEqual({
    event: "page_data_readiness",
    uuid: "event-id",
    properties: {
      route: "/dashboard",
      kind: "navigation",
      durationMs: 350,
      outcome: "ready",
      release: "release",
      token: "public-api-key",
      distinct_id: "sdk-device-id",
      $process_person_profile: false,
    },
  });
  const pageview = {
    event: "$pageview",
    uuid: "event-id",
    properties: { distinct_id: "account-id" },
  };
  expect(beforeSend(pageview)).toBe(pageview);
  vi.clearAllMocks();
});

describe("page load export", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.mocked(posthog.has_opted_out_capturing).mockReturnValue(false);
  });
  it("exports only the documented timing payload", () => {
    vi.mocked(posthog.has_opted_out_capturing).mockReturnValue(false);
    capturePageLoad({
      route: "/body/heart-rate",
      section: "chart",
      generation: 2,
      kind: "filter",
      startedAt: 100,
      completedAt: 450,
      durationMs: 350,
      outcome: "ready",
    });
    expect(posthog.capture).toHaveBeenCalledWith("page_data_readiness", {
      route: "/body/heart-rate",
      section: "chart",
      kind: "filter",
      durationMs: 350,
      outcome: "ready",
      release: "development",
    });
  });
  it("does not export after consent or erasure opt-out", () => {
    vi.mocked(posthog.has_opted_out_capturing).mockReturnValue(true);
    capturePageLoad({
      route: "/dashboard",
      generation: 1,
      kind: "navigation",
      startedAt: 0,
      completedAt: 450,
      durationMs: 450,
      outcome: "ready",
    });
    expect(posthog.capture).not.toHaveBeenCalled();
  });
});

describe("initPostHog", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls posthog.init with the correct API key", () => {
    initPostHog();
    expect(posthog.init).toHaveBeenCalledWith(
      "phc_GsvyihTLSXrWGKYYGz84m44nuT59kYEwEXNnI0JICtg",
      expect.any(Object),
    );
  });

  it("configures the PostHog US ingestion host", () => {
    initPostHog();
    expect(posthog.init).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ api_host: "https://us.i.posthog.com" }),
    );
  });

  it("disables automatic pageview capture", () => {
    initPostHog();
    expect(posthog.init).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ capture_pageview: false }),
    );
  });

  it("enables page leave capture", () => {
    initPostHog();
    expect(posthog.init).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ capture_pageleave: true }),
    );
  });

  it("enables exception autocapture", () => {
    initPostHog();
    expect(posthog.init).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        capture_exceptions: {
          capture_unhandled_errors: true,
          capture_unhandled_rejections: true,
          capture_console_errors: true,
        },
      }),
    );
  });
});

describe("capturePageView", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends a $pageview event", () => {
    capturePageView();
    expect(posthog.capture).toHaveBeenCalledWith("$pageview");
  });

  it("does not pass custom properties so PostHog uses window.location.href", () => {
    capturePageView();
    expect(posthog.capture).toHaveBeenCalledTimes(1);
    expect(posthog.capture).toHaveBeenCalledWith("$pageview");
  });

  it("does not emit page views after account-erasure opt-out", () => {
    vi.mocked(posthog.has_opted_out_capturing).mockReturnValue(true);

    capturePageView();

    expect(posthog.capture).not.toHaveBeenCalled();
  });
});

describe("account identity", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("opts back in and identifies the authenticated account", () => {
    identifyPostHogUser("user-1");

    expect(posthog.opt_in_capturing).toHaveBeenCalledOnce();
    expect(posthog.identify).toHaveBeenCalledWith("user-1");
  });

  it("resets identity on logout or session loss", () => {
    resetPostHogUser();

    expect(posthog.reset).toHaveBeenCalledOnce();
  });

  it("preserves account-erasure opt-out when resetting identity", () => {
    vi.mocked(posthog.has_opted_out_capturing).mockReturnValue(true);

    resetPostHogUser();

    expect(posthog.opt_out_capturing).toHaveBeenCalledOnce();
  });

  it("resets identity and opts out before account erasure confirmation", () => {
    disablePostHogForAccountErasure();

    expect(posthog.reset).toHaveBeenCalledOnce();
    expect(posthog.opt_out_capturing).toHaveBeenCalledOnce();
    expect(vi.mocked(posthog.reset).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(posthog.opt_out_capturing).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });
});
