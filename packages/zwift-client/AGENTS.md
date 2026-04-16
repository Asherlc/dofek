# Zwift Client Agent Guide

> Read [README.md](./README.md) first for general architecture and usage.

## Game Client Spoofing
Zwift's production API is restrictive. All requests MUST include specific headers to appear as though they originate from the macOS Game Client:
- `Platform: OSX`
- `Source: Game Client`
- `User-Agent`: `CNL/3.30.8 (macOS 13 Ventura; Darwin Kernel 22.4.0) zwift/1.0.110983 curl/7.78.0`

Failure to include these headers will result in `403 Forbidden` or generic `400 Bad Request` errors.

## Auth Flow
Zwift uses a standard OAuth2 flow with the `password` grant type. Use the `Zwift Game Client` client ID.

## Key Endpoints
- **Activities**: `/api/profiles/{athleteId}/activities` (supports `start` and `limit` paging).
- **Details**: `/api/activities/{activityId}?fetchSnapshots=true`
- **Power**: `/api/power-curve/power-profile`
