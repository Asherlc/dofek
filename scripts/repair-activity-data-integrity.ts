import { parseArgs } from "node:util";
import * as Sentry from "@sentry/node";
import { z } from "zod";
import {
  ACTIVITY_INTEGRITY_MAX_ACCEPTANCE_WINDOW_MS,
  type ActivityIntegrityRepairOptions,
  repairActivityDataIntegrity,
  retireActivityDataIntegrityArtifact,
  rollbackActivityDataIntegrity,
} from "../src/db/activity-data-integrity-repair.ts";
import { createClickHouseClientFromEnv } from "../src/db/clickhouse.ts";
import { createDatabaseFromEnv } from "../src/db/index.ts";
import { captureException } from "../src/lib/error-reporting.ts";

type ActivityDataIntegrityCommand =
  | { kind: "repair"; options: ActivityIntegrityRepairOptions }
  | { kind: "rollback"; artifactPath: string }
  | {
      kind: "retire";
      artifactPath: string;
      acceptedBy: string;
      disposition: "accepted" | "superseded";
    };

function requiredText(value: string | undefined, option: string): string {
  return z
    .string({ error: `${option} is required` })
    .trim()
    .min(1, `${option} is required`)
    .parse(value);
}

function positiveInteger(value: string | undefined, option: string, fallback: number): number {
  return z.coerce
    .number({ error: `${option} must be a positive integer` })
    .int(`${option} must be a positive integer`)
    .positive(`${option} must be a positive integer`)
    .default(fallback)
    .parse(value);
}

function utcDate(value: string | undefined, option: string): Date {
  return z
    .string({ error: `${option} is required` })
    .trim()
    .min(1, `${option} is required`)
    .refine((timestamp) => /(?:Z|\+00:?00)$/i.test(timestamp), `${option} must use UTC`)
    .pipe(z.iso.datetime({ offset: true, error: `${option} must be a valid timestamp` }))
    .transform((timestamp) => new Date(timestamp))
    .parse(value);
}

const commandModeSchema = z
  .object({
    rollbackRequested: z.boolean(),
    retirementRequested: z.boolean(),
    repairArgumentsPresent: z.boolean(),
  })
  .superRefine((selection, context) => {
    if (selection.rollbackRequested && selection.retirementRequested) {
      context.addIssue({
        code: "custom",
        message: "--rollback-artifact and --retire-artifact cannot be combined",
      });
    }
    if (
      (selection.rollbackRequested || selection.retirementRequested) &&
      selection.repairArgumentsPresent
    ) {
      context.addIssue({
        code: "custom",
        message: "artifact operations cannot be combined with repair options",
      });
    }
  });

