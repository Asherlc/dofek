import type { ProviderDataDeletionRequestStatus } from "dofek/db/provider-data-deletion";
import { type OperationStatus, readOperationProgress } from "../lib/operation-progress.ts";

type ProgressJob = Parameters<typeof readOperationProgress>[0];

export async function readProviderDataDeletionStatus(
  request: ProviderDataDeletionRequestStatus,
  getJob: () => Promise<ProgressJob | undefined>,
): Promise<OperationStatus> {
  if (request.status === "pending") {
    return { status: "queued", message: "Provider data deletion is pending..." };
  }
  if (request.status === "completed") {
    return { status: "completed", percentage: 100, message: "Provider data deleted" };
  }
  if (request.status === "failed") {
    return {
      status: "failed",
      message: request.failureReason ?? "Provider data deletion failed",
    };
  }

  const job = await getJob();
  if (!job) {
    return { status: "queued", message: "Provider data deletion is pending..." };
  }
  const progress = await readOperationProgress(job);
  if (progress.status === "completed") {
    return { ...progress, status: "running" };
  }
  return progress;
}
