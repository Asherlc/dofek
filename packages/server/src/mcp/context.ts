import type { Database } from "dofek/db";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import type { McpScope } from "./token-repository.ts";

export interface DofekMcpContext {
  db: Pick<Database, "execute" | "select" | "transaction">;
  userId: string;
  scopes: McpScope[];
  timezone: string;
  sensorStore?: ActivitySensorStore;
}
