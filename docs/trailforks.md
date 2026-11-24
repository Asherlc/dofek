# Trailforks activity sync

In Dofek, open **Settings → Data Sources → Trailforks → Connect** and
authorize activity access on Trailforks. Trailforks requires Pro or Outside+
for the signed-in activity tools. The provider reads summaries through
`list_my_activities`. Trailforks excludes GPS tracks and activities imported
from Strava. [Trailforks MCP documentation](https://www.trailforks.com/about/features/mcp/)

Dofek runs a daily sync and supports an on-demand sync from Data Sources.
It imports the activities returned by Trailforks' default listing that fall
within the requested sync window. Full account history depends on which
activities Trailforks returns. Each activity retains its source record.
An activity needs a stable source ID and a start time with a known offset.
The listing is additive. A missing activity does not retire a previously
imported record. An omitted title or end time keeps its stored value on refresh.
An explicit upstream null clears it. Dofek validates the whole listing before
writing and rejects it if any row is malformed. After validation, Dofek reports
record-specific PostgreSQL data errors and continues importing later activities.

## Configure an OAuth client

Register a public client with the production callback
`https://dofek.fit/callback`. A separate installation registers its own
callback. Send the exact callback URI to the registration endpoint from
Trailforks' authorization metadata. Use the `authorization_code` and
`refresh_token` grant types, `code` response type, `none` token endpoint
authentication method, and `activities:read` scope. Configure the returned
client ID as `TRAILFORKS_CLIENT_ID` through the environment used by Dofek's
web and worker services. App configuration activates the provider.
[Authorization metadata](https://www.trailforks.com/.well-known/oauth-authorization-server) ·
[Protected resource metadata](https://www.trailforks.com/.well-known/oauth-protected-resource/mcp/account/)

## Verification

Trailforks accepted public-client registration for Dofek's production
callback. The activity response shape and full sync were tested against
synthetic fixtures. Live sign-in, eligibility, response fields, history
coverage, refresh, and revocation still need a test with a Trailforks Pro
or Outside+ account that has recorded activities.
