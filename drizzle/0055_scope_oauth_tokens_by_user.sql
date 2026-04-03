ALTER TABLE "fitness"."oauth_token" ADD COLUMN IF NOT EXISTS "user_id" uuid;
--> statement-breakpoint
UPDATE "fitness"."oauth_token"
SET "user_id" = p."user_id"
FROM "fitness"."provider" p
WHERE p."id" = "fitness"."oauth_token"."provider_id"
  AND p."user_id" IS NOT NULL
  AND "fitness"."oauth_token"."user_id" IS NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "fitness"."oauth_token" WHERE "user_id" IS NULL) THEN
    RAISE EXCEPTION 'oauth_token rows with NULL user_id remain after backfill';
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'oauth_token_user_id_user_profile_id_fk'
      AND connamespace = 'fitness'::regnamespace
  ) THEN
    ALTER TABLE "fitness"."oauth_token"
    ADD CONSTRAINT "oauth_token_user_id_user_profile_id_fk"
    FOREIGN KEY ("user_id")
    REFERENCES "fitness"."user_profile"("id")
    ON DELETE NO ACTION
    ON UPDATE NO ACTION
    NOT VALID;

    ALTER TABLE "fitness"."oauth_token"
    VALIDATE CONSTRAINT "oauth_token_user_id_user_profile_id_fk";
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'oauth_token_user_id_not_null_chk'
      AND connamespace = 'fitness'::regnamespace
  ) THEN
    ALTER TABLE "fitness"."oauth_token"
    ADD CONSTRAINT "oauth_token_user_id_not_null_chk"
    CHECK ("user_id" IS NOT NULL) NOT VALID;

    ALTER TABLE "fitness"."oauth_token"
    VALIDATE CONSTRAINT "oauth_token_user_id_not_null_chk";
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "fitness"."oauth_token" DROP CONSTRAINT IF EXISTS "oauth_token_pkey";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_token_user_provider_uidx"
ON "fitness"."oauth_token" USING btree ("user_id", "provider_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_token_provider_idx"
ON "fitness"."oauth_token" USING btree ("provider_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_token_user_idx"
ON "fitness"."oauth_token" USING btree ("user_id");
