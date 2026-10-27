import type { Database } from "dofek/db";
import { BillingRepository } from "../repositories/billing-repository.ts";
import type { AccessWindow } from "./entitlement.ts";

export async function getAccessWindowForUser(
  db: Pick<Database, "execute">,
  userId: string,
  timezone: string,
): Promise<AccessWindow> {
  const status = await new BillingRepository(db).getAccessStatus(userId, timezone);
  return status.access;
}
