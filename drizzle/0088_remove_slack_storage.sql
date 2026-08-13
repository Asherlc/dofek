-- Slack ownership moved to the standalone target-agnostic bot.
DROP TRIGGER IF EXISTS account_erasure_slack_team_write_fence
ON fitness.slack_team_membership;
DROP TRIGGER IF EXISTS account_erasure_slack_team_write_fence
ON fitness.slack_installation;
DROP TABLE IF EXISTS fitness.slack_team_membership;
DROP TABLE IF EXISTS fitness.slack_installation;
DROP FUNCTION IF EXISTS fitness.reject_slack_team_erasure_write();
