import posthog from "posthog-js";
import type { AuthUser } from "./auth.ts";

const API_KEY = "phc_GsvyihTLSXrWGKYYGz84m44nuT59kYEwEXNnI0JICtg";
const API_HOST = "https://us.i.posthog.com";

export function initPostHog() {
  posthog.init(API_KEY, {
    api_host: API_HOST,
    capture_pageview: false, // we capture manually on route change
    capture_pageleave: true,
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: true,
    },
  });
}

export function capturePageView() {
  posthog.capture("$pageview");
}

export function identifyPostHogUser(user: AuthUser): void {
  posthog.identify(user.id, {
    email: user.email,
    name: user.name,
  });
}

export function resetPostHogUser(): void {
  posthog.reset();
}
