# WHOOP Whoop

Reverse-engineered WHOOP internal API client.

## Features
- **Authentication**: Complete AWS Cognito-based auth flow (`id.whoop.com`) including MFA (TOTP and SMS) and token refresh.
- **Metrics**: Heart rate (variable steps) and step count.
- **Cycles**: Recovery, strain, and sleep performance data via the core-details BFF.
- **Sleep**: Detailed sleep event records.
- **Journal**: Behavioral impact/journal data.
- **Weightlifting**: Exercise-level strength data and IMU-derived metrics.

## Technical Details
- **Base URL**: `https://api.prod.whoop.com`
- **API Version**: `7`
- **Cognito Client ID**: `37365lrcda1js3fapqfe2n40eh`
- **Headers**:
  - `User-Agent: WHOOP/4.0`
  - `Authorization: Bearer <token>`
- **Rate Limiting**: Implements 429 handling with `Retry-After` header support and exponential backoff.

## Usage
The `WhoopClient` requires a `WhoopAuthToken` (accessToken, refreshToken, userId).

```typescript
import { WhoopClient } from './src/client';

// Simple sign-in (no MFA)
const result = await WhoopClient.signIn(email, password);
if (result.type === 'success') {
  const client = new WhoopClient(result.token);
  const heartRate = await client.getHeartRate('2024-01-01T00:00:00Z', '2024-01-01T23:59:59Z');
}
```
