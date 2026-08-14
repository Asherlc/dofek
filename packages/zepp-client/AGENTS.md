# Zepp Client Agent Guide

Read [README.md](./README.md) first for the supported flow, security warning,
and public usage.

## Package boundary

- Keep the package focused on authentication. Provider sync, token persistence,
  refresh policy, environment-variable reads, and logging belong in consuming
  applications.
- The package root resolves to `src/client.ts`; keep
  `signInToZepp`, its error classes, and the two registration constants as its
  intentional runtime API. `ZeppSignInResult` lives in `src/types.ts` and is
  consumed through `@dofek/zepp-client/types`.
- Validate the token-exchange response with the colocated Zod schemas before
  returning credentials. Do not expose raw upstream payloads or add logging
  that could reveal passwords or tokens.
- Treat endpoint, header, encryption, redirect, and form-field values in
  `src/client.ts` as one observed protocol contract. Change them only with
  corresponding evidence and tests.

## Tests

- `src/client.test.ts` is the contract test for the two-request sign-in flow,
  request shape, result normalization, and distinct failure modes.
- Add the failing colocated unit test first, then implement the behavior. Use an
  injected Fetch mock; tests must not contact Zepp.
- Run `pnpm --filter @dofek/zepp-client test`,
  `pnpm --filter @dofek/zepp-client typecheck`, and
  `pnpm --filter @dofek/zepp-client lint`.
