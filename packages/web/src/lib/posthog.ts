import posthog from "posthog-js";
import type { PageLoadEvent } from "./page-load-tracker.ts";
import { captureException } from "./telemetry.ts";

declare const __COMMIT_HASH__: string;

export function capturePageLoad(event: PageLoadEvent): void {
  if (posthog.has_opted_out_capturing()) return;
  posthog.capture("page_data_readiness", {
    route: event.route,
    ...(event.section === undefined ? {} : { section: event.section }),
    kind: event.kind,
    durationMs: event.durationMs,
    outcome: event.outcome,
    release: typeof __COMMIT_HASH__ === "string" ? __COMMIT_HASH__ : "development",
  });
}

const API_KEY = "phc_GsvyihTLSXrWGKYYGz84m44nuT59kYEwEXNnI0JICtg";
const API_HOST = "https://us.i.posthog.com";

export function initPostHog() {
  posthog.init(API_KEY, {
    api_host: API_HOST,
    capture_pageview: false, // we capture manually on route change
    capture_pageleave: true,
    before_send: (event) => {
      if (event?.event !== "page_data_readiness") return event;
      const deviceId: unknown = posthog.get_property("$device_id");
      if (typeof deviceId !== "string" || deviceId.length === 0) {
        captureException(
          new Error("Page readiness telemetry requires the existing PostHog $device_id."),
        );
        return null;
      }
      const properties = event.properties;
      return {
        uuid: event.uuid,
        event: event.event,
        ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
        properties: {
          route: properties.route,
          ...(properties.section === undefined ? {} : { section: properties.section }),
          kind: properties.kind,
          durationMs: properties.durationMs,
          outcome: properties.outcome,
          release: properties.release,
          token: properties.token,
          distinct_id: deviceId,
          $process_person_profile: false,
        },
      };
    },
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: true,
    },
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
  const optedOut = posthog.has_opted_out_capturing();
  posthog.reset();
  if (optedOut) posthog.opt_out_capturing();
}

export function disablePostHogForAccountErasure(): void {
  posthog.reset();
  posthog.opt_out_capturing();
}
