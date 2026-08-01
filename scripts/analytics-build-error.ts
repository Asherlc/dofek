import type { DbtModelResult } from "../src/processing/dbt-run-results.ts";

export type AnalyticsFailureCategory =
  | "timeout"
  | "overflow"
  | "memory"
  | "syntax"
  | "dependency"
  | "skipped"
  | "unknown";

export type AnalyticsBuildErrorReason = "process-failed" | "incomplete";

export interface AnalyticsBuildFailure {
  modelName: string;
  status: DbtModelResult["status"];
  errorCode: string | null;
  message: string | null;
  category: AnalyticsFailureCategory;
}

function failureText(
  errorCode: string | null | undefined,
  message: string | null | undefined,
): string {
  return [errorCode, message].filter((value): value is string => Boolean(value)).join(" ");
}

export function classifyAnalyticsFailure(
  errorCode: string | null | undefined,
  message: string | null | undefined,
  status: DbtModelResult["status"] = "failed",
): AnalyticsFailureCategory {
  if (status === "skipped") {
    return "skipped";
  }

  const text = failureText(errorCode, message);
  if (/\b(?:code\s*:?\s*159|timeout(?:_exceeded)?|timed out)\b/i.test(text)) {
    return "timeout";
  }
  if (/\b(?:code\s*:?\s*407|convert overflow|overflow)\b/i.test(text)) {
    return "overflow";
  }
  if (/\b(?:code\s*:?\s*241|memory(?:_limit_exceeded)?|out of memory)\b/i.test(text)) {
    return "memory";
  }
  if (/\b(?:code\s*:?\s*62|syntax[_ ]error|parser error)\b/i.test(text)) {
    return "syntax";
  }
  if (
    /\b(?:code\s*:?\s*(?:47|60|81)|unknown_(?:table|database|identifier)|unknown (?:table|database|identifier)|table .* not found|no such table)\b/i.test(
      text,
    )
  ) {
    return "dependency";
  }
  return "unknown";
}

export function createAnalyticsBuildFailure(
  model: Pick<DbtModelResult, "name" | "status" | "errorCode" | "message">,
): AnalyticsBuildFailure {
  return {
    modelName: model.name,
    status: model.status,
    errorCode: model.errorCode,
    message: model.message,
    category: classifyAnalyticsFailure(model.errorCode, model.message, model.status),
  };
}

export class AnalyticsBuildError extends Error {
  readonly exitCode: number;
  readonly failures: readonly AnalyticsBuildFailure[];
  readonly reason: AnalyticsBuildErrorReason;

  constructor(
    exitCode: number,
    failures: readonly AnalyticsBuildFailure[],
    reason: AnalyticsBuildErrorReason = exitCode === 0 ? "incomplete" : "process-failed",
  ) {
    const detail = failures
      .map(
        (failure) =>
          `${failure.modelName}: ${failure.message ?? failure.errorCode ?? failure.status}`,
      )
      .join("; ");
    const summary =
      reason === "incomplete"
        ? "dbt build did not complete every required analytics model"
        : `dbt build failed with exit code ${exitCode}`;
    super(`${summary}${detail ? `: ${detail}` : ""}`);
    this.name = "AnalyticsBuildError";
    this.exitCode = exitCode;
    this.failures = [...failures];
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
