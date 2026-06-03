ALTER TABLE fitness.sync_log
ADD COLUMN auth_failure_reason text;

UPDATE fitness.sync_log
SET auth_failure_reason = CASE
  WHEN position('refresh token was revoked' in lower(error_message)) > 0
    OR position('refresh token revoked' in lower(error_message)) > 0
    OR position('authorization revoked' in lower(error_message)) > 0
    THEN 'refresh_token_revoked'
  WHEN position('access token expired' in lower(error_message)) > 0
    OR position('token expired' in lower(error_message)) > 0
    THEN 'access_token_expired'
  WHEN position('session expired' in lower(error_message)) > 0
    OR position('re-authenticate' in lower(error_message)) > 0
    OR position('reconnect' in lower(error_message)) > 0
    OR position('re-connect' in lower(error_message)) > 0
    THEN 'session_expired'
  WHEN position('authentication failed' in lower(error_message)) > 0
    THEN 'authentication_failed'
  WHEN position('authorization failed' in lower(error_message)) > 0
    OR lower(error_message) = 'unauthorized'
    OR position(' unauthorized' in lower(error_message)) > 0
    OR position('unauthorized ' in lower(error_message)) > 0
    THEN 'authorization_failed'
  ELSE auth_failure_reason
END
WHERE status = 'error'
  AND auth_failure_reason IS NULL
  AND error_message IS NOT NULL;
