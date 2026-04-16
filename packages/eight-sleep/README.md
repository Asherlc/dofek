# @dofek/eight-sleep

TypeScript client for the Eight Sleep internal API.

## Overview

This package provides a client for Eight Sleep mattresses, enabling the retrieval of sleep sessions, biometric trends (HR, HRV, Respiratory Rate), and high-frequency heart rate time series data.

## Features

- **Authentication**: Uses OAuth2 password grant with hardcoded client credentials extracted from the official Android app.
- **Sleep Sessions**: Detailed breakdown of sleep stages (awake, light, deep, rem) and durations.
- **Biometric Trends**: Daily aggregates for resting HR, HRV, respiratory rate, and average bed temperature.
- **Time Series**: Granular heart rate samples recorded during sleep sessions.

## Usage

```typescript
const { accessToken, userId } = await EightSleepClient.signIn(email, password);
const client = new EightSleepClient(accessToken, userId);
const trends = await client.getTrends('UTC', '2024-01-01', '2024-01-07');
```

## Implementation Details

- **Credentials**: Uses `EIGHT_SLEEP_CLIENT_ID` and `EIGHT_SLEEP_CLIENT_SECRET` hardcoded in `client.ts`.
- **User-Agent**: Requests are spoofed with an `okhttp/4.9.3` User-Agent to match the Android app's behavior.
- **Data Model**:
    - `getTrends` returns data for multiple days, including `presenceDuration` vs `sleepDuration`.
    - `parseEightSleepTrendDay` calculates `awakeMinutes` as `presenceDuration - sleepDuration`.
    - Heart rate samples are extracted from `sessions` nested within trend days.
