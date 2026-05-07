import type { WhoopClient } from "whoop-whoop/client";
import type { WhoopCycle } from "whoop-whoop/types";
import type { SyncDatabase } from "../../db/index.ts";
import type { SyncError, SyncOptions } from "../types.ts";

export type WhoopSyncContext = {
  db: SyncDatabase;
  client: WhoopClient;
  cycles: WhoopCycle[];
  providerId: string;
  since: Date;
  options?: SyncOptions;
  errors: SyncError[];
};
