import { persistClimbingLogEntries } from "../../db/climbing-log-sync.ts";
import type { SyncDatabase } from "../../db/index.ts";
import { ensureProvider } from "../../db/tokens.ts";
import type { ImportProvider, SyncResult } from "../types.ts";
import { parseEightAExport } from "./parser.ts";

export class EightAProvider implements ImportProvider {
  readonly id = "eight-a";
  readonly name = "8a.nu / Vertical-Life";
  readonly importOnly = true as const;
  validate(): string | null {
    return null;
  }
}

export async function importEightAExportFile(
  db: SyncDatabase,
  csvText: string,
  userId: string,
): Promise<SyncResult> {
  const startedAt = Date.now();
  const entries = parseEightAExport(csvText);
  const result = await db.transaction(async (tx) => {
    await ensureProvider(tx, "eight-a", "8a.nu / Vertical-Life", undefined, userId);
    return persistClimbingLogEntries(tx, { userId, providerId: "eight-a", entries });
  });
  return {
    provider: "eight-a",
    recordsSynced: result.recordsSynced,
    errors: [],
    duration: Date.now() - startedAt,
  };
}
