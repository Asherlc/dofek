import { describe, expect, it } from "vitest";
import { AnalyticsBuildError, createAnalyticsBuildFailure } from "./analytics-build-error.ts";
import { buildAnalyticsFailureCaptureContext } from "./analytics-error-context.ts";

describe("buildAnalyticsFailureCaptureContext", () => {
  it("fingerprints a dbt failure by model and stable category", () => {
    const error = new AnalyticsBuildError(1, [
      createAnalyticsBuildFailure({
        name: "provider_stats",
        status: "failed",
        errorCode: "dbt_model_failed",
        message: "Code: 159 TIMEOUT_EXCEEDED",
      }),
    ]);

    expect(
      buildAnalyticsFailureCaptureContext(error, { analyticsRefreshStep: "analytics-build" }),
    ).toEqual({
      tags: {
        analyticsRefreshStep: "analytics-build",
        analyticsModel: "provider_stats",
        analyticsFailureCategory: "timeout",
        analyticsFailedModels: "provider_stats",
      },
      fingerprint: ["analytics-build", "provider_stats", "timeout"],
    });
  });

  it("does not invent model metadata for non-dbt failures", () => {
    const tags = { analyticsRefreshStep: "analytics-build" as const };
    expect(buildAnalyticsFailureCaptureContext(new Error("worker failure"), tags)).toEqual({
      tags,
    });
  });
});
