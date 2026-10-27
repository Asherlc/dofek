# BodySpec Provider

## Authentication

BodySpec publishes an OAuth 2.0 authorization-code flow using its public
`bodyspec-api-ext-v1` client and PKCE. Dofek does not require a BodySpec client secret. The
[current BodySpec OpenAPI document](https://app.bodyspec.com/openapi.json) is the source of truth
for the client, endpoints, scopes, and API operations.

- **Authorize URL**: `https://auth.bodyspec.com/realms/bodyspec/protocol/openid-connect/auth`
- **Token URL**: `https://auth.bodyspec.com/realms/bodyspec/protocol/openid-connect/token`
- **Scopes**: `openid profile email`
- **PKCE**: required

## Environment Variables

No BodySpec-specific environment variables are required. Dofek uses the shared
`OAUTH_REDIRECT_URI` for the browser callback.

## API

- **Base URL**: `https://app.bodyspec.com`
- **Auth**: `Authorization: Bearer <access_token>`
- **Results list**: `GET /api/v1/users/me/results/?page=1&page_size=100` — paginated list of all scan results
- **Composition**: `GET /api/v1/users/me/results/{result_id}/dexa/composition` — body composition (fat/lean/bone mass per region)
- **Bone density**: `GET /api/v1/users/me/results/{result_id}/dexa/bone-density` — BMD with T/Z-score percentiles
- **Visceral fat**: `GET /api/v1/users/me/results/{result_id}/dexa/visceral-fat` — VAT mass and volume
- **Percentiles**: `GET /api/v1/users/me/results/{result_id}/dexa/percentiles` — age/sex percentile rankings
- **Scan info**: `GET /api/v1/users/me/results/{result_id}/dexa/scan-info` — scanner model, timestamps, patient intake

## Data Model

Two tables in the `fitness` schema:

- `dexa_scan` — one row per scan with total body composition, bone density, visceral fat, and percentiles (JSONB)
- `dexa_scan_region` — one row per body region per scan (android, gynoid, left/right arm, left/right leg, trunk), with per-region composition and bone density

## Quirks

- Not all section endpoints are available for every scan — bone density, visceral fat, and percentiles may return 404. Only composition is required.
- Patient intake (height in inches, weight in pounds) comes from the scan-info endpoint, not from composition.
