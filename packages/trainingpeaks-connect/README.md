# TrainingPeaks Connect

Internal API client for TrainingPeaks.

## Features
- **Workouts**: Fetch workout summaries, detailed analysis, and FIT files.
- **PMC**: Access Performance Management Chart (CTL, ATL, TSB) data.
- **Personal Records**: Fetch PRs for Bike and Run (e.g., power, speed).
- **Calendar Notes**: Sync athlete calendar notes.
- **User Profile**: Access basic athlete/user details.

## Technical Details
- **Base URL**: `https://tpapi.trainingpeaks.com`
- **Analysis Base**: `https://api.peakswaresb.com`
- **Auth**: Authenticates via `Production_tpAuth` session cookie.
- **Rate Limiting**: Enforced via a 150ms minimum delay between requests (`REQUEST_DELAY_MS`).
- **Headers**:
  - `Origin: https://app.trainingpeaks.com`
  - `Authorization: Bearer <token>`
- **Constraints**: Workout fetches are limited to 90 days per request.

## Authentication
The client requires a Bearer token exchanged from the `Production_tpAuth` cookie:
```typescript
import { TrainingPeaksConnectClient } from './src/client';

const { accessToken } = await TrainingPeaksConnectClient.exchangeCookieForToken(cookieValue);
const client = new TrainingPeaksConnectClient(accessToken);
```
