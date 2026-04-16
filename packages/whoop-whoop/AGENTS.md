# Whoop Whoop Agent Guide

> Read [README.md](./README.md) first for general architecture and usage.

## Auth Flow
Whoop uses AWS Cognito through a proxy at `api.prod.whoop.com/auth-service/v3/whoop/`.
1. `InitiateAuth` with `USER_PASSWORD_AUTH`.
2. If `ChallengeName` is returned (e.g., `SOFTWARE_TOKEN_MFA`), call `RespondToAuthChallenge`.
3. Use `_fetchUserId` on the bootstrap endpoint to resolve the numeric user ID required for most service calls.

## Service Quirks
- **Cycles**: The BFF endpoint (`core-details-bff/v0/cycles/details`) is inconsistent. It may return a bare array or a wrapped object (`cycles`, `records`, `data`, or `results`). The client normalizes this.
- **Weightlifting**: The `weightlifting-service/v2` endpoint returns 404 if a workout has no linked exercise-level data (e.g., a "Functional Fitness" workout without Strength Trainer exercises).
- **Rate Limits**: 429s are common during bulk sync. The client retries up to 3 times.
- **User Agent**: Must be `WHOOP/4.0` or similar for some endpoints to behave correctly.
