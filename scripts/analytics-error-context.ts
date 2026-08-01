import { AnalyticsBuildError } from "./analytics-build-error.ts";

export type AnalyticsRefreshTags = {
  analyticsRefreshStep: "analytics-build" | "query-cache-warm";
};

export interface AnalyticsFailureCaptureContext {
  tags: Record<string, string>;
  fingerprint?: string[];
}

export function buildAnalyticsFailureCaptureContext(
  error: unknown,
  tags: AnalyticsRefreshTags,
): AnalyticsFailureCaptureContext {
  if (!(error instanceof AnalyticsBuildError)) {
    return { tags: { ...tags } };
  }

  const failure = error.failures[0];
  if (!failure) {
    return {
      tags: { ...tags },
      fingerprint: ["analytics-build", "unknown", "unknown"],
    };
  }

  return {
    tags: {
      ...tags,
      analyticsModel: failure.modelName,
      analyticsFailureCategory: failure.category,
      analyticsFailedModels: error.failures.map((item) => item.modelName).join(","),
    },
    fingerprint: ["analytics-build", failure.modelName, failure.category],
  };
}
