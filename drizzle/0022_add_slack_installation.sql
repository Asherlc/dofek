-- Stores Slack app installations for multi-workspace distribution.
-- Each row represents one workspace's installation of the bot.
CREATE TABLE IF NOT EXISTS fitness.slack_installation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id TEXT NOT NULL,
    team_name TEXT,
    bot_token TEXT NOT NULL,
    bot_id TEXT,
    bot_user_id TEXT,
    app_id TEXT,
    -- The installing user's Slack ID (for linking to dofek account)
    installer_slack_user_id TEXT,
    -- Full installation JSON from Bolt (for future-proofing)
    raw_installation JSONB NOT NULL,
    installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT slack_installation_team_unique UNIQUE (team_id)
);

CREATE INDEX IF NOT EXISTS slack_installation_team_idx ON fitness.slack_installation (team_id);
