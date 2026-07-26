import { describe, expect, it } from "vitest";
import {
  ADAPTIVE_RATE_WINDOW_MS,
  ADAPTIVE_THROTTLE_MAX_MS,
  ADAPTIVE_THROTTLE_MIN_MS,
  adaptiveRateLimitStorageKey,
  admissionDelayMs,
  applyStravaQuota,
  blendObservedCooldown,
  createInitialAdaptiveState,
  decreaseThrottleMs,
  defaultThrottleMs,
  increaseThrottleMs,
  learnInferredBudget,
  parseAdaptiveRateState,
  parseStravaRateLimitHeaders,
  recordAdaptiveRateLimit,
  recordAdaptiveRequest,
  recordAdaptiveThrottleTouch,
  serializeAdaptiveRateState,
  slideAdaptiveWindow,
  throttleDelayMs,
} from "./adaptive-rate-limit.ts";

describe("defaultThrottleMs", () => {
  it("returns provider-specific defaults", () => {
    expect(defaultThrottleMs("strava")).toBe(10_000);
    expect(defaultThrottleMs("garmin")).toBe(5_000);
    expect(defaultThrottleMs("whoop")).toBe(1_000);
    expect(defaultThrottleMs("unknown")).toBe(1_000);
  });
});

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

  it("returns null when only one header is present", () => {
    expect(
      parseStravaRateLimitHeaders(
        new Headers({
          "X-RateLimit-Limit": "100,1000",
        }),
      ),
    ).toBeNull();
  });

  it("returns null when header values are not numeric", () => {
    expect(
      parseStravaRateLimitHeaders(
        new Headers({
          "X-RateLimit-Limit": "bad,1000",
          "X-RateLimit-Usage": "1,2",
        }),
      ),
    ).toBeNull();
  });
});

describe("blendObservedCooldown", () => {
  it("blends observed cooldown values toward recent observations", () => {
    expect(blendObservedCooldown(600, 300)).toBe(510);
    expect(blendObservedCooldown(null, 300)).toBe(300);
  });

  it("returns previous value when observed seconds are non-positive", () => {
    expect(blendObservedCooldown(600, 0)).toBe(600);
    expect(blendObservedCooldown(null, -5)).toBe(-5);
  });
});

describe("slideAdaptiveWindow", () => {
  it("slides the rolling window without recomputing historical requests", () => {
    const state = createInitialAdaptiveState("whoop", "provider", null, 0);
    const withRequests = { ...state, requestCount: 12, windowStartMs: 0 };
    const slid = slideAdaptiveWindow(withRequests, ADAPTIVE_RATE_WINDOW_MS + 1);
    expect(slid.requestCount).toBe(0);
    expect(slid.windowStartMs).toBe(ADAPTIVE_RATE_WINDOW_MS + 1);
  });

  it("keeps state when the rolling window has not elapsed", () => {
    const state = createInitialAdaptiveState("whoop", "provider", null, 1000);
    const withRequests = { ...state, requestCount: 4 };
    expect(slideAdaptiveWindow(withRequests, 2000)).toBe(withRequests);
  });

  it("preserves a past request timestamp and the existing state object", () => {
    const state = {
      ...createInitialAdaptiveState("whoop", "provider", null, 0),
      lastRequestMs: 500,
      requestCount: 4,
    };

    expect(slideAdaptiveWindow(state, 1_000)).toBe(state);
  });

  it("keeps state at the exact rolling-window start", () => {
    const state = {
      ...createInitialAdaptiveState("whoop", "provider", null, 1_000),
      lastRequestMs: 1_000,
      requestCount: 4,
    };

    expect(slideAdaptiveWindow(state, 1_000)).toBe(state);
  });

  it("slides the rolling window at the exact duration boundary", () => {
    const state = {
      ...createInitialAdaptiveState("whoop", "provider", null, 1_000),
      requestCount: 4,
    };

    expect(slideAdaptiveWindow(state, ADAPTIVE_RATE_WINDOW_MS + 1_000)).toEqual({
      ...state,
      requestCount: 0,
      windowStartMs: ADAPTIVE_RATE_WINDOW_MS + 1_000,
    });
  });

  it("does not slide a window whose start makes the elapsed duration remain in range", () => {
    const state = {
      ...createInitialAdaptiveState("whoop", "provider", null, 1_000),
      requestCount: 4,
    };

    expect(slideAdaptiveWindow(state, ADAPTIVE_RATE_WINDOW_MS + 999)).toBe(state);
  });

  it("rebases only a future request timestamp inside the current window", () => {
    const state = {
      ...createInitialAdaptiveState("whoop", "provider", null, 0),
      lastRequestMs: 9_000,
      requestCount: 4,
    };

    expect(slideAdaptiveWindow(state, 1_000)).toEqual({
      ...state,
      lastRequestMs: 1_000,
    });
  });

  it("rebases future timestamps after a backward clock adjustment", () => {
    const state = {
      ...createInitialAdaptiveState("whoop", "provider", null, 10_000),
      lastRequestMs: 9_000,
      requestCount: 4,
    };

    expect(slideAdaptiveWindow(state, 1_000)).toEqual({
      ...state,
      lastRequestMs: 1_000,
      windowStartMs: 1_000,
    });
  });
});

