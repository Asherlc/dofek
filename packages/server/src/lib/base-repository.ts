import type { Database } from "dofek/db";
import type { SQL } from "drizzle-orm";
import type { z } from "zod";
import { executeWithSchema } from "./typed-sql.ts";

/**
 * Minimal DB interface: anything with an `execute` method.
 * Repositories that need `transaction` or `select` widen this via the generic.
 */
type ExecutableDatabase = Pick<Database, "execute">;

/**
 * Shared base for all data-access repositories.
 *
 * Provides the common `db`, `userId`, and `timezone` fields plus a `query()`
 * convenience method that wraps `executeWithSchema`.
 *
 * @typeParam TDb - The minimum database interface this repository needs.
 *   Defaults to `Pick<Database, "execute">`, but can be widened
 *   (e.g., `Pick<Database, "execute" | "transaction">`) for repositories
 *   that use transactions.
 */
export abstract class BaseRepository<TDb extends ExecutableDatabase = ExecutableDatabase> {
  protected readonly db: TDb;
  protected readonly userId: string;
  protected readonly timezone: string;

  constructor(db: TDb, userId: string, timezone = "UTC") {
    this.db = db;
    this.userId = userId;
    this.timezone = timezone;
  }

  /** Execute a raw SQL query and parse each row with a Zod schema. */
  protected query<TSchema extends z.ZodType>(
    schema: TSchema,
    sqlQuery: SQL,
  ): Promise<z.infer<TSchema>[]> {
    return executeWithSchema(this.db, schema, sqlQuery);
  }
}
