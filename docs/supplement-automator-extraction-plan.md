# Supplement Automator Extraction Plan

## Goal

Extract the supplement scheduling and dose-recording experience into a public,
multi-user application named `dofek-supplement-automator`. The application owns
the user experience and scheduling cadence while Dofek remains the canonical
data owner and read-only nutrition consumer.

## Approved decisions

- Phase one supports Dofek's current once-per-day schedule model.
- The public application is multi-user.
- Authentication uses OAuth authorization code flow with PKCE.
- The public application owns occurrence materialization and scheduling.
- Dofek web and iOS retain read-only supplement history.
- Polling reconciliation ships first; signed webhooks follow after the API is stable.

## Ownership boundary

The public repository owns UI, OAuth client behavior, API client, materialization
jobs, dose-recording actions, retries, polling, webhook receipt, and application
observability. It must not contain a copy of Dofek's nutrition tables or a second
source of truth.

Dofek owns `fitness.supplement`, `fitness.supplement_definition`,
`fitness.supplement_definition_nutrient`, and the append-only
`fitness.supplement_dose_event` ledger. Dofek also owns the canonical nutrition
views, account erasure, API authentication, and server-side validation. The
schema and serving behavior are defined in
[`src/db/schema/nutrition.ts`](../src/db/schema/nutrition.ts),
[`drizzle/0061_supplement_dose_events.sql`](../drizzle/0061_supplement_dose_events.sql),
and [`docs/schema.md`](schema.md).

## Implementation sequence

1. Add the versioned external API and contract tests to Dofek.
2. Add OAuth client registration, scoped tokens, idempotency keys, ETags, and
   an outbox-backed webhook dispatcher.
3. Create the public repository with web/mobile UX, durable materialization,
   dose recording, polling, and webhook deduplication.
4. Run the public application in read-only shadow mode and compare definitions,
   current event leaves, event history, and canonical nutrition totals.
5. Disable Dofek supplement mutations and remove `auto-supplements` from Dofek's
   provider registration and queue configuration.
6. Keep Dofek read procedures and nutrition views available during a monitored
   migration window, then remove obsolete internal write UI and procedures.

## Dofek changes required

- Add `/api/v1` read/write adapters over `SupplementsRepository`.
- Preserve stable schedule IDs and immutable definition successors.
- Require `expected_current_event_id` for dose transitions and return `409` on
  stale leaves.
- Require `Idempotency-Key` on every external mutation.
- Add OAuth/PKCE resource-server endpoints and scope enforcement.
- Add ETag/If-None-Match to read endpoints.
- Add webhook subscription, delivery, retry, replay, and account-erasure logic.
- Add tests for cross-user isolation, replay, duplicate requests, stale writes,
  timezone windows, definition transitions, and nutrition-view consistency.

## Public repository changes required

- Implement OAuth/PKCE login without shipping a client secret in browser or
  native binaries.
- Implement schedule CRUD and immutable-definition editing through the API.
- Run bounded materialization for the authenticated user's timezone.
- Append `planned` and `unknown` events through the materialization endpoint;
  append `taken` and `skipped` through the dose endpoint.
- Persist idempotency results and webhook event IDs.
- Poll with ETags as the correctness path; use webhooks only for invalidation.
- Expose actionable conflict, authorization, and service-unavailable states.
- Add web and mobile parity tests for loading, empty, stale, conflict, and
  successful-recording states.

## Cutover gates

- No schedule or dose writes from Dofek web/iOS.
- No active `auto-supplements` worker registration.
- Shadow comparison shows no definition, current-leaf, history, or nutrient-total
  divergence.
- Replayed API requests create no duplicate rows.
- Stale event writes consistently return `409`.
- Account erasure removes external authorization and webhook state before the
  Dofek account is considered erased.
- Webhook failure does not prevent correctness because polling reconciles state.

## Configuration ownership

Dofek needs an OAuth resource-server/client registry and webhook signing secret.
The public repository needs its own Infisical project with least-privilege
identities. No existing supplement-specific Infisical key exists in the current
deployment templates. Production secrets are rendered through the existing
[Infisical deployment flow](../deploy/README.md#production-secrets).

Suggested keys:

```text
DOFEK_API_BASE_URL
DOFEK_OAUTH_CLIENT_ID
DOFEK_OAUTH_CLIENT_SECRET       # server-side deployments only
DOFEK_WEBHOOK_SECRET
SENTRY_DSN
OTEL_EXPORTER_OTLP_ENDPOINT
OTEL_EXPORTER_OTLP_HEADERS
```

The append-only event model follows PostgreSQL constraint semantics and the
existing Dofek schema; no historical backfill or duplicate nutrition storage is
part of this extraction. PostgreSQL documents the relevant constraints in
[`DDL constraints`](https://www.postgresql.org/docs/current/ddl-constraints.html).
