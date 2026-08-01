import { describe, expect, it } from "vitest";
import {
  AnalyticsBuildError,
  classifyAnalyticsFailure,
  createAnalyticsBuildFailure,
} from "./analytics-build-error.ts";

describe("analytics build failures", () => {
  it("classifies stable ClickHouse timeout and overflow categories", () => {
    expect(classifyAnalyticsFailure("dbt_model_failed", "Code: 159 TIMEOUT_EXCEEDED")).toBe(
      "timeout",
    );
    expect(classifyAnalyticsFailure("dbt_model_failed", "Code: 407 Convert overflow")).toBe(
      "overflow",
    );
  });

  it("keeps model and category metadata on the thrown build error", () => {
    const failure = createAnalyticsBuildFailure({
      name: "provider_stats",
      status: "failed",
      errorCode: "dbt_model_failed",
      message: "Code: 159 TIMEOUT_EXCEEDED after 240 seconds",
    });

    const error = new AnalyticsBuildError(1, [failure]);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("provider_stats: Code: 159 TIMEOUT_EXCEEDED");
    expect(error.failures).toEqual([
      {
        modelName: "provider_stats",
        status: "failed",
        errorCode: "dbt_model_failed",
        message: "Code: 159 TIMEOUT_EXCEEDED after 240 seconds",
        category: "timeout",
      },
    ]);
  });
});
