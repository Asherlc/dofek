CREATE TABLE "fitness"."life_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "label" text NOT NULL,
  "started_at" date NOT NULL,
  "ended_at" date,
  "category" text,
  "ongoing" boolean NOT NULL DEFAULT false,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "life_events_started_at_idx" ON "fitness"."life_events" USING btree ("started_at");
