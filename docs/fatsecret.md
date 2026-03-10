# FatSecret Provider

## Authentication

OAuth 1.0 with 3-legged flow (not OAuth 2.0). FatSecret's OAuth 2.0 only supports client credentials (server-to-server) — user-specific data like food diaries requires OAuth 1.0.

- **Request Token URL**: `https://authentication.fatsecret.com/oauth/request_token`
- **Authorize URL**: `https://authentication.fatsecret.com/oauth/authorize`
- **Access Token URL**: `https://authentication.fatsecret.com/oauth/access_token`
- **Signature Method**: HMAC-SHA1

### Flow

1. App requests a temporary request token (POST to request token URL)
2. User is redirected to FatSecret authorize URL to grant permission
3. FatSecret redirects back with `oauth_verifier` parameter (not `code`)
4. App exchanges request token + verifier for permanent access token

### Token Storage

OAuth 1.0 tokens don't expire. We store them in the existing `oauth_token` table:
- `access_token` → OAuth 1.0 token
- `refresh_token` → OAuth 1.0 token secret
- `expires_at` → set to 2099 (never expires)

## Environment Variables

- `FATSECRET_CONSUMER_KEY` — From FatSecret developer portal
- `FATSECRET_CONSUMER_SECRET` — From FatSecret developer portal

## API

- **Base URL**: `https://platform.fatsecret.com/rest/server.api`
- **Auth**: OAuth 1.0 HMAC-SHA1 signature on every request
- **Format**: `format=json` parameter
- **Food Diary**: `food_entries.get.v2` — returns entries for a given day

### Date Format

FatSecret uses `date_int` — number of days since January 1, 1970 (Unix epoch). Convert with: `date_int = Math.floor(dateMs / 86400000)`.

### API Response

`food_entries.get.v2` returns per-entry:
- **Macros**: calories, protein, carbohydrate, fat
- **Fat breakdown**: saturated_fat, polyunsaturated_fat, monounsaturated_fat
- **Minerals**: sodium, potassium, calcium, iron, cholesterol
- **Other**: fiber, sugar, vitamin_a, vitamin_c
- **Metadata**: food_entry_id, food_id, serving_id, number_of_units, meal

All values are strings (need parsing). Optional fields may be missing entirely.

### Meal Values

`meal` field: "Breakfast", "Lunch", "Dinner", "Other" (capitalized — we normalize to lowercase).

## Data

Syncs food diary entries day-by-day from `since` to today. Each entry becomes a `food_entry` row with full nutritional data.

## Limitations

- Free tier: 5,000 API calls/day (one call per day synced)
- No food categories in diary entries — `food.get` lookup needed for category enrichment (separate API call per unique food_id)
- No supplement-specific categorization — supplements appear as regular food entries
- OAuth 1.0 signing is more complex than OAuth 2.0 (HMAC-SHA1 on every request)
- FatSecret may return an error object instead of empty food_entries for days with no data