describe("throttle adjustment helpers", () => {
  it("decreases throttle gradually on success without dropping below the minimum", () => {
    expect(decreaseThrottleMs(1000)).toBe(900);
    expect(decreaseThrottleMs(ADAPTIVE_THROTTLE_MIN_MS)).toBe(ADAPTIVE_THROTTLE_MIN_MS);
  });

  it("increases throttle on rate limits without exceeding the maximum", () => {
    expect(increaseThrottleMs(1000)).toBe(2000);
    expect(increaseThrottleMs(ADAPTIVE_THROTTLE_MAX_MS)).toBe(ADAPTIVE_THROTTLE_MAX_MS);
  });
});

describe("learnInferredBudget", () => {
  it("learns a lower inferred budget from observed failures", () => {
    expect(learnInferredBudget(30, 25)).toBe(24);
    expect(learnInferredBudget(null, 10)).toBe(9);
  });

  it("returns the current budget when no requests were observed at the limit", () => {
    expect(learnInferredBudget(30, 0)).toBe(30);
    expect(learnInferredBudget(null, 0)).toBeNull();
  });

  it("uses the provider default budget when samples are too sparse for step-chain sync", () => {
    expect(learnInferredBudget(null, 3, "whoop")).toBe(40);
    expect(learnInferredBudget(40, 5, "whoop")).toBe(40);
  });
});

