# Wahoo Provider

## Authentication

Standard OAuth2 with client credentials (not PKCE — Wahoo requires a client secret).

- **Authorize URL**: `https://api.wahooligan.com/oauth/authorize`
- **Token URL**: `https://api.wahooligan.com/oauth/token`
- **Redirect URI**: Must be HTTPS (Wahoo rejects HTTP localhost)
- **Scopes**: `user_read workouts_read`

We generate a self-signed cert for `https://localhost:9876/callback` to satisfy the HTTPS requirement.

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
