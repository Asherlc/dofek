CREATE SCHEMA IF NOT EXISTS "fitness";
--> statement-breakpoint
CREATE TABLE "fitness"."body_measurement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"provider_id" text NOT NULL,
	"external_id" text,
	"weight_kg" real,
	"body_fat_pct" real,
	"muscle_mass_kg" real,
	"bone_mass_kg" real,
	"water_pct" real,
	"bmi" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fitness"."cardio_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"external_id" text,
	"activity_type" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"distance_meters" real,
	"calories" integer,
	"avg_heart_rate" integer,
	"max_heart_rate" integer,
	"avg_power" integer,
	"max_power" integer,
	"avg_speed" real,
	"max_speed" real,
	"avg_cadence" integer,
	"total_elevation_gain" real,
	"normalized_power" integer,
	"intensity_factor" real,
	"tss" real,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fitness"."daily_metrics" (
	"date" date NOT NULL,
	"provider_id" text NOT NULL,
	"sport" text DEFAULT 'all',
	"ctl" real,
	"atl" real,
	"tsb" real,
	"eftp" real,
	"resting_hr" integer,
	"hrv" real,
	"sleep_score" real,
	"readiness" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_metrics_date_provider_id_sport_pk" PRIMARY KEY("date","provider_id","sport")
);
--> statement-breakpoint
CREATE TABLE "fitness"."exercise" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"muscle_group" text,
	"equipment" text,
	"movement" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fitness"."exercise_alias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exercise_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"provider_exercise_id" text,
	"provider_exercise_name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fitness"."metric_stream" (
	"provider_id" text NOT NULL,
	"activity_id" uuid,
	"recorded_at" timestamp with time zone NOT NULL,
	"heart_rate" integer,
	"power" integer,
	"cadence" integer,
	"speed" real,
	"lat" real,
	"lng" real,
	"altitude" real,
	"temperature" real,
	"distance" real,
	"grade" real,
	"calories" integer,
	"vertical_speed" real,
	"gps_accuracy" integer,
	"accumulated_power" integer,
	"left_right_balance" real,
	"vertical_oscillation" real,
	"stance_time" real,
	"stance_time_percent" real,
	"step_length" real,
	"vertical_ratio" real,
	"stance_time_balance" real,
	"left_torque_effectiveness" real,
	"right_torque_effectiveness" real,
	"left_pedal_smoothness" real,
	"right_pedal_smoothness" real,
	"combined_pedal_smoothness" real,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "fitness"."nutrition_daily" (
	"date" date NOT NULL,
	"provider_id" text NOT NULL,
	"calories" integer,
	"protein_g" real,
	"carbs_g" real,
	"fat_g" real,
	"fiber_g" real,
	"water_ml" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nutrition_daily_date_provider_id_pk" PRIMARY KEY("date","provider_id")
);
--> statement-breakpoint
CREATE TABLE "fitness"."oauth_token" (
	"provider_id" text PRIMARY KEY NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"scopes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fitness"."provider" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"api_base_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fitness"."sleep_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"external_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_minutes" integer,
	"deep_minutes" integer,
	"rem_minutes" integer,
	"light_minutes" integer,
	"awake_minutes" integer,
	"efficiency_pct" real,
	"is_nap" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fitness"."strength_set" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workout_id" uuid NOT NULL,
	"exercise_id" uuid NOT NULL,
	"exercise_index" integer NOT NULL,
	"set_index" integer NOT NULL,
	"set_type" text DEFAULT 'working',
	"weight_kg" real,
	"reps" integer,
	"distance_meters" real,
	"duration_seconds" integer,
	"rpe" real,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fitness"."strength_workout" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"external_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"name" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fitness"."sync_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"data_type" text NOT NULL,
	"status" text NOT NULL,
	"record_count" integer DEFAULT 0,
	"error_message" text,
	"duration_ms" integer,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fitness"."body_measurement" ADD CONSTRAINT "body_measurement_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "fitness"."provider"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitness"."cardio_activity" ADD CONSTRAINT "cardio_activity_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "fitness"."provider"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitness"."daily_metrics" ADD CONSTRAINT "daily_metrics_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "fitness"."provider"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitness"."exercise_alias" ADD CONSTRAINT "exercise_alias_exercise_id_exercise_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "fitness"."exercise"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitness"."exercise_alias" ADD CONSTRAINT "exercise_alias_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "fitness"."provider"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitness"."metric_stream" ADD CONSTRAINT "metric_stream_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "fitness"."provider"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitness"."metric_stream" ADD CONSTRAINT "metric_stream_activity_id_cardio_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "fitness"."cardio_activity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitness"."nutrition_daily" ADD CONSTRAINT "nutrition_daily_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "fitness"."provider"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitness"."oauth_token" ADD CONSTRAINT "oauth_token_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "fitness"."provider"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitness"."sleep_session" ADD CONSTRAINT "sleep_session_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "fitness"."provider"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitness"."strength_set" ADD CONSTRAINT "strength_set_workout_id_strength_workout_id_fk" FOREIGN KEY ("workout_id") REFERENCES "fitness"."strength_workout"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitness"."strength_set" ADD CONSTRAINT "strength_set_exercise_id_exercise_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "fitness"."exercise"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitness"."strength_workout" ADD CONSTRAINT "strength_workout_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "fitness"."provider"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitness"."sync_log" ADD CONSTRAINT "sync_log_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "fitness"."provider"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "body_measurement_provider_external_idx" ON "fitness"."body_measurement" USING btree ("provider_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cardio_activity_provider_external_idx" ON "fitness"."cardio_activity" USING btree ("provider_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "exercise_name_equipment_idx" ON "fitness"."exercise" USING btree ("name","equipment");--> statement-breakpoint
CREATE UNIQUE INDEX "exercise_alias_provider_name_idx" ON "fitness"."exercise_alias" USING btree ("provider_id","provider_exercise_name");--> statement-breakpoint
CREATE INDEX "metric_stream_provider_time_idx" ON "fitness"."metric_stream" USING btree ("provider_id","recorded_at");--> statement-breakpoint
CREATE INDEX "metric_stream_activity_time_idx" ON "fitness"."metric_stream" USING btree ("activity_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sleep_session_provider_external_idx" ON "fitness"."sleep_session" USING btree ("provider_id","external_id");--> statement-breakpoint
CREATE INDEX "strength_set_workout_idx" ON "fitness"."strength_set" USING btree ("workout_id");--> statement-breakpoint
CREATE UNIQUE INDEX "strength_workout_provider_external_idx" ON "fitness"."strength_workout" USING btree ("provider_id","external_id");--> statement-breakpoint
CREATE INDEX "sync_log_provider_type_idx" ON "fitness"."sync_log" USING btree ("provider_id","data_type","synced_at");