describe("admissionDelayMs", () => {
  it("waits for the remaining throttle interval after the last request", () => {
    const state = {
      ...createInitialAdaptiveState("whoop", "provider", null, 0),
      throttleMs: 1000,
      lastRequestMs: 100,
    };
    expect(admissionDelayMs(state, 500)).toBe(600);
  });

  it("waits for the remaining adaptive window when the inferred budget soft cap is reached", () => {
    const state = {
      ...createInitialAdaptiveState("garmin", "provider", null, 0),
      throttleMs: 1000,
      inferredBudget: 10,
      requestCount: 8,
    };
    expect(admissionDelayMs(state, 1_000)).toBe(ADAPTIVE_RATE_WINDOW_MS - 1_000);
    expect(admissionDelayMs(state, ADAPTIVE_RATE_WINDOW_MS)).toBe(0);
  });

  it("bounds inferred-budget waits when the clock moves behind the window start", () => {
    const state = {
      ...createInitialAdaptiveState("garmin", "provider", null, 10_000),
      inferredBudget: 10,
      requestCount: 8,
    };
    expect(admissionDelayMs(state, 1_000)).toBe(ADAPTIVE_RATE_WINDOW_MS);
  });

  it("paces step-chain providers by sync job rather than raw HTTP call count", () => {
    const state = {
      ...createInitialAdaptiveState("whoop", "provider", null, 0),
      throttleMs: 1000,
      inferredBudget: 40,
      requestCount: 20,
    };
    expect(admissionDelayMs(state, 0)).toBe(0);

    const throttled = { ...state, requestCount: 30 };
    expect(admissionDelayMs(throttled, 0)).toBe(ADAPTIVE_RATE_WINDOW_MS);
  });

  it("derives throttle delay independently from budget pacing", () => {
    const state = {
      ...createInitialAdaptiveState("garmin", "provider", null, 0),
      throttleMs: 2_000,
      lastRequestMs: 500,
      inferredBudget: 40,
      requestCount: 1,
    };
    expect(throttleDelayMs(state, 1_000)).toBe(1_500);
    expect(admissionDelayMs(state, 1_000)).toBe(1_500);
  });

  it("returns no throttle delay after the interval has elapsed", () => {
    const state = {
      ...createInitialAdaptiveState("garmin", "provider", null, 0),
      throttleMs: 1_000,
      lastRequestMs: 100,
    };
    expect(throttleDelayMs(state, 1_500)).toBe(0);
  });

  it("paces Strava requests when short quota is nearly exhausted", () => {
    const state = applyStravaQuota(
      {
        ...createInitialAdaptiveState("strava", "provider", null, 0),
        lastRequestMs: 0,
      },
      {
        shortLimit: 100,
        shortUsage: 99,
        dailyLimit: 1000,
        dailyUsage: 100,
      },
    );
    expect(admissionDelayMs(state, 0)).toBe(state.throttleMs * 4);
    expect(admissionDelayMs(state, state.throttleMs * 4)).toBe(0);
  });

  it("uses the nearly-exhausted Strava tier when exactly two requests remain", () => {
    const state = applyStravaQuota(
      {
        ...createInitialAdaptiveState("strava", "provider", null, 0),
        lastRequestMs: 0,
      },
      {
        shortLimit: 100,
        shortUsage: 98,
        dailyLimit: 1000,
        dailyUsage: 100,
      },
    );
    expect(admissionDelayMs(state, 0)).toBe(state.throttleMs * 4);
  });

  it("doubles Strava pacing delay when only a few short-quota requests remain", () => {
    const state = applyStravaQuota(
      {
        ...createInitialAdaptiveState("strava", "provider", null, 0),
        lastRequestMs: 0,
      },
      {
        shortLimit: 100,
        shortUsage: 97,
        dailyLimit: 1000,
        dailyUsage: 100,
      },
    );
    expect(admissionDelayMs(state, 0)).toBe(state.throttleMs * 2);
    expect(admissionDelayMs(state, state.throttleMs * 2)).toBe(0);
  });

  it("uses the low-headroom Strava tier when exactly five requests remain", () => {
    const state = applyStravaQuota(
      {
        ...createInitialAdaptiveState("strava", "provider", null, 0),
        lastRequestMs: 0,
      },
      {
        shortLimit: 100,
        shortUsage: 95,
        dailyLimit: 1000,
        dailyUsage: 100,
      },
    );
    expect(admissionDelayMs(state, 0)).toBe(state.throttleMs * 2);
  });

  it("paces Strava requests proportionally when quota headroom remains", () => {
    const state = applyStravaQuota(
      {
        ...createInitialAdaptiveState("strava", "provider", null, 0),
        lastRequestMs: 0,
      },
      {
        shortLimit: 100,
        shortUsage: 50,
        dailyLimit: 1000,
        dailyUsage: 100,
      },
    );
    expect(admissionDelayMs(state, 0)).toBe(18_000);
    expect(admissionDelayMs(state, 17_500)).toBe(500);
    expect(admissionDelayMs(state, 18_000)).toBe(0);
  });

  it("subtracts elapsed time from Strava quota pacing with nonzero timestamps", () => {
    const state = applyStravaQuota(
      {
        ...createInitialAdaptiveState("strava", "provider", null, 0),
        lastRequestMs: 1_000,
      },
      {
        shortLimit: 100,
        shortUsage: 50,
        dailyLimit: 1000,
        dailyUsage: 100,
      },
    );
    expect(admissionDelayMs(state, 5_000)).toBe(14_000);
  });

  it("admits Strava immediately when no prior request timestamp exists", () => {
    const state = applyStravaQuota(createInitialAdaptiveState("strava", "provider", null, 0), {
      shortLimit: 100,
      shortUsage: 50,
      dailyLimit: 1000,
      dailyUsage: 100,
    });
    expect(admissionDelayMs(state, 5_000)).toBe(0);
  });

  it("requires both Strava short-quota fields before applying quota pacing", () => {
    const initial = {
      ...createInitialAdaptiveState("strava", "provider", null, 0),
      lastRequestMs: 0,
      throttleMs: 1_000,
    };
    expect(
      admissionDelayMs(
        {
          ...initial,
          stravaShortLimit: null,
          stravaShortUsage: 99,
        },
        0,
      ),
    ).toBe(initial.throttleMs);
    expect(
      admissionDelayMs(
        {
          ...initial,
          stravaShortLimit: 100,
          stravaShortUsage: null,
        },
        0,
      ),
    ).toBe(initial.throttleMs);
  });

  it("ignores Strava pacing for non-Strava providers", () => {
    const state = {
      ...createInitialAdaptiveState("garmin", "provider", null),
      stravaShortLimit: 100,
      stravaShortUsage: 99,
    };
    expect(admissionDelayMs(state, 0)).toBe(0);
  });
});

