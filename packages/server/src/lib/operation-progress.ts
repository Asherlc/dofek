import { z } from "zod";

export const operationProgressSchema = z.object({
  percentage: z.number().min(0).max(100).optional(),
  message: z.string().min(1).optional(),
});

export const operationStatusSchema = z.enum(["queued", "running", "completed", "failed"]);

export const operationStatusOutputSchema = operationProgressSchema.extend({
  status: operationStatusSchema,
});

export type OperationStatus = z.infer<typeof operationStatusOutputSchema>;

interface ProgressJob {
  failedReason?: string;
  getState(): Promise<string>;
  progress: unknown;
}

function mapBullMqState(state: string): OperationStatus["status"] {
  switch (state) {
    case "waiting":
    case "waiting-children":
    case "delayed":
      return "queued";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "running";
  }
}

export async function readOperationProgress(job: ProgressJob): Promise<OperationStatus> {
  const status = mapBullMqState(await job.getState());
  const normalizedProgress =
    typeof job.progress === "number" ? { percentage: job.progress } : job.progress;
  const parsedProgress = operationProgressSchema.safeParse(normalizedProgress);
  const progress = parsedProgress.success ? parsedProgress.data : {};

  if (status === "failed") {
    return {
      status,
      ...progress,
      ...(job.failedReason ? { message: job.failedReason } : {}),
    };
  }

  if (status === "completed" && !progress.message) {
    return { status, percentage: progress.percentage, message: "Operation complete" };
  }

  return { status, ...progress };
}
