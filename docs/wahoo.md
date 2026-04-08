# Wahoo Provider

## Authentication

Standard OAuth2 with client credentials (not PKCE — Wahoo requires a client secret).

- **Authorize URL**: `https://api.wahooligan.com/oauth/authorize`
- **Token URL**: `https://api.wahooligan.com/oauth/token`
- **Deauthorize URL**: `DELETE https://api.wahooligan.com/v1/permissions`
- **Redirect URI**: Must be HTTPS (Wahoo rejects HTTP localhost)
- **Scopes**: `email user_read workouts_read offline_data`

We generate a self-signed cert for `https://localhost:9876/callback` to satisfy the HTTPS requirement.

### Token lifecycle notes

- Since January 1, 2026, Wahoo limits each app+user pair to 10 unrevoked access tokens.
- Wahoo does not use an RFC 7009-style `/oauth/token/revoke` endpoint in the Cloud API docs.
- To revoke existing app authorization before a new code exchange, call `DELETE /v1/permissions` with the current bearer token.

## Environment Variables

- `WAHOO_CLIENT_ID` — From Wahoo developer portal
- `WAHOO_CLIENT_SECRET` — From Wahoo developer portal

## API

- **Base URL**: `https://api.wahooligan.com`
- **Auth**: `Authorization: Bearer <access_token>`
- **Workouts**: `GET /v1/workouts?page=1&per_page=50`

## Limitations

- Wahoo developer app must be approved by Wahoo before it can be used by other users (pending as of March 2026)
- Rate limits not documented but appear generous for personal use