describe("createInitialAdaptiveState", () => {
  it("creates user-scoped state with the provided user id", () => {
    const state = createInitialAdaptiveState("whoop", "user", "user-1", 1234);
    expect(state).toMatchObject({
      providerId: "whoop",
      scope: "user",
      userId: "user-1",
      windowStartMs: 1234,
      requestCount: 0,
      throttleMs: 1000,
      inferredBudget: 40,
    });
  });

  it("seeds step-chain providers with a default inferred budget", () => {
    const state = createInitialAdaptiveState("whoop", "provider", null);
    expect(state.inferredBudget).toBe(40);
  });
});

describe("applyStravaQuota", () => {
  it("stores parsed Strava quota fields on the adaptive state", () => {
    const state = applyStravaQuota(createInitialAdaptiveState("strava", "provider", null), {
      shortLimit: 100,
      shortUsage: 10,
      dailyLimit: 1000,
      dailyUsage: 20,
    });
    expect(state).toMatchObject({
      stravaShortLimit: 100,
      stravaShortUsage: 10,
      stravaDailyLimit: 1000,
      stravaDailyUsage: 20,
    });
  });
});

describe("recordAdaptiveRequest", () => {
  it("records requests by incrementing the rolling tally", () => {
    const state = createInitialAdaptiveState("garmin", "provider", null, 1000);
    const next = recordAdaptiveRequest(state, 1500);
    expect(next.requestCount).toBe(1);
    expect(next.lastRequestMs).toBe(1500);
    expect(next.throttleMs).toBeLessThan(state.throttleMs);
  });
});

describe("recordAdaptiveThrottleTouch", () => {
  it("updates throttle timing without consuming a sync-step budget slot", () => {
    const state = createInitialAdaptiveState("garmin", "provider", null, 1000);
    const next = recordAdaptiveThrottleTouch(state, 1500);
    expect(next.requestCount).toBe(0);
    expect(next.lastRequestMs).toBe(1500);
    expect(next.throttleMs).toBeLessThan(state.throttleMs);
  });
});

describe("recordAdaptiveRateLimit", () => {
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

  it("preserves observed cooldown when retry-after is absent or zero", () => {
    const state = {
      ...createInitialAdaptiveState("whoop", "provider", null),
      observedCooldownSeconds: 240,
      requestCount: 5,
    };
    expect(recordAdaptiveRateLimit(state, null).observedCooldownSeconds).toBe(240);
    expect(recordAdaptiveRateLimit(state, 0).observedCooldownSeconds).toBe(240);
  });
});

