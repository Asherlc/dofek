CREATE TABLE "fitness"."activity_image" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"source_id" text NOT NULL,
	"candidate" jsonb NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"object_id" uuid,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_image_generation" CHECK ("fitness"."activity_image"."generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "fitness"."activity_image_backfill" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"cursor_started_at" timestamp with time zone,
	"cursor_id" uuid,
	"high_water_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scanned" integer DEFAULT 0 NOT NULL,
	"discovered" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fitness"."activity_image_discovery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"coverage" text NOT NULL,
	"expected_count" integer,
	"reason" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_image_discovery_coverage" CHECK ("fitness"."activity_image_discovery"."coverage" IN ('complete', 'partial', 'unavailable', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "fitness"."activity_image_object" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"object_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_image_object_hash" CHECK ("fitness"."activity_image_object"."sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "activity_image_object_dimensions" CHECK ("fitness"."activity_image_object"."width" > 0 AND "fitness"."activity_image_object"."height" > 0 AND "fitness"."activity_image_object"."size_bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "fitness"."activity_image_work" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"image_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"processing_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_image_work_state" CHECK ("fitness"."activity_image_work"."state" IN ('pending','processing','stored','retryable_failure','terminal_failure'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "activity_image_user_id_idx" ON "fitness"."activity_image" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_image_object_user_id_idx" ON "fitness"."activity_image_object" USING btree ("user_id","id");--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE "fitness"."activity_image" ADD CONSTRAINT "activity_image_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "fitness"."provider"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitness"."activity_image" ADD CONSTRAINT "activity_image_user_id_activity_id_activity_user_id_id_fk" FOREIGN KEY ("user_id","activity_id") REFERENCES "fitness"."activity"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitness"."activity_image" ADD CONSTRAINT "activity_image_user_id_object_id_activity_image_object_user_id_id_fk" FOREIGN KEY ("user_id","object_id") REFERENCES "fitness"."activity_image_object"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitness"."activity_image_backfill" ADD CONSTRAINT "activity_image_backfill_user_id_user_profile_id_fk" FOREIGN KEY ("user_id") REFERENCES "fitness"."user_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitness"."activity_image_backfill" ADD CONSTRAINT "activity_image_backfill_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "fitness"."provider"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitness"."activity_image_discovery" ADD CONSTRAINT "activity_image_discovery_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "fitness"."provider"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitness"."activity_image_discovery" ADD CONSTRAINT "activity_image_discovery_user_id_activity_id_activity_user_id_id_fk" FOREIGN KEY ("user_id","activity_id") REFERENCES "fitness"."activity"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitness"."activity_image_object" ADD CONSTRAINT "activity_image_object_user_id_user_profile_id_fk" FOREIGN KEY ("user_id") REFERENCES "fitness"."user_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitness"."activity_image_work" ADD CONSTRAINT "activity_image_work_user_id_image_id_activity_image_user_id_id_fk" FOREIGN KEY ("user_id","image_id") REFERENCES "fitness"."activity_image"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activity_image_source_idx" ON "fitness"."activity_image" USING btree ("user_id","activity_id","provider_id","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_image_discovery_source_idx" ON "fitness"."activity_image_discovery" USING btree ("user_id","activity_id","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_image_object_user_hash_idx" ON "fitness"."activity_image_object" USING btree ("user_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_image_object_key_idx" ON "fitness"."activity_image_object" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "activity_image_work_pending_idx" ON "fitness"."activity_image_work" USING btree ("state","available_at");