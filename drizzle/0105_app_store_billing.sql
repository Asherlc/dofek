ALTER TABLE fitness.user_billing
ADD COLUMN app_store_account_token uuid,
ADD COLUMN app_store_original_transaction_id text,
ADD COLUMN app_store_transaction_id text,
ADD COLUMN app_store_product_id text,
ADD COLUMN app_store_subscription_status text,
ADD COLUMN app_store_expires_at timestamptz,
ADD COLUMN app_store_revocation_at timestamptz,
ADD COLUMN app_store_environment text;
--> statement-breakpoint
CREATE UNIQUE INDEX user_billing_app_store_account_token_unique
ON fitness.user_billing (app_store_account_token)
WHERE app_store_account_token IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX user_billing_app_store_original_transaction_id_unique
ON fitness.user_billing (app_store_original_transaction_id)
WHERE app_store_original_transaction_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX user_billing_app_store_transaction_id_unique
ON fitness.user_billing (app_store_transaction_id)
WHERE app_store_transaction_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE fitness.app_store_notification (
  notification_uuid uuid PRIMARY KEY,
  signed_date bigint NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
