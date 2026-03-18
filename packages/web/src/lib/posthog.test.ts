import { afterEach, describe, expect, it, vi } from "vitest";
import { capturePageView, initPostHog } from "./posthog.ts";

vi.mock("posthog-js", () => ({
  default: {
    init: vi.fn(),
    capture: vi.fn(),
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
});
