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
