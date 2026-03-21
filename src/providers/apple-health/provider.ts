import type { SyncDatabase } from "../../db/index.ts";
import type { SyncProvider, SyncResult } from "../types.ts";
import { findLatestExport, importAppleHealthFile } from "./import.ts";

export class AppleHealthProvider implements SyncProvider {
  readonly id = "apple_health";
  readonly name = "Apple Health";

  validate(): string | null {
    const dir = process.env.APPLE_HEALTH_IMPORT_DIR;
    if (!dir) return "APPLE_HEALTH_IMPORT_DIR is not set";
    return null;
  }

  async sync(db: SyncDatabase, since: Date): Promise<SyncResult> {
    const filePath = findLatestExport();
    if (!filePath) {
      return {
        provider: this.id,
        recordsSynced: 0,
        errors: [{ message: "No Apple Health export found in APPLE_HEALTH_IMPORT_DIR" }],
        duration: 0,
      };
    }

    return importAppleHealthFile(db, filePath, since);
  }
}
