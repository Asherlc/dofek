ALTER TABLE "fitness"."sleep_session"
  ADD COLUMN IF NOT EXISTS "sleep_need_total_minutes" integer;
