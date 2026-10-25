import { OriginalFitRetentionError } from "./original-fit-retention-error.ts";
import {
  type FitFileImportJobResult,
  fitFileImportJobDataSchema,
  fitFileImportJobResultSchema,
  getFitFileImportQueue,
} from "./queues.ts";

interface FitFileImportBatchJob {
  getChildrenValues: () => Promise<Record<string, unknown>>;
  getIgnoredChildrenFailures: () => Promise<Record<string, string>>;
}

const MAX_AGGREGATE_ERRORS = 10;

function normalizeFitFailure(message: string): string {
  const normalized = message
    .replace(/^UnrecoverableError:\s*/, "")
    .replace(/^Failed to import FIT file .+?:/, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || "Unknown FIT import failure";
}

function groupedFitFailureErrors(messages: string[]): FitFileImportJobResult["errors"] {
  const failureCounts = new Map<string, number>();
  for (const message of messages) {
    const cause = normalizeFitFailure(message);
    failureCounts.set(cause, (failureCounts.get(cause) ?? 0) + 1);
  }

  const groups = [...failureCounts.entries()]
    .map(([cause, count]) => ({ cause, count }))
    .sort((left, right) => right.count - left.count || left.cause.localeCompare(right.cause));
  const visibleGroupCount =
    groups.length > MAX_AGGREGATE_ERRORS ? MAX_AGGREGATE_ERRORS - 1 : groups.length;
  const errors = groups.slice(0, visibleGroupCount).map(({ cause, count }) => ({
    message: `${count} FIT ${count === 1 ? "file" : "files"} failed: ${cause}`,
  }));
  const omittedGroups = groups.slice(visibleGroupCount);
  if (omittedGroups.length > 0) {
    const omittedFailureCount = omittedGroups.reduce((total, group) => total + group.count, 0);
    errors.push({
      message: `${omittedFailureCount} additional FIT file failures across ${omittedGroups.length} causes omitted`,
    });
  }
  return errors;
}

export async function processFitFileImportBatchJob(
  job: FitFileImportBatchJob,
  loadFailedChildData: (jobKey: string) => Promise<unknown> = async (jobKey) =>
    (await getFitFileImportQueue().getJob(jobKey.slice(jobKey.lastIndexOf(":") + 1)))?.data,
): Promise<FitFileImportJobResult> {
  const [childValues, ignoredChildFailures] = await Promise.all([
    job.getChildrenValues(),
    job.getIgnoredChildrenFailures(),
  ]);
  const results = Object.values(childValues).map((value) =>
    fitFileImportJobResultSchema.parse(value),
  );
  for (const childKey of Object.keys(ignoredChildFailures)) {
    const childData = fitFileImportJobDataSchema.safeParse(await loadFailedChildData(childKey));
    if (!childData.success || !childData.data.retainedArtifactKey) {
      throw new OriginalFitRetentionError(
        "Some original FIT files could not be saved. Try the import again.",
      );
    }
  }
  const failureMessages = [
    ...results.flatMap((result) => result.errors.map((error) => error.message)),
    ...Object.values(ignoredChildFailures),
  ];

  return {
    recordsSynced: results.reduce((total, result) => total + result.recordsSynced, 0),
    errors: groupedFitFailureErrors(failureMessages),
  };
}
