import { afterEach, describe, expect, it, vi } from "vitest";
import { capturePageView, identifyPostHogUser, initPostHog, resetPostHogUser } from "./posthog.ts";

vi.mock("posthog-js", () => ({
  default: {
    init: vi.fn(),
    capture: vi.fn(),
    identify: vi.fn(),
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

describe("identifyPostHogUser", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("identifies the authenticated user with durable person properties", () => {
    identifyPostHogUser({
      id: "user-123",
      name: "Alice Example",
      email: "alice@example.com",
    });

    expect(posthog.identify).toHaveBeenCalledWith("user-123", {
      email: "alice@example.com",
      name: "Alice Example",
    });
  });

  it("preserves a nullable email when identifying the user", () => {
    identifyPostHogUser({
      id: "user-456",
      name: "Private User",
      email: null,
    });

    expect(posthog.identify).toHaveBeenCalledWith("user-456", {
      email: null,
      name: "Private User",
    });
  });
});

describe("resetPostHogUser", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("resets the browser identity", () => {
    resetPostHogUser();

    expect(posthog.reset).toHaveBeenCalledOnce();
  });
});
