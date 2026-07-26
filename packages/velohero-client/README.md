# @dofek/velohero

Unofficial TypeScript client for VeloHero's private workout-export API.

This package is not affiliated with, endorsed by, or supported by VeloHero.
The endpoints and response shapes were observed from VeloHero's web
application, are not a supported public API contract, and may change without
notice. Use only with an account and data you are authorized to access.

## Requirements

- Node.js 22.14 or newer

## Install

```sh
npm install @dofek/velohero
```

## Quick start

```ts
import { VeloHeroClient } from "@dofek/velohero";

const username = process.env.VELOHERO_USERNAME;
const password = process.env.VELOHERO_PASSWORD;
if (!username || !password) {
  throw new Error("Set VELOHERO_USERNAME and VELOHERO_PASSWORD");
}

const { sessionCookie, userId } = await VeloHeroClient.signIn(
  username,
  password,
);
const client = new VeloHeroClient(sessionCookie);

const workouts = await client.getWorkouts("2026-01-01", "2026-01-31");
const firstWorkout = workouts[0]
  ? await client.getWorkout(workouts[0].id)
  : null;

console.log({ userId, workoutCount: workouts.length, firstWorkout });
```

Dates passed to `getWorkouts` use `YYYY-MM-DD`.

## Authentication lifecycle

`VeloHeroClient.signIn(username, password)` posts form data to the observed
`/sso` endpoint and returns:

```ts
{
  sessionCookie: string; // "VeloHero_session=<session token>"
  userId: string;
}
```

Pass `sessionCookie` to the constructor. Treat it like a password: do not log
it or expose it to a browser. The private response does not provide expiry
metadata, and this package has no session-refresh method. When VeloHero rejects
an expired session, sign in again and construct a new client.

Both the constructor and `signIn` accept an optional `fetch` implementation as
their final argument for compatible runtimes and network-level tests.

## Public API

The package root exports `VeloHeroClient`:

- `VeloHeroClient.signIn(username, password, fetch?)`
- `new VeloHeroClient(sessionCookie, fetch?)`
- `client.getWorkouts(dateFrom, dateTo)`
- `client.getWorkout(id)`

Additional modules are available through documented deep imports:

```ts
import {
  parseDurationToSeconds,
  parseVeloHeroWorkout,
  type ParsedVeloHeroWorkout,
} from "@dofek/velohero/parsing";
import {
  mapVeloHeroSport,
  VELOHERO_SPORT_MAP,
} from "@dofek/velohero/sports";
import type {
  VeloHeroSsoResponse,
  VeloHeroWorkout,
  VeloHeroWorkoutsResponse,
} from "@dofek/velohero/types";
```

`parseVeloHeroWorkout` converts VeloHero's string-valued export record to a
provider-neutral activity summary while retaining observed metrics in `raw`.

## Rate limits and errors

Observed client behavior:

- HTTP `429` throws `ProviderRateLimitError` from
  `@dofek/provider-http/rate-limit`. Its `retryAfterSeconds` property is parsed
  from `Retry-After` when present.
- HTTP `502`, `503`, and `504` throw `ProviderServiceUnavailableError` from the
  same module.
- Other unsuccessful sign-in and API responses throw `Error` containing the
  HTTP status and response body.
- The client does not automatically sleep or retry. Callers decide whether and
  when an operation is safe to repeat.
- Successful private responses are represented by TypeScript interfaces, not
  runtime-validated schemas. Be prepared for upstream shape changes.

## Observed private protocol

- Base URL: `https://app.velohero.com`
- Sign-in: `POST /sso` using form fields `user`, `pass`, and `view=json`
- Authentication: `VeloHero_session` cookie
- Workout list: `GET /export/workouts/json`
- Workout detail: `GET /export/workouts/json/{id}`

These details document observed behavior; they are not promises made by
VeloHero.

## Project

- [Source](https://github.com/Asherlc/dofek/tree/main/packages/velohero-client)
- [Issues](https://github.com/Asherlc/dofek/issues)
- [Pull requests](https://github.com/Asherlc/dofek/pulls)
- [MIT License](./LICENSE)
