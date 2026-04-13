import * as Sentry from "@sentry/node";
import type { Database } from "dofek/db";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { timestampWindowStart } from "./date-window.ts";
import { executeWithSchema } from "./typed-sql.ts";

/**
 * Minimal DB interface: anything with an `execute` method.
 * Repositories that need `transaction` or `select` widen this via the generic.
 */
type ExecutableDatabase = Pick<Database, "execute">;

const ACTIVITY_VIEWS = [
  "fitness.v_activity",
  "fitness.deduped_sensor",
  "fitness.activity_summary",
] as const;

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

  /**
   * Run a query that depends on materialized views with stale-view self-healing.
   *
   * If the query returns no rows but the base `fitness.activity` table has data
   * in the same time window, the views are stale. Refreshes them and retries.
   *
   * @param baseCountSql Optional custom SQL to check for base data. When the
   *   materialized view query filters more narrowly than "all activities" (e.g.,
   *   only activities with HR data), pass a matching base count query to avoid
   *   false-positive stale-view refreshes. Must return `{ count: number }`.
   */
  protected async queryWithViewRefresh<TResult>(
    queryFn: () => Promise<TResult[]>,
    days: number,
    label: string,
    baseCountSql?: SQL,
  ): Promise<TResult[]> {
    const result = await queryFn();
    if (result.length > 0) return result;

    const today = new Date().toLocaleDateString("en-CA");
    const baseCount = baseCountSql
      ? ((await this.query(z.object({ count: z.coerce.number() }), baseCountSql))[0]?.count ?? 0)
      : await this.#baseActivityCount(today, days);
    if (baseCount === 0) return result;

    Sentry.captureMessage(`Stale activity materialized views detected (${label})`, {
      level: "warning",
      tags: { userId: this.userId },
      extra: { baseCount },
    });
    try {
      await this.#refreshActivityViews();
      return queryFn();
    } catch (refreshError) {
      Sentry.captureException(refreshError, {
        tags: { userId: this.userId, context: "staleViewRefresh" },
      });
      return result;
    }
  }

  async #baseActivityCount(endDate: string, days: number): Promise<number> {
    const rows = await this.query(
      z.object({ count: z.coerce.number() }),
      sql`SELECT count(*)::int AS count FROM fitness.activity
          WHERE user_id = ${this.userId}
            AND started_at > ${timestampWindowStart(endDate, days)}`,
    );
    return rows[0]?.count ?? 0;
  }

  async #refreshActivityViews(): Promise<void> {
    for (const view of ACTIVITY_VIEWS) {
      try {
        await this.db.execute(sql.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`));
      } catch {
        await this.db.execute(sql.raw(`REFRESH MATERIALIZED VIEW ${view}`));
      }
    }
  }
}
