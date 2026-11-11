import { z } from "zod";
import {
  persistClimbingLogEntries,
  type SourceClimbingLogEntry,
} from "../../db/climbing-log-sync.ts";
import type { SyncDatabase } from "../../db/index.ts";
import { captureException } from "../../lib/error-reporting.ts";

export async function writeClimbingRecords(
  database: SyncDatabase,
  userId: string,
  providerId: string,
  records: readonly SourceClimbingLogEntry[],
): Promise<number> {
  try {
    const written = await persistClimbingLogEntries(database, {
      userId,
      providerId,
      entries: records,
    });
    return written.recordsSynced;
  } catch (error) {
    // Drizzle query errors include the complete bound logbook payload.
    const sanitized = new Error(
      "theCrag could not save your logbook. Try again or contact support.",
    );
    const postgresCode = z
      .object({ code: z.string().regex(/^[0-9A-Z]{5}$/) })
      .safeParse(error instanceof Error ? (error.cause ?? error) : error);
    captureException(sanitized, {
      tags: {
        provider: providerId,
        phase: "logbook_save",
        ...(postgresCode.success ? { postgresCode: postgresCode.data.code } : {}),
      },
    });
    throw sanitized;
  }
}
