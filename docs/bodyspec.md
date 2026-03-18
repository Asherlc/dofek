# BodySpec Provider

## Authentication

Standard OAuth2 with client credentials.

- **Authorize URL**: `https://app.bodyspec.com/oauth/authorize`
- **Token URL**: `https://app.bodyspec.com/oauth/token`
- **Scopes**: `read:results`

## Environment Variables

- `BODYSPEC_CLIENT_ID` — From BodySpec developer settings
- `BODYSPEC_CLIENT_SECRET` — From BodySpec developer settings

## API

- **Base URL**: `https://app.bodyspec.com`
- **Auth**: `Authorization: Bearer <access_token>`
- **Results list**: `GET /api/v1/users/me/results/?page=1&page_size=100` — paginated list of all scan results
- **Composition**: `GET /api/v1/users/me/results/{result_id}/dexa/composition` — body composition (fat/lean/bone mass per region)
- **Bone density**: `GET /api/v1/users/me/results/{result_id}/dexa/bone-density` — BMD with T/Z-score percentiles
- **Visceral fat**: `GET /api/v1/users/me/results/{result_id}/dexa/visceral-fat` — VAT mass and volume
- **RMR**: `GET /api/v1/users/me/results/{result_id}/dexa/rmr` — resting metabolic rate estimates from multiple formulas
- **Percentiles**: `GET /api/v1/users/me/results/{result_id}/dexa/percentiles` — age/sex percentile rankings
- **Scan info**: `GET /api/v1/users/me/results/{result_id}/dexa/scan-info` — scanner model, timestamps, patient intake

## Data Model

Two tables in the `fitness` schema:

- `dexa_scan` — one row per scan with total body composition, bone density, visceral fat, RMR, and percentiles (JSONB)
- `dexa_scan_region` — one row per body region per scan (android, gynoid, left/right arm, left/right leg, trunk), with per-region composition and bone density

## Quirks

- Not all section endpoints are available for every scan — bone density, visceral fat, RMR, and percentiles may return 404. Only composition is required.
- The preferred RMR formula is "ten Haaf (2014)"; the provider falls back to the first available estimate.
- Patient intake (height in inches, weight in pounds) comes from the scan-info endpoint, not from composition.
