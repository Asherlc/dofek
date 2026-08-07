import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  type ParsedFitRecord,
  type ParsedFitSession,
  parseFitRecord,
  parseFitSession,
} from "./parser.ts";

const FIT_DECODER_IDLE_TIMEOUT_MS = 120_000;
const MAXIMUM_STDERR_BYTES = 64 * 1024;
const FIT_FILE_TYPE_WEIGHT = 9;

export class FitDecoderError extends Error {
  override readonly name = "FitDecoderError";
}

const rawMessageSchema = z.record(z.string(), z.unknown());
const fieldOccurrenceSchema = z.object({
  messageType: z.string(),
  field: z.string(),
  occurrences: z.number().int().positive(),
});

const metadataMessageSchema = z.object({
  type: z.literal("metadata"),
  fileType: z.number().int().nonnegative().nullable(),
  fileTypeName: z.string().nullable(),
  hasWeightMessages: z.boolean(),
  session: rawMessageSchema.nullable(),
  sportName: z.string().nullable(),
  subSportName: z.string().nullable(),
  fieldOccurrences: z.array(fieldOccurrenceSchema).max(4096),
});

const recordBatchMessageSchema = z.object({
  type: z.literal("records"),
  messages: z.array(rawMessageSchema).max(250),
});

const weightBatchMessageSchema = z.object({
  type: z.literal("weights"),
  messages: z.array(rawMessageSchema).max(250),
});

const endMessageSchema = z.object({
  type: z.literal("end"),
  messageCount: z.number().int().nonnegative(),
});

const decoderMessageSchema = z.discriminatedUnion("type", [
  metadataMessageSchema,
  recordBatchMessageSchema,
  weightBatchMessageSchema,
  endMessageSchema,
]);

export interface ParsedFitWeight {
  timestamp: Date;
  weight?: number;
  percentFat?: number;
  percentHydration?: number;
  boneMass?: number;
  muscleMass?: number;
  bmi?: number;
  raw: Record<string, unknown>;
}

export interface FitStreamMetadata {
  fileType: number | null;
  fileTypeName: string | null;
  fieldOccurrences: Array<z.infer<typeof fieldOccurrenceSchema>>;
  isWeightFile: boolean;
  session: ParsedFitSession | null;
}

export interface FitStreamConsumer {
  onMetadata: (metadata: FitStreamMetadata) => Promise<void>;
  onRecordBatch: (records: ParsedFitRecord[]) => Promise<void>;
  onWeightBatch: (weights: ParsedFitWeight[]) => Promise<void>;
}

export interface FitStreamResult {
  messageCount: number;
}

function fitDecoderBinaryPath(): string {
  const installedPath = "/usr/local/bin/dofek-fit-decoder";
  if (existsSync(installedPath)) {
    return installedPath;
  }
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDirectory, "../../.build/fit-decoder/bin/dofek-fit-decoder");
}

function enumName(value: unknown, profileName: string | null): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (profileName !== null) {
    return profileName;
  }
  if (typeof value !== "number") {
    return undefined;
  }
  return `unknown_${value}`;
}

function parsedSession(
  raw: Record<string, unknown>,
  sportName: string | null,
  subSportName: string | null,
): ParsedFitSession {
  const session = parseFitSession(raw);
  return {
    ...session,
    sport: enumName(raw.sport, sportName) ?? "unknown",
    subSport: enumName(raw.sub_sport, subSportName),
    raw,
  };
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value !== "number") {
    return undefined;
  }
  return Number.isFinite(value) ? value : undefined;
}

function parsedWeight(raw: Record<string, unknown>): ParsedFitWeight {
  const timestamp = new Date(String(raw.timestamp));
  if (Number.isNaN(timestamp.getTime())) {
    throw new FitDecoderError("FIT weight message is missing a valid timestamp");
  }
  return {
    timestamp,
    weight: optionalNumber(raw.weight),
    percentFat: optionalNumber(raw.percent_fat),
    percentHydration: optionalNumber(raw.percent_hydration),
    boneMass: optionalNumber(raw.bone_mass),
    muscleMass: optionalNumber(raw.muscle_mass),
    bmi: optionalNumber(raw.bmi),
    raw,
  };
}

function parsedRecord(raw: Record<string, unknown>): ParsedFitRecord {
  const record = parseFitRecord(raw);
  if (Number.isNaN(record.recordedAt.getTime())) {
    throw new FitDecoderError("FIT record message is missing a valid timestamp");
  }
  return record;
}

function parseDecoderLine(line: string): z.infer<typeof decoderMessageSchema> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch (error) {
    throw new FitDecoderError("Native FIT decoder returned invalid JSON", { cause: error });
  }
  try {
    return decoderMessageSchema.parse(decoded);
  } catch (error) {
    throw new FitDecoderError("Native FIT decoder returned an invalid protocol message", {
      cause: error,
    });
  }
}

