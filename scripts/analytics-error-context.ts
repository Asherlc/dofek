import type { AnalyticsRefreshStep } from "../src/analytics-worker.ts";
import { AnalyticsBuildError } from "./analytics-build-error.ts";

export type AnalyticsRefreshTags = {
  analyticsRefreshStep: AnalyticsRefreshStep;
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
      fingerprint: [tags.analyticsRefreshStep, "unknown", "unknown"],
    };
  }

  return {
    tags: {
      ...tags,
      analyticsModel: failure.modelName,
      analyticsFailureCategory: failure.category,
      analyticsFailedModels: error.failures.map((item) => item.modelName).join(","),
    },
    fingerprint: [tags.analyticsRefreshStep, failure.modelName, failure.category],
  };
}
