# Withings Provider

## Authentication

OAuth2 with client credentials. Withings has a non-standard token exchange that requires `action=requesttoken` in the POST body.

- **Authorize URL**: `https://account.withings.com/oauth2_user/authorize2`
- **Token URL**: `https://wbsapi.withings.net/v2/oauth2`
- **Scopes**: `user.metrics`

### Token Exchange Quirk

Standard OAuth sends `grant_type=authorization_code`. Withings additionally requires `action=requesttoken` in the body, otherwise the token exchange fails silently.

## Environment Variables

- `WITHINGS_CLIENT_ID` — From Withings developer portal
- `WITHINGS_CLIENT_SECRET` — From Withings developer portal

## API

- **Base URL**: `https://wbsapi.withings.net`
- **Auth**: `Authorization: Bearer <access_token>`

## Data

Syncs body measurements from Withings scales, blood pressure monitors, and thermometers:
- Weight, body fat %, muscle mass, bone mass, water %
- Systolic/diastolic blood pressure, heart pulse
- Body temperature

## Limitations

- User hasn't provided credentials yet (as of March 2026)
- `clientSecret` is required (not a public client)
