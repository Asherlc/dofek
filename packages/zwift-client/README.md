# Zwift Client

Internal API client for Zwift.

## Features
- **Authentication**: OAuth2 password grant and token refresh support.
- **Profile**: Fetch athlete profile data.
- **Activities**: List activity summaries and fetch detailed activity records (with snapshots).
- **Fitness Data**: Access fitness/performance data from linked URLs.
- **Power Curve**: Fetch the athlete's power profile/curve.

## Technical Details
- **Auth URL**: `https://secure.zwift.com/auth/realms/zwift/protocol/openid-connect/token`
- **API Base**: `https://us-or-rly101.zwift.com`
- **Client ID**: `Zwift Game Client`
- **Mandatory Headers**:
  - `Platform: OSX`
  - `Source: Game Client`
  - `User-Agent`: Spoofs a modern macOS Zwift game client (macOS 13 Ventura, Darwin 22.4.0).
  - `Authorization: Bearer <token>`

## Usage
```typescript
import { ZwiftClient } from './src/client';

const { accessToken, refreshToken } = await ZwiftClient.signIn(username, password);
const client = new ZwiftClient(accessToken, athleteId);

const profile = await client.getProfile();
```
