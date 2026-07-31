import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";

interface JobWithProgress {
  updateProgress: (data: { percentage: number; message: string }) => Promise<void>;
}

export async function reportJobProgress(
  job: JobWithProgress,
  percentage: number,
  message: string,
  warningMessage: string,
  sentryTagKey: string,
): Promise<void> {
  await job.updateProgress({ percentage, message }).catch((error: unknown) => {
    logger.warn(warningMessage, error);
    captureException(error, { tags: { [sentryTagKey]: "updateProgress" } });
  });
}
