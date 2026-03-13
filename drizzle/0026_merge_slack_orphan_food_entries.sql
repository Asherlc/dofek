-- Reassign food entries from Slack-created orphan users to the correct user
-- by matching email addresses between auth_account records.
--
-- The Slack bot previously created new user_profile rows instead of linking
-- to existing users. This migration finds Slack auth_accounts whose email
-- matches another auth_account (e.g., Google/Apple login) and reassigns
-- the orphan's food_entry rows to the correct user.

WITH slack_orphans AS (
  SELECT
    sa.user_id AS orphan_user_id,
    sa.email AS email,
    oa.user_id AS real_user_id
  FROM fitness.auth_account sa
  JOIN fitness.auth_account oa
    ON sa.email = oa.email
    AND sa.user_id != oa.user_id
  WHERE sa.auth_provider = 'slack'
    AND oa.auth_provider != 'slack'
    AND sa.email IS NOT NULL
)
UPDATE fitness.food_entry fe
SET user_id = so.real_user_id
FROM slack_orphans so
WHERE fe.user_id = so.orphan_user_id;

-- Also repoint the Slack auth_account itself to the real user
WITH slack_orphans AS (
  SELECT
    sa.user_id AS orphan_user_id,
    sa.email AS email,
    oa.user_id AS real_user_id
  FROM fitness.auth_account sa
  JOIN fitness.auth_account oa
    ON sa.email = oa.email
    AND sa.user_id != oa.user_id
  WHERE sa.auth_provider = 'slack'
    AND oa.auth_provider != 'slack'
    AND sa.email IS NOT NULL
)
UPDATE fitness.auth_account aa
SET user_id = so.real_user_id
FROM slack_orphans so
WHERE aa.user_id = so.orphan_user_id
  AND aa.auth_provider = 'slack';
