import type { ClimbingBoard, ClimbingWallAngle } from "@dofek/training/climbing-experience";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  point,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { activity } from "./activity.ts";
import { fitness, resolveImplicitUserId } from "./core.ts";
import {
  attemptScopeEnum,
  climbingDisciplineEnum,
  climbingHoldTypeEnum,
  climbKindEnum,
  climbSettingEnum,
  gradeSystemEnum,
  protectionStyleEnum,
  ropeMethodEnum,
} from "./enums.ts";
import { provider, userProfile } from "./reference.ts";

export const area = fitness.table(
  "area",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    externalId: text("external_id"),
    name: text("name").notNull(),
    parentAreaId: uuid("parent_area_id"),
    // Native point: x = longitude, y = latitude, in decimal degrees.
    coordinates: point("coordinates", { mode: "xy" }),
  },
  (table) => [
    uniqueIndex("area_owner_provider_id_idx").on(table.userId, table.providerId, table.id),
    uniqueIndex("area_source_external_id_idx")
      .on(table.userId, table.providerId, table.externalId)
      .where(sql`${table.externalId} IS NOT NULL`),
    index("area_parent_idx").on(table.parentAreaId),
    foreignKey({
      name: "area_parent_owner_provider_fk",
      columns: [table.userId, table.providerId, table.parentAreaId],
      foreignColumns: [table.userId, table.providerId, table.id],
    }),
    check("area_name_nonempty", sql`btrim(${table.name}) <> ''`),
    check(
      "area_external_id_nonempty",
      sql`${table.externalId} IS NULL OR btrim(${table.externalId}) <> ''`,
    ),
    check("area_parent_distinct", sql`${table.parentAreaId} <> ${table.id}`),
    check(
      "area_coordinates_valid",
      sql`${table.coordinates}[0] BETWEEN -180 AND 180 AND ${table.coordinates}[1] BETWEEN -90 AND 90`,
    ),
  ],
);

export const climb = fitness.table(
  "climb",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    externalId: text("external_id"),
    name: text("name"),
    kind: climbKindEnum("kind"),
    areaId: uuid("area_id"),
    setting: climbSettingEnum("setting"),
    routeProtection: protectionStyleEnum("route_protection").array(),
    coordinates: point("coordinates", { mode: "xy" }),
  },
  (table) => [
    uniqueIndex("climb_owner_provider_id_idx").on(table.userId, table.providerId, table.id),
    uniqueIndex("climb_source_external_id_idx")
      .on(table.userId, table.providerId, table.externalId)
      .where(sql`${table.externalId} IS NOT NULL`),
    index("climb_area_idx").on(table.areaId),
    foreignKey({
      name: "climb_area_owner_provider_fk",
      columns: [table.userId, table.providerId, table.areaId],
      foreignColumns: [area.userId, area.providerId, area.id],
    }),
    check("climb_name_nonempty", sql`${table.name} IS NULL OR btrim(${table.name}) <> ''`),
    check(
      "climb_external_id_nonempty",
      sql`${table.externalId} IS NULL OR btrim(${table.externalId}) <> ''`,
    ),
    check(
      "climb_route_protection_valid",
      sql`array_position(${table.routeProtection}, NULL) IS NULL`,
    ),
    check(
      "climb_coordinates_valid",
      sql`${table.coordinates}[0] BETWEEN -180 AND 180 AND ${table.coordinates}[1] BETWEEN -90 AND 90`,
    ),
  ],
);

