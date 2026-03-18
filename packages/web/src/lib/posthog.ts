import posthog from "posthog-js";

const API_KEY = "phc_GsvyihTLSXrWGKYYGz84m44nuT59kYEwEXNnI0JICtg";

export function initPostHog() {
  posthog.init(API_KEY, {
    api_host: "https://us.i.posthog.com",
    capture_pageview: false, // we capture manually on route change
    capture_pageleave: true,
  });
}

export function capturePageView(path: string) {
  posthog.capture("$pageview", { $current_url: path });
}
