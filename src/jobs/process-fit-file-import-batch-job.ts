import { z } from "zod";
import type { FitFileImportJobResult } from "./process-fit-file-import-job.ts";

interface FitFileImportBatchJob {
  getChildrenValues: () => Promise<Record<string, unknown>>;
}

const fitFileImportJobResultSchema = z.object({
  recordsSynced: z.number(),
  errors: z.array(z.object({ message: z.string() })),
});

export async function processFitFileImportBatchJob(
  job: FitFileImportBatchJob,
): Promise<FitFileImportJobResult> {
  const childValues = await job.getChildrenValues();
  const results = Object.values(childValues).map((value) =>
    fitFileImportJobResultSchema.parse(value),
  );

  return {
    recordsSynced: results.reduce((total, result) => total + result.recordsSynced, 0),
    errors: results.flatMap((result) => result.errors),
  };
}
