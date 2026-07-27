# @dofek/xert (Agent Info)

> **Read the README.md first.** It documents the public API, authentication,
> security requirements, errors, and compatibility warning.

## Package boundary

- Keep environment-variable reads and token persistence in consuming
  applications. The package accepts explicit credentials and tokens.
- Parse every Xert response through the colocated Zod schemas before returning
  it. See [Zod's parsing API](https://zod.dev/basics).
- Keep `XertClient` independent of Dofek database and sync orchestration.
- Route requests through `@dofek/provider-http` so `429`, `502`, `503`, and
  `504` retain their typed handling.

## Upstream contract

Xert documents password and refresh-token grants with the public client pair.
The page-based activity representation is observed and may differ from the
documented activity list. Check the
[Xert API documentation](https://www.xertonline.com/API.html) and captured
fixtures before changing either boundary.
