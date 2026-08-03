import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
  },
}));

import posthog from "posthog-js";

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
