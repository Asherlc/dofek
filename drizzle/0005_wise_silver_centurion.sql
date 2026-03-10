CREATE TYPE "fitness"."food_category" AS ENUM('beans_and_legumes', 'beverages', 'breads_and_cereals', 'cheese_milk_and_dairy', 'eggs', 'fast_food', 'fish_and_seafood', 'fruit', 'meat', 'nuts_and_seeds', 'pasta_rice_and_noodles', 'salads', 'sauces_spices_and_spreads', 'snacks', 'soups', 'sweets_candy_and_desserts', 'vegetables', 'supplement', 'other');--> statement-breakpoint
CREATE TYPE "fitness"."lab_result_status" AS ENUM('final', 'preliminary', 'corrected', 'cancelled');--> statement-breakpoint
CREATE TYPE "fitness"."meal" AS ENUM('breakfast', 'lunch', 'dinner', 'snack', 'other');--> statement-breakpoint
CREATE TYPE "fitness"."set_type" AS ENUM('working', 'warmup', 'dropset', 'failure');--> statement-breakpoint
CREATE TABLE "fitness"."food_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"external_id" text,
	"date" date NOT NULL,
	"meal" "fitness"."meal",
	"food_name" text NOT NULL,
	"food_description" text,
	"category" "fitness"."food_category",
	"provider_food_id" text,
	"provider_serving_id" text,
	"number_of_units" real,
	"calories" integer,
	"protein_g" real,
	"carbs_g" real,
	"fat_g" real,
	"saturated_fat_g" real,
	"polyunsaturated_fat_g" real,
	"monounsaturated_fat_g" real,
	"trans_fat_g" real,
	"cholesterol_mg" real,
	"sodium_mg" real,
	"potassium_mg" real,
	"fiber_g" real,
	"sugar_g" real,
	"vitamin_a_mcg" real,
	"vitamin_c_mg" real,
	"calcium_mg" real,
	"iron_mg" real,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fitness"."lab_result" ALTER COLUMN "status" SET DATA TYPE "fitness"."lab_result_status" USING "status"::"fitness"."lab_result_status";--> statement-breakpoint
ALTER TABLE "fitness"."strength_set" ALTER COLUMN "set_type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "fitness"."strength_set" ALTER COLUMN "set_type" SET DATA TYPE "fitness"."set_type" USING "set_type"::"fitness"."set_type";--> statement-breakpoint
ALTER TABLE "fitness"."strength_set" ALTER COLUMN "set_type" SET DEFAULT 'working'::"fitness"."set_type";--> statement-breakpoint
ALTER TABLE "fitness"."food_entry" ADD CONSTRAINT "food_entry_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "fitness"."provider"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "food_entry_provider_external_idx" ON "fitness"."food_entry" USING btree ("provider_id","external_id");--> statement-breakpoint
CREATE INDEX "food_entry_date_idx" ON "fitness"."food_entry" USING btree ("date");--> statement-breakpoint
CREATE INDEX "food_entry_date_meal_idx" ON "fitness"."food_entry" USING btree ("date","meal");