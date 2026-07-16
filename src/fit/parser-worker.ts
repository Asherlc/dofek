import { URL } from "node:url";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { ParsedFitActivity } from "./parser.ts";

const FIT_PARSER_WORKER_TIMEOUT_MS = 120_000;

const parsedFitRawRecordSchema = z.record(z.string(), z.unknown());

const parsedFitSessionSchema = z
  .object({
    sport: z.string(),
    startTime: z.instanceof(Date),
    totalElapsedTime: z.number(),
    totalTimerTime: z.number(),
    totalDistance: z.number(),
    totalCalories: z.number(),
    raw: parsedFitRawRecordSchema,
  })
  .passthrough();

const parsedFitRecordSchema = z
  .object({
    recordedAt: z.date(),
    raw: parsedFitRawRecordSchema,
  })
  .passthrough();

const parsedFitActivitySchema = z.object({
  session: parsedFitSessionSchema,
  records: z.array(parsedFitRecordSchema),
  laps: z.array(parsedFitRawRecordSchema),
  events: z.array(parsedFitRawRecordSchema),
}) satisfies z.ZodType<ParsedFitActivity>;

const workerSuccessMessageSchema = z.object({
  status: z.literal("ok"),
  activity: parsedFitActivitySchema,
});

const workerErrorMessageSchema = z.object({
  status: z.literal("error"),
  message: z.string(),
  stack: z.string().optional(),
});

const workerMessageSchema = z.discriminatedUnion("status", [
  workerSuccessMessageSchema,
  workerErrorMessageSchema,
]);

function fitParserWorkerExecArgv(): string[] {
  const execArgv: string[] = [];
  for (let argumentIndex = 0; argumentIndex < process.execArgv.length; argumentIndex++) {
    const argument = process.execArgv[argumentIndex];
    if (argument === "--import") {
      argumentIndex++;
      continue;
    }
    if (argument?.startsWith("--import=")) {
      continue;
    }
    if (argument !== undefined) {
      execArgv.push(argument);
    }
  }
  return execArgv;
}

export function parseFitFileInWorkerThread(buffer: Buffer): Promise<ParsedFitActivity> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./parser-worker-entry.ts", import.meta.url), {
      execArgv: fitParserWorkerExecArgv(),
      workerData: buffer,
    });
    const timeoutId = setTimeout(handleTimeout, FIT_PARSER_WORKER_TIMEOUT_MS);

    let settled = false;

    function cleanup(): void {
      clearTimeout(timeoutId);
      worker.off("message", handleMessage);
      worker.off("error", handleError);
      worker.off("exit", handleExit);
    }

    function settleWithResolve(activity: ParsedFitActivity): void {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate();
      resolve(activity);
    }

    function settleWithReject(error: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate();
      reject(error);
    }

    function handleMessage(message: unknown): void {
      const parsedMessage = workerMessageSchema.safeParse(message);
      if (!parsedMessage.success) {
        settleWithReject(
          new Error(
            `FIT parser worker returned an invalid message: ${parsedMessage.error.message}`,
          ),
        );
        return;
      }

      if (parsedMessage.data.status === "error") {
        const error = new Error(parsedMessage.data.message);
        error.stack = parsedMessage.data.stack;
        settleWithReject(error);
        return;
      }

      settleWithResolve(parsedMessage.data.activity);
    }

    function handleError(error: Error): void {
      settleWithReject(error);
    }

    function handleExit(code: number): void {
      if (settled) return;
      if (code !== 0) {
        settleWithReject(new Error(`FIT parser worker exited with code ${code}`));
        return;
      }
      settleWithReject(new Error("FIT parser worker exited without sending a message"));
    }

    function handleTimeout(): void {
      settleWithReject(
        new Error(`FIT parser worker timed out after ${FIT_PARSER_WORKER_TIMEOUT_MS}ms`),
      );
    }

    worker.once("message", handleMessage);
    worker.once("error", handleError);
    worker.once("exit", handleExit);
  });
}
