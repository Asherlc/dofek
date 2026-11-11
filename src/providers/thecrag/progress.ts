import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { SyncDatabase } from "../../db/index.ts";
import { userSettings } from "../../db/schema/account.ts";

const KEY = "thecrag_sync_cursor";
const progressSchema = z.object({
  accountId: z.string(),
  authorizationId: z.string(),
  epoch: z.number().int().nonnegative().safe(),
});
type ConnectionIdentity = { accountId: string; authorizationId: string };

export class TheCragSyncProgress {
  readonly #db: SyncDatabase;
  readonly #userId: string;
  readonly #identity: ConnectionIdentity;
  constructor(db: SyncDatabase, userId: string, identity: ConnectionIdentity) {
    this.#db = db;
    this.#userId = userId;
    this.#identity = identity;
  }

  async load(): Promise<number | undefined> {
    const [row] = await this.#db
      .select({ value: userSettings.value })
      .from(userSettings)
      .where(and(eq(userSettings.userId, this.#userId), eq(userSettings.key, KEY)))
      .limit(1);
    if (!row) return undefined;
    const parsed = progressSchema.safeParse(row.value);
    if (!parsed.success)
      throw new Error(
        "theCrag saved sync progress is invalid. Contact support before syncing again.",
      );
    if (
      parsed.data.accountId !== this.#identity.accountId ||
      parsed.data.authorizationId !== this.#identity.authorizationId
    )
      return undefined;
    return parsed.data.epoch;
  }

  async save(epoch: number): Promise<void> {
    const value = { ...this.#identity, epoch };
    await this.#db
      .insert(userSettings)
      .values({ userId: this.#userId, key: KEY, value })
      .onConflictDoUpdate({
        target: [userSettings.userId, userSettings.key],
        set: { value, updatedAt: new Date() },
      });
  }
}
