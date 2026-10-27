# @dofek/zepp-client

Unofficial TypeScript authentication client for the private Zepp/Amazfit cloud
API.

This package is not affiliated with, endorsed by, or supported by Zepp Health.
It reproduces a mobile-client login flow observed from Zepp applications, not a
supported public API contract. Private endpoints, encryption parameters,
headers, and response shapes may change without notice.

Review the [Zepp Terms and Conditions](https://www.zepp.com/terms-and-conditions)
and obtain any authorization required for your use case. Use only your own
account and protect all returned credentials.

## Requirements

- Node.js 22.14 or newer

## Install

```sh
npm install @dofek/zepp-client
```

## Quick start

```ts
import {
  signInToZepp,
  ZeppInvalidCredentialsError,
  ZeppLoginExchangeError,
} from "@dofek/zepp-client";
import type { ZeppSignInResult } from "@dofek/zepp-client/types";

const email = process.env.ZEPP_EMAIL;
const password = process.env.ZEPP_PASSWORD;
if (!email || !password) {
  throw new Error("Set ZEPP_EMAIL and ZEPP_PASSWORD");
}

let session: ZeppSignInResult;
try {
  session = await signInToZepp(email, password);
} catch (error) {
  if (error instanceof ZeppInvalidCredentialsError) {
    throw new Error("Zepp rejected the email or password", { cause: error });
  }
  if (error instanceof ZeppLoginExchangeError) {
    throw new Error(`Zepp token exchange failed with HTTP ${error.status}`, {
      cause: error,
    });
  }
  throw error;
}

console.log({
  userId: session.userId,
  hasLoginToken: session.loginToken !== null,
});
```

Never print `appToken` or `loginToken`. Both should be treated as secrets.

## Result and credential lifecycle

`signInToZepp(email, password, fetch?)` returns:

```ts
interface ZeppSignInResult {
  appToken: string;
  userId: string;
  loginToken: string | null;
}
```

The observed registration exchange asks Zepp for access and refresh material,
but this package's final token exchange exposes only `appToken`, `userId`, and
an optional `loginToken`. It does not expose expiry metadata, MFA handling, or a
refresh method. When Zepp rejects stored credentials, sign in again.

An optional compatible `fetch` implementation can be passed as the third
argument.

## Public API

The package root exports:

- `signInToZepp(email, password, fetch?)`
- `ZeppInvalidCredentialsError`
- `ZeppLoginExchangeError`, including its numeric `status`
- `ZEPP_REGISTRATION_REDIRECT_URI`
- `ZEPP_ENCRYPTED_REGISTRATION_URL`

The result type is a deep import:

```ts
import type { ZeppSignInResult } from "@dofek/zepp-client/types";
```

## Errors and rate limits

Actual package behavior:

- A rejected registration response or malformed redirect throws
  `ZeppInvalidCredentialsError`.
- A non-success token-exchange response throws `ZeppLoginExchangeError` with
  the HTTP status.
- Registration HTTP `429` throws a generic `Error` containing Zepp's response
  body. The client does not parse `Retry-After`, sleep, or retry.
- Unexpected non-JSON token responses throw a generic `Error`.
- A success response with the wrong shape throws a Zod validation error.
- Network errors from `fetch` propagate unchanged.

## Observed private protocol

The current implementation is specifically an observed US/US2 flow:

- encrypted registration at
  `https://api-user-us2.zepp.com/v2/registrations/tokens`
- an AES-128-CBC registration body matching an observed Android client
- manual redirect parsing to obtain an access code and country code
- access-code exchange at an observed US2 Mi Fit endpoint
- generated device identifiers and observed Zepp/Huami client headers

Country selection, client versions, and server routes are currently fixed in
the implementation. These details are observations, not guarantees from Zepp.

## Project

- [Source](https://github.com/Asherlc/dofek/tree/main/packages/zepp-client)
- [Issues](https://github.com/Asherlc/dofek/issues)
- [Pull requests](https://github.com/Asherlc/dofek/pulls)
- [MIT License](./LICENSE)
