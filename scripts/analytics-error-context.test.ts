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
        analyticsFailedModelCount: "1",
      },
      fingerprint: ["analytics-build", "provider_stats", "timeout"],
    });
  });

  it("bounds failed model tags and excludes skipped models", () => {
    const failures = [
      ...Array.from({ length: 12 }, (_, index) =>
        createAnalyticsBuildFailure({
          name: `failed_model_${"x".repeat(20)}_${index}`,
          status: "failed",
          errorCode: "dbt_model_failed",
          message: "database error",
        }),
      ),
      createAnalyticsBuildFailure({
        name: "skipped_dependent_model",
        status: "skipped",
        errorCode: null,
        message: "depends on failed model",
      }),
    ];
    const error = new AnalyticsBuildError(1, failures);

    const context = buildAnalyticsFailureCaptureContext(error, {
      analyticsRefreshStep: "analytics-build",
    });

    expect(context.tags.analyticsFailedModels).toHaveLength(200);
    expect(context.tags.analyticsFailedModels).toMatch(/\.\.\.$/);
    expect(context.tags.analyticsFailedModels).not.toContain("skipped_dependent_model");
    expect(context.tags.analyticsFailedModelCount).toBe("12");
  });

  it("reports zero failed models when an incomplete build only skipped models", () => {
    const error = new AnalyticsBuildError(0, [
      createAnalyticsBuildFailure({
        name: "skipped_dependent_model",
        status: "skipped",
        errorCode: null,
        message: "depends on failed model",
      }),
    ]);

    expect(
      buildAnalyticsFailureCaptureContext(error, { analyticsRefreshStep: "analytics-build" }),
    ).toEqual({
      tags: {
        analyticsRefreshStep: "analytics-build",
        analyticsModel: "skipped_dependent_model",
        analyticsFailureCategory: "skipped",
        analyticsFailedModelCount: "0",
      },
      fingerprint: ["analytics-build", "skipped_dependent_model", "skipped"],
    });
  });

  it("does not invent model metadata for non-dbt failures", () => {
    const tags = { analyticsRefreshStep: "analytics-build" as const };
    expect(buildAnalyticsFailureCaptureContext(new Error("worker failure"), tags)).toEqual({
      tags,
    });
  });

  it("uses the refresh step in the fallback fingerprint", () => {
    const error = new AnalyticsBuildError(0, []);
    const tags = { analyticsRefreshStep: "query-cache-warm" as const };

    expect(buildAnalyticsFailureCaptureContext(error, tags)).toEqual({
      tags,
      fingerprint: ["query-cache-warm", "unknown", "unknown"],
    });
  });
});
