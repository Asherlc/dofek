CREATE TABLE "fitness"."journal_entry" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "date" date NOT NULL,
  "provider_id" text NOT NULL REFERENCES "fitness"."provider"("id"),
  "question" text NOT NULL,
  "answer_text" text,
  "answer_numeric" real,
  "impact_score" real,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entry_provider_date_question_idx" ON "fitness"."journal_entry" USING btree ("provider_id", "date", "question");
--> statement-breakpoint
CREATE INDEX "journal_entry_date_idx" ON "fitness"."journal_entry" USING btree ("date");
