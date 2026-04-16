# @dofek/trainerroad-client

TypeScript client for the TrainerRoad internal API.

## Overview

This package provides a client for interacting with TrainerRoad, allowing for the retrieval of member information, scheduled and completed activities, and career data (FTP and weight).

## Features

- **Authentication**: Supports programmatic sign-in via username and password, handling CSRF tokens and session cookies automatically.
- **Member Info**: Retrieve user details like `MemberId` and `Username`.
- **Activities**: Fetch activities for a specific user and date range.
- **Career Data**: Access career stats including current FTP and weight in kg.
- **Normalization**: Logic to map TrainerRoad activity types (e.g., "Ride", "VirtualRide") to canonical `dofek` activity types.

## Usage

```typescript
const { authCookie, username } = await TrainerRoadClient.signIn(email, password);
const client = new TrainerRoadClient(authCookie);
const activities = await client.getActivities(username, '2024-01-01', '2024-01-07');
```

## Implementation Details

- **Auth Cookie**: Uses the `SharedTrainerRoadAuth` cookie for all authenticated requests.
- **CSRF Extraction**: The `signIn` method performs a GET request to `/app/login` to extract the `__RequestVerificationToken` from the HTML before POSTing credentials.
- **Date Handling**: Activity start times are derived from the `CompletedDate` and `Duration` fields.
- **Activity Mapping**: Differentiates between indoor and outdoor cycling using the `IsOutside` flag.
