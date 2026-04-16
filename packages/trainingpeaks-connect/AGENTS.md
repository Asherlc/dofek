# TrainingPeaks Connect Agent Guide

> Read [README.md](./README.md) first for general architecture and usage.

## Auth Lifecycle
TrainingPeaks uses a browser-based session cookie (`Production_tpAuth`) that can be exchanged for an API access token.
- **Exchange**: `POST https://tpapi.trainingpeaks.com/users/v3/token`
- **Refresh**: The cookie itself is refreshed via `GET https://home.trainingpeaks.com/refresh`.

## Analysis vs API
- **Standard API**: Handles workouts, profile, PMC, and PRs.
- **Analysis API**: (`api.peakswaresb.com`) Provides high-resolution time-series data and lap analysis via `/workout-analysis/v1/analyze`. Requires both `workoutId` and `athleteId`.

## Rate Limiting
The client enforces a 150ms delay between all requests. Be careful during bulk historical syncs to respect this.

## Limits
- Date ranges for workouts must not exceed 90 days.
- Sport types for PRs are strictly "Bike" or "Run".
