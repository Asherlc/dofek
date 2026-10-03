CREATE TABLE fitness.provider_issue_email (
  user_id uuid NOT NULL,
  provider_id text NOT NULL,
  sent_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, provider_id),
  CONSTRAINT provider_issue_email_connection_fkey
  FOREIGN KEY (user_id, provider_id)
  REFERENCES fitness.provider_connection (user_id, provider_id)
  ON DELETE CASCADE
);
--> statement-breakpoint
SELECT fitness.refresh_account_erasure_write_fences();
