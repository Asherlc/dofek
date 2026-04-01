ALTER TABLE "fitness"."oauth_token" ADD COLUMN IF NOT EXISTS "user_id" uuid;
--> statement-breakpoint
UPDATE "fitness"."oauth_token"
SET "user_id" = '00000000-0000-0000-0000-000000000001'
WHERE "user_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "fitness"."oauth_token"
ALTER COLUMN "user_id" SET DEFAULT '00000000-0000-0000-0000-000000000001';
--> statement-breakpoint
ALTER TABLE "fitness"."oauth_token"
ALTER COLUMN "user_id" SET NOT NULL;
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
    ON UPDATE NO ACTION;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "fitness"."oauth_token" DROP CONSTRAINT IF EXISTS "oauth_token_pkey";
--> statement-breakpoint
ALTER TABLE "fitness"."oauth_token"
ADD CONSTRAINT "oauth_token_pkey" PRIMARY KEY ("user_id","provider_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_token_provider_idx"
ON "fitness"."oauth_token" USING btree ("provider_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_token_user_idx"
ON "fitness"."oauth_token" USING btree ("user_id");
