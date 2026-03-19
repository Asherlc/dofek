# Oura Provider

## Authentication

Uses Oura's public OAuth2 API.

- **Authorize URL**: `https://cloud.ouraring.com/oauth/authorize`
- **Token URL**: `https://api.ouraring.com/oauth/token`
- **Required scopes**: `daily`, `email`, `heartrate`, `heart_health`, `personal`, `session`, `spo2`, `stress`, `workout`, `tag`

### Scope gotchas

- The `stress` scope is required for `daily_stress` and `daily_resilience` endpoints. Without it, these return 401 Unauthorized.
- The `heart_health` scope is required for `daily_cardiovascular_age` and `daily_metrics` endpoints. Without it, these return 401 Unauthorized.
- If new scopes are added, existing users must re-authorize to grant the new scopes.

## API

- **Base URL**: `https://api.ouraring.com`
- **Auth header**: `Authorization: Bearer <access_token>`
- **Pagination**: All list endpoints return `{ data: T[], next_token: string | null }`. Pass `next_token` as a query param to get the next page.
- **Date filtering**: Most endpoints use `start_date` / `end_date` query params (YYYY-MM-DD). The heart rate endpoint uses `start_datetime` / `end_datetime` (ISO 8601).

### Heart rate API: 30-day window limit

The heart rate endpoint (`/v2/usercollection/heartrate`) enforces a maximum 30-day window per request. Requests with a wider date range return 400 Bad Request. The provider chunks heart rate fetches into 30-day windows to work around this.

No other Oura endpoints have this restriction.

### Currently synced data

| Data | Endpoint | Notes |
|------|----------|-------|
| Sleep | `/v2/usercollection/sleep` | Full sleep document with stage durations, HRV, HR |
| Daily readiness | `/v2/usercollection/daily_readiness` | Readiness score and contributors |
| Daily activity | `/v2/usercollection/daily_activity` | Steps, calories, activity score |
| Heart rate | `/v2/usercollection/heartrate` | 5-min interval HR. **30-day max window per request.** |
| SpO2 | `/v2/usercollection/daily_spo2` | Blood oxygen |
| VO2 Max | `/v2/usercollection/vO2_max` | Cardio fitness estimate |
| Workouts | `/v2/usercollection/workout` | Activity type, duration, calories, HR |
| Sessions | `/v2/usercollection/session` | Meditation/breathing sessions |
| Daily stress | `/v2/usercollection/daily_stress` | Requires `stress` scope |
| Daily resilience | `/v2/usercollection/daily_resilience` | Requires `stress` scope |
| Cardiovascular age | `/v2/usercollection/daily_cardiovascular_age` | Requires `heart_health` scope |
| Tags | `/v2/usercollection/tag` | User-created tags |
| Enhanced tags | `/v2/usercollection/enhanced_tag` | Tags with additional metadata |
| Rest mode | `/v2/usercollection/rest_mode_period` | Rest/recovery mode periods |
| Sleep time | `/v2/usercollection/sleep_time` | Recommended sleep/wake times |
