# VeloHero Client

JSON API client for VeloHero.

## Features
- **Authentication**: SSO-based sign-in returning a session token.
- **Workouts**: Export workouts in JSON format for specific date ranges.
- **Workout Detail**: Fetch detailed data for individual workouts by ID.

## Technical Details
- **Base URL**: `https://app.velohero.com`
- **Auth**:
  - Endpoint: `/sso`
  - Method: POST (`application/x-www-form-urlencoded`)
  - Parameters: `user`, `pass`, `view=json`
- **Session**: Uses a `VeloHero_session` cookie for authenticated requests.

## Usage
```typescript
import { VeloHeroClient } from './src/client';

const { sessionCookie, userId } = await VeloHeroClient.signIn(username, password);
const client = new VeloHeroClient(sessionCookie);

const workouts = await client.getWorkouts('2024-01-01', '2024-01-31');
```
