import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { fitness, resolveImplicitUserId } from "./core.ts";
import {
  foodCategoryEnum,
  mealEnum,
  nutritionEntryGrainEnum,
  supplementDoseStatusEnum,
} from "./enums.ts";
import { provider, userProfile } from "./reference.ts";

// ============================================================
// Supplements — per-user supplement stack definitions
// ============================================================

export const supplement = fitness.table(
  "supplement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id),
    scheduleId: uuid("schedule_id").notNull().defaultRandom(),
    supersedesSupplementId: uuid("supersedes_supplement_id"),
    name: text("name").notNull(),
    amount: real("amount"),
    unit: text("unit"),
    form: text("form"),
    description: text("description"),
    meal: mealEnum("meal"),
    sortOrder: integer("sort_order").notNull().default(0),
    effectiveFrom: date("effective_from").notNull().default(sql`CURRENT_DATE`),
    effectiveTo: date("effective_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "supplement_supersedes_fkey",
      columns: [table.supersedesSupplementId, table.userId, table.scheduleId],
      foreignColumns: [table.id, table.userId, table.scheduleId],
    }),
    unique("supplement_id_user_schedule_key").on(table.id, table.userId, table.scheduleId),
    unique("supplement_supersedes_key").on(table.supersedesSupplementId),
    uniqueIndex("supplement_user_name_active_idx")
      .on(table.userId, table.name)
      .where(sql`${table.effectiveTo} IS NULL`),
    uniqueIndex("supplement_user_schedule_active_idx")
      .on(table.userId, table.scheduleId)
      .where(sql`${table.effectiveTo} IS NULL`),
    index("supplement_user_idx").on(table.userId),
    index("supplement_user_effective_idx").on(table.userId, table.effectiveFrom, table.effectiveTo),
    check(
      "supplement_effective_interval_valid",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} >= ${table.effectiveFrom}`,
    ),
  ],
);

// ============================================================
// Nutrient catalog + junction tables
// ============================================================

export const nutrient = fitness.table("nutrient", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  unit: text("unit").notNull(),
  category: text("category").notNull(),
  rda: real("rda"),
  sortOrder: integer("sort_order").notNull().default(0),
  openFoodFactsKey: text("open_food_facts_key"),
  conversionFactor: real("conversion_factor").notNull().default(1),
});

export const foodEntryNutrient = fitness.table(
  "food_entry_nutrient",
  {
    foodEntryId: uuid("food_entry_id")
      .notNull()
      .references(() => foodEntry.id, { onDelete: "cascade" }),
    nutrientId: text("nutrient_id")
      .notNull()
      .references(() => nutrient.id),
    amount: real("amount").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.foodEntryId, table.nutrientId] }),
    index("food_entry_nutrient_entry_idx").on(table.foodEntryId),
  ],
);

export const supplementNutrient = fitness.table(
  "supplement_nutrient",
  {
    supplementId: uuid("supplement_id")
      .notNull()
      .references(() => supplement.id, { onDelete: "cascade" }),
    nutrientId: text("nutrient_id")
      .notNull()
      .references(() => nutrient.id),
    amount: real("amount").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.supplementId, table.nutrientId] }),
    index("supplement_nutrient_supplement_idx").on(table.supplementId),
  ],
);

// ============================================================
// Supplement dose events — append-only scheduled occurrence history
// ============================================================

export const supplementDoseEvent = fitness.table(
  "supplement_dose_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    scheduleId: uuid("schedule_id").notNull(),
    supplementId: uuid("supplement_id").notNull(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    externalId: text("external_id"),
    scheduledDate: date("scheduled_date").notNull(),
    status: supplementDoseStatusEnum("status").notNull(),
    supersedesEventId: uuid("supersedes_event_id"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    sourceName: text("source_name"),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "supplement_dose_event_definition_fkey",
      columns: [table.supplementId, table.userId, table.scheduleId],
      foreignColumns: [supplement.id, supplement.userId, supplement.scheduleId],
    }),
    foreignKey({
      name: "supplement_dose_event_supersedes_fkey",
      columns: [
        table.supersedesEventId,
        table.userId,
        table.scheduleId,
        table.supplementId,
        table.scheduledDate,
      ],
      foreignColumns: [
        table.id,
        table.userId,
        table.scheduleId,
        table.supplementId,
        table.scheduledDate,
      ],
    }),
    unique("supplement_dose_event_slot_identity_key").on(
      table.id,
      table.userId,
      table.scheduleId,
      table.supplementId,
      table.scheduledDate,
    ),
    unique("supplement_dose_event_successor_key").on(table.supersedesEventId),
    uniqueIndex("supplement_dose_event_root_key")
      .on(table.userId, table.scheduleId, table.scheduledDate)
      .where(sql`${table.supersedesEventId} IS NULL`),
    uniqueIndex("supplement_dose_event_provider_external_idx")
      .on(table.userId, table.providerId, table.externalId)
      .where(sql`${table.externalId} IS NOT NULL`),
    index("supplement_dose_event_user_date_idx").on(table.userId, table.scheduledDate),
    index("supplement_dose_event_supplement_idx").on(table.supplementId),
    check(
      "supplement_dose_event_not_self_superseding",
      sql`${table.supersedesEventId} IS NULL OR ${table.supersedesEventId} <> ${table.id}`,
    ),
  ],
);

// ============================================================
// Nutrition
// ============================================================

export const foodEntry = fitness.table(
  "food_entry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    externalId: text("external_id"),
    date: date("date").notNull(),
    nutritionGrain: nutritionEntryGrainEnum("nutrition_grain"),
    meal: mealEnum("meal"),
    foodName: text("food_name"),
    foodDescription: text("food_description"),
    category: foodCategoryEnum("category"),
    providerFoodId: text("provider_food_id"),
    providerServingId: text("provider_serving_id"),
    numberOfUnits: real("number_of_units"),
    loggedAt: timestamp("logged_at", { withTimezone: true }),
    sourceName: text("source_name"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    barcode: text("barcode"),
    servingUnit: text("serving_unit"),
    servingWeightGrams: real("serving_weight_grams"),
    // Raw API response
    raw: jsonb("raw"),
    confirmed: boolean("confirmed").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("food_entry_provider_external_idx").on(
      table.userId,
      table.providerId,
      table.externalId,
    ),
    index("food_entry_date_idx").on(table.date),
    index("food_entry_date_meal_idx").on(table.date, table.meal),
    index("food_entry_user_provider_idx").on(table.userId, table.providerId),
  ],
);