export function parseActivityDataIntegrityCommand(
  args: readonly string[],
  now = new Date(),
): ActivityDataIntegrityCommand {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      "user-id": { type: "string" },
      "start-at": { type: "string" },
      "end-at": { type: "string" },
      execute: { type: "boolean", default: false },
      "batch-size": { type: "string" },
      "max-batches": { type: "string" },
      "artifact-directory": { type: "string" },
      "acceptance-owner": { type: "string" },
      "acceptance-deadline": { type: "string" },
      "rollback-artifact": { type: "string" },
      "retire-artifact": { type: "string" },
      "accepted-by": { type: "string" },
      disposition: { type: "string" },
    },
  });

  const rollbackRequested = values["rollback-artifact"] != null;
  const retirementRequested = values["retire-artifact"] != null;
  const repairArgumentsPresent =
    values["user-id"] != null ||
    values["start-at"] != null ||
    values["end-at"] != null ||
    values.execute ||
    values["batch-size"] != null ||
    values["max-batches"] != null ||
    values["artifact-directory"] != null ||
    values["acceptance-owner"] != null ||
    values["acceptance-deadline"] != null;
  commandModeSchema.parse({ rollbackRequested, retirementRequested, repairArgumentsPresent });
  if (rollbackRequested || retirementRequested) {
    if (rollbackRequested) {
      if (values["accepted-by"] || values.disposition) {
        throw new Error("rollback cannot be combined with retirement options");
      }
      return {
        kind: "rollback",
        artifactPath: requiredText(values["rollback-artifact"], "--rollback-artifact"),
      };
    }
    const disposition = values.disposition ?? "accepted";
    if (disposition !== "accepted" && disposition !== "superseded") {
      throw new Error("--disposition must be accepted or superseded");
    }
    return {
      kind: "retire",
      artifactPath: requiredText(values["retire-artifact"], "--retire-artifact"),
      acceptedBy: requiredText(values["accepted-by"], "--accepted-by"),
      disposition,
    };
  }
  if (values["accepted-by"] || values.disposition) {
    throw new Error("retirement options require --retire-artifact");
  }

  const startAt = utcDate(values["start-at"], "--start-at");
  const endAt = utcDate(values["end-at"], "--end-at");
  if (startAt >= endAt) throw new Error("--start-at must be earlier than --end-at");
  const userId = requiredText(values["user-id"], "--user-id");
  const baseOptions: ActivityIntegrityRepairOptions = {
    userId,
    startAt,
    endAt,
    execute: values.execute,
    batchSize: positiveInteger(values["batch-size"], "--batch-size", 250),
    maxBatches: positiveInteger(values["max-batches"], "--max-batches", 20),
  };
  if (!values.execute) {
    return {
      kind: "repair",
      options: {
        ...baseOptions,
        ...(values["artifact-directory"]
          ? { artifactDirectory: values["artifact-directory"] }
          : {}),
      },
    };
  }
  if (!values["acceptance-owner"]?.trim()) {
    throw new Error("--acceptance-owner is required with --execute");
  }
  const artifactDirectory = values["artifact-directory"]?.trim();
  if (!artifactDirectory) throw new Error("--artifact-directory is required with --execute");
  const acceptanceOwner = values["acceptance-owner"].trim();
  const acceptanceDeadline = utcDate(values["acceptance-deadline"], "--acceptance-deadline");
  if (acceptanceDeadline <= now) throw new Error("--acceptance-deadline must be in the future");
  if (acceptanceDeadline.getTime() - now.getTime() > ACTIVITY_INTEGRITY_MAX_ACCEPTANCE_WINDOW_MS) {
    throw new Error("--acceptance-deadline must be within 24 hours");
  }
  return {
    kind: "repair",
    options: {
      ...baseOptions,
      acceptanceOwner,
      acceptanceDeadline,
      artifactDirectory,
    },
  };
}

function initializeSentry(): void {
  const sentryDsn = process.env.SENTRY_DSN || process.env.SENTRY_DSN_unencrypted;
  if (sentryDsn) Sentry.init({ dsn: sentryDsn, skipOpenTelemetrySetup: true });
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  initializeSentry();
  try {
    const command = parseActivityDataIntegrityCommand(args);
    const db = createDatabaseFromEnv();
    if (command.kind === "retire") {
      try {
        const receiptPath = await retireActivityDataIntegrityArtifact(db, command.artifactPath, {
          acceptedBy: command.acceptedBy,
          disposition: command.disposition,
        });
        console.log(JSON.stringify({ kind: "retire", receiptPath }));
      } finally {
        await db.$client.end();
      }
      return;
    }

    const clickHouse = createClickHouseClientFromEnv();
    try {
      if (command.kind === "rollback") {
        const result = await rollbackActivityDataIntegrity(db, clickHouse, command.artifactPath);
        console.log(JSON.stringify({ kind: "rollback", ...result }));
        return;
      }
      const result = await repairActivityDataIntegrity(db, clickHouse, command.options);
      console.log(
        JSON.stringify({
          kind: command.options.execute ? "execute" : "dry-run",
          ...result,
        }),
      );
      if (!command.options.execute) {
        console.log(
          "[activity-data-integrity] dry run only; add --execute with acceptance ownership to write",
        );
      }
    } finally {
      await clickHouse.close?.();
      await db.$client.end();
    }
  } catch (error: unknown) {
    captureException(error);
    throw error;
  } finally {
    await Sentry.close(2_000);
  }
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isDirectExecution) {
  main().catch((error: unknown) => {
    console.error(`[activity-data-integrity] ${error}`);
    process.exit(1);
  });
}
