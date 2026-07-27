# @dofek/peloton agent guidance

Read `README.md` before changing this package.

- Keep this package independent of Dofek's database, logger, and provider
  orchestration. Consumers supply `fetch`; the package owns only Peloton
  transport, authentication, schemas, and parsing.
- Validate every remote response through the Zod schemas in `src/types.ts`.
  Zod's documented `parse` API returns typed data or throws on invalid input:
  https://zod.dev/basics
- Preserve PKCE for authorization-code exchange. PKCE is defined by RFC 7636:
  https://www.rfc-editor.org/rfc/rfc7636
- Treat private Peloton endpoints and Auth0 HTML as unstable boundaries.
  Update colocated tests before changing an observed request or response.
- Keep provider HTTP handling on `createRateLimitAwareFetch`; HTTP
  `Retry-After` is specified by RFC 9110:
  https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after