describe("adaptiveRateLimitStorageKey", () => {
  it("builds provider and user scoped keys", () => {
    expect(adaptiveRateLimitStorageKey("garmin", "provider", null)).toBe(
      "provider-adaptive-rate:garmin:provider",
    );
    expect(adaptiveRateLimitStorageKey("whoop", "user", "user-1")).toBe(
      "provider-adaptive-rate:whoop:user:user-1",
    );
    expect(adaptiveRateLimitStorageKey("whoop", "user", null)).toBe(
      "provider-adaptive-rate:whoop:user:unknown",
    );
  });
});

describe("serializeAdaptiveRateState", () => {
  it("serializes adaptive state as JSON", () => {
    const state = createInitialAdaptiveState("strava", "provider", null);
    expect(JSON.parse(serializeAdaptiveRateState(state))).toEqual(state);
  });
});

describe("parseAdaptiveRateState", () => {
  it("returns null for empty input", () => {
    expect(parseAdaptiveRateState(null)).toBeNull();
    expect(parseAdaptiveRateState("")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseAdaptiveRateState("{not-json")).toBeNull();
  });

  it("parses valid persisted state with optional Strava fields", () => {
    const state = {
      ...createInitialAdaptiveState("strava", "provider", null),
      inferredBudget: 35,
      observedCooldownSeconds: 90,
      stravaShortLimit: 100,
      stravaShortUsage: 80,
      stravaDailyLimit: 1000,
      stravaDailyUsage: 400,
    };
    const parsed = parseAdaptiveRateState(serializeAdaptiveRateState(state));
    expect(parsed).toEqual(state);
  });

  it("rejects invalid scope and numeric fields", () => {
    expect(
      parseAdaptiveRateState(
        JSON.stringify({
          providerId: "garmin",
          scope: "invalid",
          userId: null,
          windowStartMs: 1,
          requestCount: 0,
          throttleMs: 1,
          lastRequestMs: null,
        }),
      ),
    ).toBeNull();
    expect(
      parseAdaptiveRateState(
        JSON.stringify({
          providerId: 1,
          scope: "provider",
          userId: null,
          windowStartMs: 1,
          requestCount: 0,
          throttleMs: 1,
          lastRequestMs: null,
        }),
      ),
    ).toBeNull();
    expect(
      parseAdaptiveRateState(
        JSON.stringify({
          providerId: "garmin",
          scope: "provider",
          userId: null,
          windowStartMs: "bad",
          requestCount: 0,
          throttleMs: 1,
          lastRequestMs: null,
        }),
      ),
    ).toBeNull();
  });

  it("rejects invalid userId and lastRequestMs", () => {
    expect(
      parseAdaptiveRateState(
        JSON.stringify({
          providerId: "whoop",
          scope: "user",
          userId: 42,
          windowStartMs: 1,
          requestCount: 0,
          throttleMs: 1,
          lastRequestMs: null,
        }),
      ),
    ).toBeNull();
    expect(
      parseAdaptiveRateState(
        JSON.stringify({
          providerId: "garmin",
          scope: "provider",
          userId: null,
          windowStartMs: 1,
          requestCount: 0,
          throttleMs: 1,
          lastRequestMs: "now",
        }),
      ),
    ).toBeNull();
  });

  it("drops non-finite optional numeric fields", () => {
    const parsed = parseAdaptiveRateState(
      JSON.stringify({
        providerId: "garmin",
        scope: "provider",
        userId: null,
        windowStartMs: 1,
        requestCount: 0,
        throttleMs: 1,
        lastRequestMs: null,
        inferredBudget: "lots",
        observedCooldownSeconds: "slow",
        stravaShortLimit: "x",
        stravaShortUsage: "y",
        stravaDailyLimit: "z",
        stravaDailyUsage: "w",
      }),
    );
    expect(parsed?.inferredBudget).toBeNull();
    expect(parsed?.observedCooldownSeconds).toBeNull();
    expect(parsed?.stravaShortLimit).toBeNull();
  });
});
