import type { Database } from "dofek/db";
import type { AccessWindow } from "../billing/entitlement.ts";
import { activityRepositoryFor } from "./activity-repository.ts";

/** @deprecated Use ActivityRepository.countVisibleInWindow instead. */
export async function countRawActivities(
  db: Pick<Database, "execute">,
  input: {
    userId: string;
    days: number;
    activityTypes?: string[];
    requireEndedAt?: boolean;
    accessWindow?: AccessWindow;
  },
): Promise<number> {
  return activityRepositoryFor(db, input.userId).countVisibleInWindow(input);
}
