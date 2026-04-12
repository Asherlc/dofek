import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import * as Sentry from "@sentry/node";
import { z } from "zod";
import { logger } from "../logger.ts";
import type { TrainingExportJobData } from "./queues.ts";

const progressSchema = z.object({
  percentage: z.number(),
  message: z.string(),
});

/** Minimal Job interface — only the subset processTrainingExportJob actually uses. */
interface TrainingExportJob {
  data: TrainingExportJobData;
  updateProgress: (data: object) => Promise<void>;
  extendLock: (duration: number) => Promise<void>;
}

/**
 * Shared directory for job files. In production, both web and worker containers
 * mount the `job_files` volume at /app/job-files. Falls back to OS temp dir for
 * local development.
 */
const JOB_FILES_DIR = process.env.JOB_FILES_DIR || join(tmpdir(), "dofek-job-files");

const TRAINING_EXPORT_DIR = join(JOB_FILES_DIR, "training-export");

/**
 * Duration (ms) to extend the job lock by when explicitly renewing.
 * Also used as the lockDuration on the training export worker in worker.ts.
 */
export const TRAINING_EXPORT_LOCK_MS = 600_000;

/** Interval (ms) between lock extension calls during the export subprocess. */
const LOCK_EXTEND_INTERVAL_MS = 60_000;

/**
 * Process a training data export job by spawning the Python export script.
 *
 * The Python script (`dofek_ml.export`) connects directly to Postgres, streams
 * sensor_sample rows via a server-side cursor, and writes Parquet using PyArrow.
 * This eliminates the previous Postgres → Node.js → DuckDB → Parquet data hop.
 *
 * Progress is communicated via JSON lines on stdout:
 *   {"percentage": 50, "message": "Exporting sensor_sample: 500000/1000000 rows"}
 */
export async function processTrainingExportJob(job: TrainingExportJob): Promise<void> {
  const { since, until } = job.data;
  const jobStart = Date.now();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required for training export");
  }

  logger.info(
    `[training-export] Starting training data export (since=${since ?? "all"}, until=${until ?? "now"})`,
  );

  const args = [
    "-m",
    "dofek_ml.export",
    "--database-url",
    databaseUrl,
    "--output-dir",
    TRAINING_EXPORT_DIR,
  ];
  if (since) {
    args.push("--since", since);
  }
  if (until) {
    args.push("--until", until);
  }

  // Extend the BullMQ lock periodically so long exports don't stall
  const lockInterval = setInterval(() => {
    job.extendLock(TRAINING_EXPORT_LOCK_MS).catch((error: unknown) => {
      logger.warn(`[training-export] Failed to extend lock: ${error}`);
    });
  }, LOCK_EXTEND_INTERVAL_MS);

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("python", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      // Read progress from stdout (JSON lines)
      const stdoutReader = createInterface({ input: child.stdout });
      stdoutReader.on("line", (line) => {
        try {
          const progress = progressSchema.parse(JSON.parse(line));
          job
            .updateProgress({ percentage: progress.percentage, message: progress.message })
            .catch((error: unknown) => {
              logger.warn(`[training-export] Failed to update progress: ${error}`);
            });
        } catch {
          // Non-JSON output from Python — log it
          logger.info(`[training-export] ${line}`);
        }
      });

      // Capture stderr for error reporting
      let stderrOutput = "";
      const stderrReader = createInterface({ input: child.stderr });
      stderrReader.on("line", (line) => {
        stderrOutput += `${line}\n`;
        logger.warn(`[training-export] stderr: ${line}`);
      });

      child.on("error", (error) => {
        reject(new Error(`Failed to spawn Python export process: ${error.message}`));
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          const errorMessage = stderrOutput.trim() || `Python export exited with code ${code}`;
          reject(new Error(errorMessage));
        }
      });
    });

    const totalMs = Date.now() - jobStart;
    logger.info(`[training-export] Export complete in ${totalMs}ms`);
  } catch (error) {
    const totalMs = Date.now() - jobStart;
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[training-export] Job failed after ${totalMs}ms: ${message}`);
    Sentry.captureException(error, { tags: { job: "training-export" } });
    throw error;
  } finally {
    clearInterval(lockInterval);
  }
}
