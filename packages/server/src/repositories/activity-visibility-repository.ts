import { sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { postgresActivityCalendarDate } from "./activity-local-date.ts";

function readActivityId(row: unknown): string {
  if (typeof row === "object" && row !== null && "id" in row) {
    const { id } = row;
    if (typeof id === "string") return id;
  }
  throw new Error("Activity row is missing a string id");
}

/** Resolves activity IDs against the current visible view and entitlement window. */
export class ActivityVisibilityRepository extends BaseRepository {
  async resolveVisibleActivityIds(activityIds: readonly string[]): Promise<Set<string>> {
    const uniqueActivityIds = [...new Set(activityIds)];
    if (uniqueActivityIds.length === 0) return new Set();

    const activityIdFilter = sql.join(
      uniqueActivityIds.map((activityId) => sql`${activityId}::uuid`),
      sql`, `,
    );
    const rows = await this.query(
      z.object({ id: z.string() }),
      sql`SELECT id::text AS id
          FROM fitness.v_activity
          WHERE user_id = ${this.userId}::uuid
            AND id IN (${activityIdFilter})
            ${this.timestampAccessPredicate(sql`started_at`)}`,
    );
    return new Set(rows.map((row) => row.id));
  }

  async listVisibleActivityIdsSince(localDate: string): Promise<string[]> {
    return this.#listVisibleActivityIdsInRange(localDate);
  }

  async listVisibleActivityIdsInRange(
    localStartDate: string,
    localEndDateExclusive: string,
  ): Promise<string[]> {
    return this.#listVisibleActivityIdsInRange(localStartDate, localEndDateExclusive);
  }

  async filterToVisibleActivities<T extends { id: string }>(rows: readonly T[]): Promise<T[]>;
  async filterToVisibleActivities<T>(
    rows: readonly T[],
    getActivityId: (row: T) => string,
  ): Promise<T[]>;
  async filterToVisibleActivities<T>(
    rows: readonly T[],
    getActivityId?: (row: T) => string,
  ): Promise<T[]>;
  async filterToVisibleActivities<T>(
    rows: readonly T[],
    getActivityId?: (row: T) => string,
  ): Promise<T[]> {
    const getId = getActivityId ?? ((row: T) => readActivityId(row));
    const visibleActivityIds = await this.resolveVisibleActivityIds(rows.map(getId));
    return rows.filter((row) => visibleActivityIds.has(getId(row)));
  }

  async filterToVisibleCanonicalActivities<T extends { id: string }>(
    rows: readonly T[],
  ): Promise<T[]> {
    const uniqueActivityIds = [...new Set(rows.map(readActivityId))];
    if (uniqueActivityIds.length === 0) return [];

    const activityIdFilter = sql.join(
      uniqueActivityIds.map((activityId) => sql`${activityId}::uuid`),
      sql`, `,
    );
    const visibleRows = await this.query(
      z.object({ id: z.string() }),
      sql`SELECT a.id::text AS id
          FROM fitness.v_activity a
          WHERE a.user_id = ${this.userId}::uuid
            AND a.id IN (${activityIdFilter})
            ${this.dateAccessPredicate(postgresActivityCalendarDate(sql`a`, this.timezone))}`,
    );
    const visibleActivityIds = new Set(visibleRows.map((row) => row.id));
    return rows.filter((row) => visibleActivityIds.has(row.id));
  }

  async #listVisibleActivityIdsInRange(
    localStartDate: string,
    localEndDateExclusive?: string,
  ): Promise<string[]> {
    const activityDate = postgresActivityCalendarDate(sql`a`, this.timezone);
    const endDatePredicate = localEndDateExclusive
      ? sql`AND ${activityDate} < ${localEndDateExclusive}::date`
      : sql``;
    const rows = await this.query(
      z.object({ id: z.string() }),
      sql`SELECT a.id::text AS id
          FROM fitness.v_activity a
          WHERE a.user_id = ${this.userId}::uuid
            AND ${activityDate} >= ${localStartDate}::date
            ${endDatePredicate}
            ${this.dateAccessPredicate(activityDate)}
          ORDER BY a.started_at DESC`,
    );
    return rows.map((row) => row.id);
  }
}