export const pitch = fitness.table(
  "pitch",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    climbId: uuid("climb_id")
      .notNull()
      .references(() => climb.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    number: bigint("number", { mode: "number" }),
    name: text("name"),
  },
  (table) => [
    uniqueIndex("pitch_source_external_id_idx")
      .on(table.climbId, table.externalId)
      .where(sql`${table.externalId} IS NOT NULL`),
    uniqueIndex("pitch_number_idx")
      .on(table.climbId, table.number)
      .where(sql`${table.number} IS NOT NULL`),
    index("pitch_climb_idx").on(table.climbId),
    check("pitch_number_positive", sql`${table.number} > 0`),
    check(
      "pitch_external_id_nonempty",
      sql`${table.externalId} IS NULL OR btrim(${table.externalId}) <> ''`,
    ),
    check("pitch_name_nonempty", sql`${table.name} IS NULL OR btrim(${table.name}) <> ''`),
  ],
);

function gradeFields() {
  return {
    value: text("value").notNull(),
    system: gradeSystemEnum("system"),
    position: bigint("position", { mode: "number" }).notNull(),
  };
}

export const climbGrade = fitness.table(
  "climb_grade",
  {
    climbId: uuid("climb_id")
      .notNull()
      .references(() => climb.id, { onDelete: "cascade" }),
    ...gradeFields(),
  },
  (table) => [
    primaryKey({ columns: [table.climbId, table.position] }),
    check("climb_grade_value_nonempty", sql`btrim(${table.value}) <> ''`),
    check("climb_grade_position_nonnegative", sql`${table.position} >= 0`),
    index("climb_grade_lookup_idx").on(table.system, table.value),
  ],
);

export const pitchGrade = fitness.table(
  "pitch_grade",
  {
    pitchId: uuid("pitch_id")
      .notNull()
      .references(() => pitch.id, { onDelete: "cascade" }),
    ...gradeFields(),
  },
  (table) => [
    primaryKey({ columns: [table.pitchId, table.position] }),
    check("pitch_grade_value_nonempty", sql`btrim(${table.value}) <> ''`),
    check("pitch_grade_position_nonnegative", sql`${table.position} >= 0`),
  ],
);

export const climbingLogEntry = fitness.table(
  "climbing_log_entry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    externalId: text("external_id"),
    climbId: uuid("climb_id"),
    activityId: uuid("activity_id"),
    climbedOn: date("climbed_on"),
    discipline: climbingDisciplineEnum("discipline"),
    title: text("title"),
    notes: text("notes"),
    board: jsonb("board").$type<ClimbingBoard>(),
    wallAngle: jsonb("wall_angle").$type<ClimbingWallAngle>(),
    holdType: climbingHoldTypeEnum("hold_type"),
    sourceName: text("source_name"),
    raw: jsonb("raw"),
    providerAbsentAt: timestamp("provider_absent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "climbing_log_entry_climb_owner_provider_fk",
      columns: [table.userId, table.providerId, table.climbId],
      foreignColumns: [climb.userId, climb.providerId, climb.id],
    }),
    // Migration SQL restricts SET NULL to activity_id, preserving user_id.
    foreignKey({
      name: "climbing_log_entry_activity_owner_fk",
      columns: [table.userId, table.activityId],
      foreignColumns: [activity.userId, activity.id],
    }).onDelete("set null"),
    uniqueIndex("climbing_log_entry_owner_provider_id_idx").on(
      table.userId,
      table.providerId,
      table.id,
    ),
    uniqueIndex("climbing_log_entry_source_external_id_idx")
      .on(table.userId, table.providerId, table.externalId)
      .where(sql`${table.externalId} IS NOT NULL`),
    index("climbing_log_entry_activity_idx").on(table.activityId),
    index("climbing_log_entry_climb_idx").on(table.climbId),
    index("climbing_log_entry_source_date_idx").on(table.userId, table.providerId, table.climbedOn),
    check(
      "climbing_log_entry_external_id_nonempty",
      sql`${table.externalId} IS NULL OR btrim(${table.externalId}) <> ''`,
    ),
    check(
      "climbing_log_entry_title_nonempty",
      sql`${table.title} IS NULL OR btrim(${table.title}) <> ''`,
    ),
    check(
      "climbing_log_entry_notes_nonempty",
      sql`${table.notes} IS NULL OR btrim(${table.notes}) <> ''`,
    ),
    check(
      "climbing_log_entry_source_name_nonempty",
      sql`${table.sourceName} IS NULL OR btrim(${table.sourceName}) <> ''`,
    ),
    check("climbing_log_entry_board_valid", sql`fitness.climbing_board_valid(${table.board})`),
    check(
      "climbing_log_entry_wall_angle_valid",
      sql`fitness.climbing_wall_angle_valid(${table.wallAngle})`,
    ),
  ],
);

