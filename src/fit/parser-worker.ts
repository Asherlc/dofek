import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { ParsedFitActivity } from "./parser.ts";

const workerSuccessMessageSchema = z.object({
  status: z.literal("ok"),
  activity: z.custom<ParsedFitActivity>((value) => typeof value === "object" && value !== null),
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

    let settled = false;

    function cleanup(): void {
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

    worker.once("message", handleMessage);
    worker.once("error", handleError);
    worker.once("exit", handleExit);
  });
}