function writeContinue(childInput: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    childInput.write("continue\n", (error?: Error | null) => {
      if (error) {
        rejectPromise(
          new FitDecoderError("Unable to acknowledge the native FIT decoder", { cause: error }),
        );
        return;
      }
      resolvePromise();
    });
  });
}

export async function streamFitFile(
  filePath: string,
  consumer: FitStreamConsumer,
): Promise<FitStreamResult> {
  const child = spawn(fitDecoderBinaryPath(), [filePath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let timedOut = false;
  let timeoutId: NodeJS.Timeout | undefined;
  let metadataReceived = false;
  let metadataIsWeightFile: boolean | undefined;
  let endMessageCount: number | undefined;
  let consumedMessageCount = 0;

  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8", 0, MAXIMUM_STDERR_BYTES - stderr.length);
  });

  const armIdleTimeout = (): void => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, FIT_DECODER_IDLE_TIMEOUT_MS);
  };

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolvePromise, rejectPromise) => {
      child.once("error", (error) => {
        rejectPromise(
          new FitDecoderError("Unable to start the native FIT decoder", { cause: error }),
        );
      });
      child.once("exit", (code, signal) => resolvePromise({ code, signal }));
    },
  );
  void exitPromise.catch(() => undefined);

  armIdleTimeout();
  try {
    const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of lines) {
      clearTimeout(timeoutId);
      const message = parseDecoderLine(line);
      if (endMessageCount !== undefined) {
        throw new FitDecoderError(
          message.type === "end"
            ? "Native FIT decoder returned duplicate end messages"
            : `Native FIT decoder returned ${message.type} after its end message`,
        );
      }
      switch (message.type) {
        case "metadata":
          if (metadataReceived) {
            throw new FitDecoderError("Native FIT decoder returned duplicate metadata");
          }
          metadataReceived = true;
          metadataIsWeightFile =
            message.fileType === FIT_FILE_TYPE_WEIGHT || message.hasWeightMessages;
          await consumer.onMetadata({
            fileType: message.fileType,
            fileTypeName: message.fileTypeName,
            fieldOccurrences: message.fieldOccurrences,
            isWeightFile: metadataIsWeightFile,
            session: message.session
              ? parsedSession(message.session, message.sportName, message.subSportName)
              : null,
          });
          await writeContinue(child.stdin);
          armIdleTimeout();
          break;
        case "records": {
          if (!metadataReceived) {
            throw new FitDecoderError(
              "Native FIT decoder returned records before activity metadata",
            );
          }
          if (metadataIsWeightFile) {
            throw new FitDecoderError("Native FIT decoder returned records for a weight file");
          }
          const records = message.messages.map(parsedRecord);
          consumedMessageCount += records.length;
          await consumer.onRecordBatch(records);
          await writeContinue(child.stdin);
          armIdleTimeout();
          break;
        }
        case "weights": {
          if (!metadataReceived) {
            throw new FitDecoderError("Native FIT decoder returned weights before file metadata");
          }
          if (!metadataIsWeightFile) {
            throw new FitDecoderError("Native FIT decoder returned weights for an activity file");
          }
          const weights = message.messages.map(parsedWeight);
          consumedMessageCount += weights.length;
          await consumer.onWeightBatch(weights);
          await writeContinue(child.stdin);
          armIdleTimeout();
          break;
        }
        case "end":
          if (!metadataReceived) {
            throw new FitDecoderError("Native FIT decoder returned end before file metadata");
          }
          endMessageCount = message.messageCount;
          armIdleTimeout();
          break;
      }
    }
    const exit = await exitPromise;
    clearTimeout(timeoutId);
    if (timedOut) {
      throw new FitDecoderError(`Native FIT decoder was idle for ${FIT_DECODER_IDLE_TIMEOUT_MS}ms`);
    }
    if (exit.code !== 0) {
      const detail = stderr.trim() || `terminated by ${exit.signal ?? `exit code ${exit.code}`}`;
      throw new FitDecoderError(`Native FIT decoder failed: ${detail}`);
    }
    if (!metadataReceived || endMessageCount === undefined) {
      throw new FitDecoderError("Native FIT decoder exited before completing its protocol");
    }
    if (endMessageCount !== consumedMessageCount) {
      throw new FitDecoderError(
        `Native FIT decoder reported ${endMessageCount} messages after streaming ${consumedMessageCount}`,
      );
    }
    return { messageCount: consumedMessageCount };
  } catch (error) {
    clearTimeout(timeoutId);
    child.kill("SIGKILL");
    await exitPromise.catch(() => undefined);
    throw error;
  }
}
