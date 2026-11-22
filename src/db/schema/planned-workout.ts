import { date, index, jsonb, primaryKey, text, time, timestamp, uuid } from "drizzle-orm/pg-core";
import { fitness, resolveImplicitUserId } from "./core.ts";
import { provider, userProfile } from "./reference.ts";

// ============================================================
// Planned workouts (calendar events authored in a provider)
// ============================================================

/**
 * One row per authored event from a source calendar. Only structurally raw,
 * source-owned fields are stored here; the original workout document is kept
 * once in `workoutDoc` and is projected to the neutral read shape on demand.
 * No time-series or derived copy of the workout is written anywhere else.
 */
export const plannedWorkout = fitness.table(
  "planned_workout",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" })
      .$defaultFn(resolveImplicitUserId),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    /** Provider-scoped stable identity of the source event. */
    externalId: text("external_id").notNull(),
    /** Source-local calendar day; never converted between timezones. */
    startDate: date("start_date").notNull(),
    /** Source-local time of day when the source provides one. */
    startTime: time("start_time"),
    title: text("title"),
    description: text("description"),
    sportType: text("sport_type"),
    /** Original structured workout document, kept once exactly as authored. */
    workoutDoc: jsonb("workout_doc"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.providerId, table.externalId] }),
    index("planned_workout_user_date_idx").on(table.userId, table.startDate),
  ],
);
