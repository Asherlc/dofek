ALTER TABLE fitness.companion_token
ADD COLUMN connection_type text DEFAULT 'zepp-main' NOT NULL;

ALTER TABLE fitness.companion_token
ADD CONSTRAINT companion_token_connection_type_check
CHECK (connection_type IN ('zepp-main', 'zepp-workout'));

DROP INDEX fitness.companion_token_user_idx;

CREATE UNIQUE INDEX companion_token_user_connection_type_idx
ON fitness.companion_token (user_id, connection_type)
WHERE revoked_at IS NULL;
