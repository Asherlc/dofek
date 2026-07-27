import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { fitness, resolveImplicitUserId } from "./core.ts";
import { foodCategoryEnum, mealEnum, nutritionEntryGrainEnum } from "./enums.ts";
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
    name: text("name").notNull(),
    amount: real("amount"),
    unit: text("unit"),
    form: text("form"),
    description: text("description"),
    meal: mealEnum("meal"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("supplement_user_name_idx").on(table.userId, table.name),
    index("supplement_user_idx").on(table.userId),
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
