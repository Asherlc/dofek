# @dofek/garmin-connect

TypeScript client for the Garmin Connect internal API.

## Overview

This package is a high-fidelity client for Garmin Connect, mirroring the functionality of popular tools like `garth` and `python-garminconnect`. It supports the complex SSO-based authentication flow and provides access to nearly all metrics available in the Garmin Connect web and mobile apps.

## Features

- **Authentication**: Handles the multi-step SSO flow (CSRF extraction, ticket acquisition, OAuth1 exchange, and OAuth2 conversion).
- **Activities**: Detailed activity summaries and high-frequency time series (streams).
- **Sleep & Stages**: Granular sleep tracking including deep, light, rem, and awake stages, plus SpO2 and respiration during sleep.
- **Biometrics**: Heart rate (resting, min/max, samples), Stress levels, Body Battery, and HRV Status.
- **Training Insights**: Training Status, Acute Load, Training Readiness, and VO2 Max (Running/Cycling).
- **Daily Summaries**: Steps, floors, intensity minutes, and caloric burn.

## Usage

```typescript
const { client, tokens } = await GarminConnectClient.signIn(email, password);
const activities = await client.getActivities(0, 10); // last 10 activities
const sleep = await client.getSleepData('2024-01-15');
```

## Implementation Details

- **Auth Token Persistence**: Both OAuth1 and OAuth2 tokens are returned for persistence. OAuth2 tokens can be refreshed using the OAuth1 token.
- **Mapping**: Extensive mapping from Garmin `typeKey` to canonical `dofek` activity types (e.g., `resort_skiing_snowboarding_ws` -> `skiing`).
- **Date Handling**: Garmin API times are often returned as GMT strings without the `Z` suffix. The parser appends `Z` to ensure correct UTC interpretation.
- **Sleep Stages**: Logic in `parseConnectSleepStages` correctly reconstructs REM cycles by overlapping `remSleepData` with `sleepLevels`.
