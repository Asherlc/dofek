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

    worker.once("message", (message: unknown) => {
      const parsedMessage = workerMessageSchema.safeParse(message);
      if (!parsedMessage.success) {
        reject(
          new Error(
            `FIT parser worker returned an invalid message: ${parsedMessage.error.message}`,
          ),
        );
        return;
      }

      if (parsedMessage.data.status === "error") {
        const error = new Error(parsedMessage.data.message);
        error.stack = parsedMessage.data.stack;
        reject(error);
        return;
      }

      resolve(parsedMessage.data.activity);
    });

    worker.once("error", reject);

    worker.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`FIT parser worker exited with code ${code}`));
      }
    });
  });
}
