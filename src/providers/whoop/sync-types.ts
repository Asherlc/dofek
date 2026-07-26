import type { WhoopClient } from "@dofek/whoop/client";
import type { WhoopCycle } from "@dofek/whoop/types";
import type { SyncDatabase } from "../../db/index.ts";
import type { SyncError, SyncOptions } from "../types.ts";

export type WhoopPersistenceContext = {
  db: SyncDatabase;
  cycles: WhoopCycle[];
  providerId: string;
  since: Date;
  windowEnd: Date;
  options?: SyncOptions;
  errors: SyncError[];
};

export type WhoopSyncContext = WhoopPersistenceContext & {
  client: WhoopClient;
};
