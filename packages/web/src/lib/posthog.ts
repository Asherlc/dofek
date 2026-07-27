import posthog from "posthog-js";

const API_KEY = "phc_GsvyihTLSXrWGKYYGz84m44nuT59kYEwEXNnI0JICtg";

export function initPostHog() {
  posthog.init(API_KEY, {
    api_host: "https://us.i.posthog.com",
    capture_pageview: false, // we capture manually on route change
    capture_pageleave: true,
  });
}

export function capturePageView() {
  if (posthog.has_opted_out_capturing()) return;
  posthog.capture("$pageview");
}

export function identifyPostHogUser(userId: string): void {
  posthog.opt_in_capturing();
  posthog.identify(userId);
}

export function resetPostHogUser(): void {
  posthog.reset();
}

export function disablePostHogForAccountErasure(): void {
  posthog.reset();
  posthog.opt_out_capturing();
}
