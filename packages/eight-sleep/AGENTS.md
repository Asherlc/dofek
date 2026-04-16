# @dofek/eight-sleep (Agent Info)

> **Read the README.md first!** It covers the general overview and credentials.

## Mandates
- **Auth Persistence**: Store the `accessToken` and `userId`. Sign-in returns an `expiresIn` value (seconds); refresh the token if necessary.
- **Trend Parameters**: When calling `getTrends`, always set `include-all-sessions=true` and `model-version=v2` to ensure heart rate time series and granular sleep data are included.
- **Parsing Logic**: Use `parseEightSleepTrendDay` for sleep session metadata and `parseEightSleepHeartRateSamples` for the `timeseries` data. Note that `parseEightSleepDailyMetrics` extracts resting HR and HRV from the `sleepQualityScore` object.

## Implementation Details
- **Base URLs**:
    - Auth: `https://auth-api.8slp.net/v1`
    - Client: `https://client-api.8slp.net/v1`
- **User Identification**: The `userId` returned during sign-in is required for all trend requests.
- **Units**: Durations in the raw API are in seconds; the parsing logic converts these to minutes using `secondsToMinutes`.
- **Temperature**: `skinTempC` is extracted from `tempBedC.average` in the `sleepQualityScore`.
