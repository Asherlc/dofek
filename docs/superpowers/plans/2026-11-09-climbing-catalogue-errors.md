# Climbing catalogue failure handling

> Execute with the subagent-driven-development workflow. Direction approved by the user in this conversation.

**Goal:** Keep usable catalogue metadata when another source fails, present concise errors on web and mobile, and diagnose source-specific failures.

**Architecture:** Use the existing Fetch errors, catalogue search, cache context, and client disclosure controls. No dependency, database schema, or response schema changes. A catalogue-specific `AggregateError` carries successful source results and original provider failures to the application, which owns Sentry reporting and cache policy. Native lookup still runs first; its failure allows discovery from the original seed, never invented identity evidence. `Promise.allSettled` is the stock primitive for collecting independent provider outcomes ([ECMAScript](https://tc39.es/ecma262/multipage/control-abstraction-objects.html#sec-promise.allsettled)).

## Constraints

- No branch switching, recursive delegation, new dependencies, retries, timeouts, fallbacks to unverified identities, or disabled checks.
- Tests first; unit tests must not require external services. Keep recorded facts and matching rules intact.
- Preserve provider attribution and original failure objects. The app reports aggregate failures to Sentry; the independent library must not import app telemetry.
- Public errors contain provider, HTTP status, and an action; upstream response bodies remain in existing diagnostic properties, never default error messages.
- Existing cache/API context shape remains valid; use the existing cache key version to invalidate old raw-HTML error entries.
- Both client platforms get equivalent accessible warning/disclosure behavior. Keep recorded climbs visible.

## Task 1: Partial source results and concise transport errors

Files: `packages/provider-http/src/rate-limit.ts`, its test; `packages/climbing-catalogue/src/search.ts`, its test and README; `src/climbing-catalogue.ts`, its test.

- [x] Write and run failing tests: 429/502 messages remain actionable while responseBody is preserved; successful sources survive a failed discovery source; failed native lookup still searches others with original seed; native called once; multiple failures retain causes; schema/identity failures remain failures; all-failed refresh preserves prior cache; partial refresh caches fresh successful sources and error state and reports to Sentry.
- [x] Introduce exported `CatalogueSearchError extends AggregateError` in search.ts with `sources: CatalogueSourceResult[]`. Collect provider outcomes with stock promises, native first, and throw this aggregate only when some sources fail. Include provider identity in concise aggregate messages while keeping original errors in `errors`. Successful search return type remains unchanged.
- [x] Service `markFailed` stores fresh partial sources (when any) and timestamp with the existing one-day failure TTL; all-failed refresh retains existing successful sources and original expiry. Bump catalogue cache key v4 to v5. Continue rethrowing refresh errors for job failure visibility.
- [x] Remove responseBody from default 429/5xx messages; preserve typed diagnostic properties and Retry-After. Update public library documentation with code/standard citations.
- [x] Run focused tests, review diff against this plan and quality constraints, fix findings.

## Task 2: One metadata warning on each client

Files: `packages/web/src/components/ClimbingStrengths.tsx`, `packages/mobile/components/ClimbingStrengths.tsx`, their colocated tests/stories.

- [x] Add failing interaction tests for a single titled warning, accessible expandable provider details, duplicate failures, and continued chart/record visibility.
- [x] Render one warning titled `Catalogue metadata incomplete`, with a short explanation that recorded results remain available. Put unique actionable provider messages behind existing disclosure patterns (web details/summary; mobile existing Pressable disclosure). Do not use one section-failed panel per message. Both platforms have parity; no new framework or dependency.
- [x] Update existing failure stories, run focused client tests and typechecks, review spec/quality and fix findings.

## Task 3: Source diagnosis, verification and incident record

- [x] Inspect exact Sentry events for KAYA rejected details, theCrag 302 and OpenBeta invalid climb. Reproduce public requests without credentials where possible. Fix only causes confirmed by evidence, with tests first; report uncertainty rather than bypassing validation.
- [x] Record timestamps, failing operation, fatal line, causal findings, changes, validation, unresolved upstream risks in `docs/production-incident-baseline.md` with source links.
- [x] Run appropriate unit/mobile suites, package builds/typechecks, lint, packed-library smoke check, and browser visual check using a specific Storybook story with the required quick tunnel.
- [x] Review actual final diff and evidence, commit and push to current remote branch automatically.

## Review focus

- A native failure must not fabricate matching confidence or cause a second native request.
- Partial results must retain error status, original failures, source attribution and bounded cache lifetime.
- Old raw HTML cached errors must not survive the cache semantics change.
- Details must be reachable with assistive technology on both clients.
- No source-specific validation is weakened to hide the observed failures.
