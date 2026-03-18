# RideWithGPS Provider

## Authentication

Confidential OAuth 2.0 client — requires `client_secret`. PKCE is **not** supported.

The token response does **not** include `expires_in` or `refresh_token`, meaning tokens are long-lived (effectively permanent until revoked).

- **Authorize URL**: `https://ridewithgps.com/oauth/authorize`
- **Token URL**: `https://ridewithgps.com/oauth/token.json`
- **Scopes**: `user`
- **Token exchange params**: `grant_type`, `code`, `client_id`, `client_secret`, `redirect_uri`

## Environment Variables

- `RWGPS_CLIENT_ID` — From RideWithGPS developer settings
- `RWGPS_CLIENT_SECRET` — From RideWithGPS developer settings

## API

- **Base URL**: `https://ridewithgps.com`
- **Auth**: `Authorization: Bearer <access_token>`
- **Sync endpoint**: `GET /api/v1/sync.json?since=<ISO8601>&assets=trips` — returns created/updated/deleted trips since the given timestamp
- **Trip detail**: `GET /api/v1/trips/<id>.json` — returns trip metadata and track points
- **User identity**: `GET /users/current.json` — returns `{ user: { id, email, name } }`

## Token Exchange Debugging History

The RWGPS token exchange has been broken and "fixed" multiple times. This section documents the investigation so future work doesn't repeat mistakes.

### Timeline of attempts

1. **Initial implementation** — Used `client_secret` via Basic Auth (`tokenAuthMethod: "basic"`). Failed with `invalid_client` because RWGPS's Doorkeeper doesn't support Basic Auth for this app.

2. **Fix #219 (`746a062`)** — Switched from Basic Auth to body params. Still included `client_secret`. Fixed the token refresh path (added `resolveTokens`) but didn't fix the core exchange issue at the time.

3. **Fix #231 (`710f0a6`)** — Incorrectly diagnosed the problem as "RWGPS is a public client." Removed `client_secret` entirely and added `usePkce: true`. This was wrong on both counts — RWGPS requires `client_secret` and does not support PKCE. Every token exchange failed with `invalid_client`.

4. **Fix #245 (`df64feb`)** — Correct fix. Added `client_secret` back (body params, not Basic Auth), removed PKCE. Also fixed `parseTokenResponse` default `expires_in` from 2 hours to 1 year.

### How the root cause was found

- Fetched the actual RWGPS API docs at `https://ridewithgps.com/api/v1/doc/authentication` — they explicitly list `client_secret` as a required token exchange param and make no mention of PKCE.
- Tested the token endpoint with `curl` from the production server — confirmed the endpoint is reachable and returns `invalid_client` when `client_secret` is missing.
- The authorize endpoint (`/oauth/authorize`) does NOT validate `client_id` upfront — even a fake `client_id` gets redirected to the login page. This is why the OAuth flow appeared to "work" up until the token exchange step.

### Secondary issue: token expiry

RWGPS's token response looks like:
```json
{
  "access_token": "...",
  "token_type": "Bearer",
  "scope": "user",
  "created_at": 1234567890,
  "user_id": 123
}
```

No `expires_in`, no `refresh_token`. The shared `parseTokenResponse` defaulted to 7200 seconds (2 hours), causing the app to think the token expired after 2 hours and attempt a refresh — which failed because there's no refresh token. The default was changed to 1 year.

### Key lessons

- **Always check the provider's actual API docs** before assuming client type (public vs confidential) or PKCE support. RWGPS uses Doorkeeper (Rails), which supports both, but the specific app registration determines which is used.
- **The authorize endpoint is not a good test of client_id validity** — Doorkeeper redirects to login regardless of whether the client_id exists.
- **`invalid_client` from Doorkeeper is a generic error** covering: unknown client, missing secret, wrong secret, or unsupported auth method. The error message doesn't distinguish between these cases.
- **If `expires_in` is missing from a token response**, the token likely doesn't expire. Don't default to a short expiry.

## Track Point Format

Track points use single-letter keys:

| Key | Meaning | Unit |
|-----|---------|------|
| `x` | longitude | degrees |
| `y` | latitude | degrees |
| `d` | distance from start | meters |
| `e` | elevation | meters |
| `t` | timestamp | unix epoch seconds |
| `s` | speed | km/h |
| `T` | temperature | celsius |
| `h` | heart rate | bpm |
| `c` | cadence | rpm |
| `p` | power | watts |
