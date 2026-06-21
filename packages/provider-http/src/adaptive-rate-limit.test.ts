import { describe, expect, it } from "vitest";
import {
  admissionDelayMs,
  applyStravaQuota,
  blendObservedCooldown,
  createInitialAdaptiveState,
  decreaseThrottleMs,
  learnInferredBudget,
  parseStravaRateLimitHeaders,
  recordAdaptiveRateLimit,
  recordAdaptiveRequest,
  slideAdaptiveWindow,
} from "./adaptive-rate-limit.ts";

describe("parseStravaRateLimitHeaders", () => {
  it("parses Strava short and daily quota headers", () => {
    const headers = new Headers({
      "X-RateLimit-Limit": "100,1000",
      "X-RateLimit-Usage": "42,500",
    });
    expect(parseStravaRateLimitHeaders(headers)).toEqual({
      shortLimit: 100,
      shortUsage: 42,
      dailyLimit: 1000,
      dailyUsage: 500,
    });
  });

  it("returns null when headers are missing", () => {
    expect(parseStravaRateLimitHeaders(new Headers())).toBeNull();
  });
});

describe("adaptive rate-limit learning", () => {
  it("blends observed cooldown values toward recent observations", () => {
    expect(blendObservedCooldown(600, 300)).toBe(510);
    expect(blendObservedCooldown(null, 300)).toBe(300);
  });

  it("slides the rolling window without recomputing historical requests", () => {
    const state = createInitialAdaptiveState("whoop", "provider", null, 0);
    const withRequests = { ...state, requestCount: 12, windowStartMs: 0 };
    const slid = slideAdaptiveWindow(withRequests, 5 * 60 * 1000 + 1);
    expect(slid.requestCount).toBe(0);
    expect(slid.windowStartMs).toBe(5 * 60 * 1000 + 1);
  });

  it("records requests by incrementing the rolling tally", () => {
    const state = createInitialAdaptiveState("garmin", "provider", null, 1000);
    const next = recordAdaptiveRequest(state, 1500);
    expect(next.requestCount).toBe(1);
    expect(next.lastRequestMs).toBe(1500);
    expect(next.throttleMs).toBeLessThan(state.throttleMs);
  });

  it("learns inferred budget and increases throttle on rate limits", () => {
    const state = {
      ...createInitialAdaptiveState("whoop", "provider", null),
      requestCount: 25,
      throttleMs: 1000,
      inferredBudget: 30,
    };
    const limited = recordAdaptiveRateLimit(state, 120);
    expect(limited.inferredBudget).toBe(24);
    expect(limited.throttleMs).toBe(2000);
    expect(limited.observedCooldownSeconds).toBe(120);
  });

  it("paces Strava requests when short quota is nearly exhausted", () => {
    const state = applyStravaQuota(createInitialAdaptiveState("strava", "provider", null), {
      shortLimit: 100,
      shortUsage: 99,
      dailyLimit: 1000,
      dailyUsage: 100,
    });
    expect(admissionDelayMs(state, Date.now())).toBeGreaterThanOrEqual(state.throttleMs * 4);
  });

  it("learns a lower inferred budget from observed failures", () => {
    expect(learnInferredBudget(30, 25)).toBe(24);
    expect(learnInferredBudget(null, 10)).toBe(9);
  });

  it("decreases throttle gradually on success", () => {
    expect(decreaseThrottleMs(1000)).toBe(900);
  });
});
