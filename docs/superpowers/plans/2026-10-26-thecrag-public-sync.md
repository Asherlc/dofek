# theCrag Public Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Automate public theCrag ticks without a paid token or browser process.

**Architecture:** Resolve a public identity, discover ascent IDs through the Atom
feed, and parse public ascent detail pages. Keep rate limiting and the canonical
climbing log writer; use additive persistence because the feed is not a snapshot.

**Tech Stack:** TypeScript, Impit 0.14.7, Cheerio 1.2.0, existing SAX, Vitest,
PostgreSQL.

**Spec:** [Public sync specification](../specs/2026-10-26-thecrag-public-sync.md).

## Global Constraints

- No paid token, login, browser process, proxy, cookie copying, or TLS bypass.
- Marker `thecrag:public-profile`; numeric resolved account ID; stable ascent IDs.
- Existing entries and attachments survive missing feed events.
- Use the existing public-profile connection form on web and mobile.
- No schema changes or deployment services; dependencies pinned exactly.

## Review Focus

- Feed event dates differ from recorded climb dates.
- Grouped or overlapping events must not duplicate imported ascents.
- Redirects, malformed pages and owner changes must not silently import nothing.
- Old stored API keys must never appear in URLs or lose erasure protection.
- Reported attempt totals must not spread one try's result onto count placeholders.

### Task 1: Public provider reader

**Files:** `src/providers/thecrag/provider.ts`, its unit tests and provider-local
transport/parsing modules with colocated tests as needed.

**Interfaces:** Keep `TheCragProvider(fetchFn?: typeof fetch)`, `authSetup()` and
`sync(run)` public interfaces and `writeClimbingRecords` call. Consume exact
scope marker `thecrag:public-profile` from `identity.ts` (Task 2).

- [x] Write failing tests for username/profile resolution, public identity,
  Atom discovery/paging, owner validation, malformed/blocked content and partial
  request failure; verify failure before implementation.
- [x] Implement Impit GET transport through shared provider HTTP wrapper,
  strict feed validation, public ascent parsing and canonical source mapping.
- [x] Verify recorded date, top rope method, reported count, stable IDs and
  grade/notes omission semantics using sanitized fixtures modeled on live HTML.
- [x] Run focused unit tests and report review concerns.

### Task 2: Identity and additive persistence

**Files:** `src/providers/thecrag/identity.ts`, `persistence.ts`, corresponding
unit tests, `src/providers/thecrag-sync.integration.test.ts`,
`src/account-erasure/remote-snapshot.ts` and integration tests.

**Interfaces:** Export `THECRAG_PUBLIC_PROFILE_SCOPE` and
`isTheCragPublicProfileScope(scopes: string | null | undefined): boolean`.
Keep writer signature; use `persistClimbingLogEntries` internally.

- [x] Write failing preservation/identity/legacy erasure tests first.
- [x] Implement exact scope classification, additive persistence and narrow
  legacy credential erasure prerequisite.
- [x] Adapt real database fixtures to the public source contract; prove
  idempotency, attachment preservation, unseen-entry preservation and isolation.
- [x] Run focused unit and database integration suites.

### Task 3: Connection parity, documentation and verification

**Files:** root dependency manifest/lock; web/mobile auth tests; provider
registration tests; `docs/thecrag.md`, provider READMEs and documentation index.

- [x] Add exact reviewed dependencies; update registration/form tests for
  username/profile URL on both clients.
- [x] Update current docs to the implemented public path, feed limitations and
  owner-managed legacy-key revocation; retain dated transport evidence.
- [x] Run focused checks, root/server/client typechecks and targeted lint.
- [x] Smoke the implemented reader against the live account, perform independent
  review, fix findings, then commit and push without switching branches.
