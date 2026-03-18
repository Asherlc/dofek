# RideWithGPS Provider

## Authentication

Public OAuth 2.0 client with PKCE — no client secret. The RWGPS app is registered as a public client, so sending a `client_secret` in the token exchange request fails with `invalid_client`. Instead, the authorization flow uses PKCE (`code_challenge` + `code_verifier`) to authenticate the token exchange.

- **Authorize URL**: `https://ridewithgps.com/oauth/authorize`
- **Token URL**: `https://ridewithgps.com/oauth/token.json`
- **Scopes**: `user`

## Environment Variables

- `RWGPS_CLIENT_ID` — From RideWithGPS developer settings (no secret needed)

## API

- **Base URL**: `https://ridewithgps.com`
- **Auth**: `Authorization: Bearer <access_token>`
- **Sync endpoint**: `GET /api/v1/sync.json?since=<ISO8601>&assets=trips` — returns created/updated/deleted trips since the given timestamp
- **Trip detail**: `GET /api/v1/trips/<id>.json` — returns trip metadata and track points
- **User identity**: `GET /users/current.json` — returns `{ user: { id, email, name } }`

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
