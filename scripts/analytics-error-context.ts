import type { AnalyticsRefreshStep } from "../src/analytics-worker.ts";
import { AnalyticsBuildError } from "./analytics-build-error.ts";

const MAX_SENTRY_TAG_VALUE_LENGTH = 200;

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

  const failure = error.failures.find((item) => item.status === "failed") ?? error.failures[0];
  if (!failure) {
    return {
      tags: { ...tags },
      fingerprint: [tags.analyticsRefreshStep, "unknown", "unknown"],
    };
  }

  const failedModelNames = error.failures
    .filter((item) => item.status === "failed")
    .map((item) => item.modelName);
  const failedModelsTag = failedModelNames.join(",");
  const boundedFailedModelsTag =
    failedModelsTag.length <= MAX_SENTRY_TAG_VALUE_LENGTH
      ? failedModelsTag
      : `${failedModelsTag.slice(0, MAX_SENTRY_TAG_VALUE_LENGTH - 3)}...`;
  const failureTags: Record<string, string> = {
    ...tags,
    analyticsModel: failure.modelName,
    analyticsFailureCategory: failure.category,
    analyticsFailedModelCount: String(failedModelNames.length),
  };
  if (boundedFailedModelsTag) {
    failureTags.analyticsFailedModels = boundedFailedModelsTag;
  }

  return {
    tags: failureTags,
    fingerprint: [tags.analyticsRefreshStep, failure.modelName, failure.category],
  };
}
