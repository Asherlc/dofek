ALTER TABLE fitness.sync_log
ADD COLUMN auth_failure_reason text;

UPDATE fitness.sync_log
SET
  auth_failure_reason = CASE
    WHEN
      position('refresh token was revoked' IN lower(error_message)) > 0
      OR position('refresh token revoked' IN lower(error_message)) > 0
      OR position('authorization revoked' IN lower(error_message)) > 0
      THEN 'refresh_token_revoked'
    WHEN
      position('access token expired' IN lower(error_message)) > 0
      OR position('token expired' IN lower(error_message)) > 0
      THEN 'access_token_expired'
    WHEN
      position('session expired' IN lower(error_message)) > 0
      OR position('re-authenticate' IN lower(error_message)) > 0
      OR position('reconnect' IN lower(error_message)) > 0
      OR position('re-connect' IN lower(error_message)) > 0
      THEN 'session_expired'
    WHEN position('authentication failed' IN lower(error_message)) > 0
      THEN 'authentication_failed'
    WHEN
      position('authorization failed' IN lower(error_message)) > 0
      OR lower(error_message) = 'unauthorized'
      OR position(' unauthorized' IN lower(error_message)) > 0
      OR position('unauthorized ' IN lower(error_message)) > 0
      THEN 'authorization_failed'
    ELSE auth_failure_reason
  END
WHERE
  status = 'error'
  AND auth_failure_reason IS NULL
  AND error_message IS NOT NULL;
