# @dofek/trainerroad-client (Agent Info)

> **Read the README.md first!** It covers the general overview and usage.

## Mandates
- **Auth Token Handling**: When implementing sync, ensure the `SharedTrainerRoadAuth` cookie is stored and reused. Use `TrainerRoadClient.signIn` to refresh if the session expires.
- **CSRF Awareness**: If the login flow breaks, check if TrainerRoad changed the HTML structure for the `__RequestVerificationToken` input field.
- **Activity Parsing**: Always use `parseTrainerRoadActivity` to map raw API responses to `ParsedTrainerRoadActivity`. Note that `endedAt` is mapped from `CompletedDate`, and `startedAt` is calculated as `CompletedDate - Duration`.

## Implementation Details
- **Endpoint**: `https://www.trainerroad.com`
- **Auth Flow**: 
    1. GET `/app/login` (manual redirect) -> Extract `__RequestVerificationToken` and initial cookies.
    2. POST `/app/login` with `Username`, `Password`, and token -> Extract `SharedTrainerRoadAuth` cookie.
- **Types**: 
    - `TrainerRoadActivity` includes `Tss`, `NormalizedPower`, `AveragePower`, and `AverageHeartRate`.
    - `IsOutside` flag is critical for `cycling` vs `virtual_cycling` mapping in `mapTrainerRoadActivityType`.
