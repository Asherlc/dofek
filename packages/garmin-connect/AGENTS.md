# @dofek/garmin-connect (Agent Info)

> **Read the README.md first!** It covers the general overview and supported metrics.

## Mandates
- **Auth Sequence**: The `signIn` flow is fragile and depends on specific headers. 
    1. Visit `sso.garmin.com/sso/embed` to set cookies.
    2. Get CSRF from `sso.garmin.com/sso/signin`.
    3. POST login form to the same URL.
    4. Extract `ticket` and exchange for OAuth1, then OAuth2.
- **MFA Handling**: Currently, MFA is NOT supported. If `extractTitle` returns "MFA", a `GarminMfaRequiredError` is thrown.
- **OAuth Consumer**: Consumer credentials are NOT hardcoded; they are fetched from a public S3 bucket (`thegarth.s3.amazonaws.com`) to match `garth`.
- **Parsing Caveat**: Garmin durations are sometimes in milliseconds (activities) and sometimes in seconds (sleep). Always verify the unit in the `types.ts` or `parsing.ts` implementation.
- **Rate Limiting**: Throws `GarminRateLimitError` on 429. Monitor for this during high-volume syncs.

## Implementation Details
- **User-Agents**: Uses `com.garmin.android.apps.connectmobile` for SSO and `GCM-iOS-5.19.1.2` for API calls.
- **Sleep REM Correction**: Garmin's `sleepLevels` often mark REM as "light" (activity level 1). `parseConnectSleepStages` uses the dedicated `remSleepData` array to override these segments.
- **Stress Samples**: Garmin uses negative values (-1, -2, -3) for periods where stress cannot be calculated (e.g., during activity). These are filtered out in `parseStressTimeSeries`.