export const climbingLogEntryGrade = fitness.table(
  "climbing_log_entry_grade",
  {
    climbingLogEntryId: uuid("climbing_log_entry_id")
      .notNull()
      .references(() => climbingLogEntry.id, { onDelete: "cascade" }),
    ...gradeFields(),
  },
  (table) => [
    primaryKey({ columns: [table.climbingLogEntryId, table.position] }),
    check("climbing_log_entry_grade_value_nonempty", sql`btrim(${table.value}) <> ''`),
    check("climbing_log_entry_grade_position_nonnegative", sql`${table.position} >= 0`),
  ],
);

export const climbingAttempt = fitness.table(
  "climbing_attempt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    climbingLogEntryId: uuid("climbing_log_entry_id")
      .notNull()
      .references(() => climbingLogEntry.id, { onDelete: "cascade" }),
    scope: attemptScopeEnum("scope").notNull(),
    pitchId: uuid("pitch_id").references(() => pitch.id),
    parentAttemptId: uuid("parent_attempt_id"),
    attemptIndex: bigint("attempt_index", { mode: "number" }),
    sourceResult: text("source_result"),
    // Migration 0150 requires a method when the owning log's Climb is a route.
    ropeMethod: ropeMethodEnum("rope_method"),
    solo: boolean("solo"),
    protectionUsed: protectionStyleEnum("protection_used").array(),
    usedPreplacedProtection: boolean("used_preplaced_protection"),
    usedAid: boolean("used_aid"),
    fellOrHung: boolean("fell_or_hung"),
    dabbed: boolean("dabbed"),
    receivedBeta: boolean("received_beta"),
    hadCompletedBefore: boolean("had_completed_before"),
    priorFailedAttemptsGroundUp: boolean("prior_failed_attempts_ground_up"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("climbing_attempt_log_entry_idx").on(table.climbingLogEntryId),
    index("climbing_attempt_pitch_idx").on(table.pitchId),
    index("climbing_attempt_parent_idx").on(table.parentAttemptId),
    uniqueIndex("climbing_attempt_log_id_idx").on(table.climbingLogEntryId, table.id),
    foreignKey({
      name: "climbing_attempt_parent_same_log_fk",
      columns: [table.climbingLogEntryId, table.parentAttemptId],
      foreignColumns: [table.climbingLogEntryId, table.id],
    }),
    check(
      "climbing_attempt_scope_valid",
      sql`${table.scope} = 'pitch' OR (${table.pitchId} IS NULL AND ${table.parentAttemptId} IS NULL)`,
    ),
    check("climbing_attempt_parent_distinct", sql`${table.parentAttemptId} <> ${table.id}`),
    check(
      "climbing_attempt_protection_valid",
      sql`array_position(${table.protectionUsed}, NULL) IS NULL`,
    ),
    check("climbing_attempt_index_positive", sql`${table.attemptIndex} > 0`),
    check(
      "climbing_attempt_source_result_nonempty",
      sql`${table.sourceResult} IS NULL OR btrim(${table.sourceResult}, U&'\\0009\\000A\\000B\\000C\\000D\\0020\\00A0\\1680\\2000\\2001\\2002\\2003\\2004\\2005\\2006\\2007\\2008\\2009\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF') <> ''`,
    ),
    check(
      "climbing_attempt_notes_nonempty",
      sql`${table.notes} IS NULL OR btrim(${table.notes}) <> ''`,
    ),
  ],
);
