# Supplement Automator External API

This is the proposed public contract between `dofek-supplement-automator` and
Dofek. It is intentionally separate from the installed-client tRPC contract.

## Authentication

OAuth authorization-code flow with PKCE:

```text
GET  /oauth/authorize
POST /oauth/token
POST /oauth/revoke
```

Required properties:

- public clients use S256 PKCE;
- access tokens are audience-restricted to the Dofek API;
- scopes are explicit and user-bound;
- refresh tokens rotate and can be revoked;
- client secrets are server-side only.

Scopes:

```text
supplements:read
supplements:write
dose-events:write
nutrition:read
webhooks:manage
```

## Read API

```text
GET /api/v1/supplement-schedules
GET /api/v1/supplement-schedules/{scheduleId}
GET /api/v1/supplement-occurrences?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
GET /api/v1/nutrition/daily?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
GET /api/v1/account
```

All responses are scoped to the token subject. Schedule responses expose stable
schedule IDs, the active definition, effective dates, row-based nutrients, and
display order. Occurrence responses expose the current event ID, current status,
scheduled date, and complete provenance history.

Reads support:

```text
ETag: "state-version"
If-None-Match: "state-version"
```

Unchanged reads return `304`.

## Schedule mutations

```text
POST  /api/v1/supplement-schedules
POST  /api/v1/supplement-schedules/{scheduleId}/definitions
PATCH /api/v1/supplement-schedules/{scheduleId}/order
POST  /api/v1/supplement-schedules/{scheduleId}/archive
```

Every mutation requires an `Idempotency-Key` header. Definition edits append an
immutable successor and preserve the stable schedule ID. Nutrients are rows:

```json
{
  "name": "Magnesium Glycinate",
  "amount": 300,
  "unit": "mg",
  "form": "capsule",
  "meal": "dinner",
  "nutrients": [
    { "nutrient_id": "magnesium", "amount": 300 }
  ],
  "effective_from": "2026-08-12"
}
```

## Materialization

```text
POST /api/v1/supplement-occurrences/materialize
```

```json
{
  "start_date": "2026-08-12",
  "end_date": "2026-08-18",
  "timezone": "America/Los_Angeles"
}
```

The operation is user-scoped and idempotent. It creates planned roots for
current/future dates, advances stale planned leaves to `unknown`, and never
infers `taken`. Effective-from is inclusive and effective-to is exclusive.

## Dose events

```text
POST /api/v1/supplement-occurrences/{occurrenceKey}/events
```

```json
{
  "expected_current_event_id": "uuid",
  "status": "taken"
}
```

Allowed external statuses are `taken` and `skipped`. The server appends a
successor and never updates or deletes an existing event. A stale expected leaf
returns:

```http
409 Conflict
```

The response includes the new event ID, scheduled date, status, and current leaf.

## Webhooks

```text
POST https://public-app.example/webhooks/dofek
```

Headers:

```text
X-Dofek-Event-Id: uuid
X-Dofek-Event-Type: supplement.dose_event.appended
X-Dofek-Event-Version: 1
X-Dofek-Timestamp: 2026-08-12T20:00:00Z
X-Dofek-Signature: sha256=<HMAC-SHA256>
```

The signature covers `timestamp + "." + raw_request_body` using the registered
webhook secret. Events include a stable ID, type, version, occurrence time,
user/schedule subject, and the changed resource identifiers. The public app
persists the event ID before acknowledging it, deduplicates retries, and uses
polling to recover from missed delivery.

Event types:

```text
supplement.schedule.created
supplement.schedule.updated
supplement.schedule.archived
supplement.definition.created
supplement.dose_event.appended
account.erasure.started
account.erased
```

Webhook delivery is an invalidation mechanism, not a source of truth. Dofek
must provide bounded retries, delivery metrics, and administrative replay.

## Error contract

```json
{
  "error": {
    "code": "stale_occurrence",
    "message": "The occurrence changed. Refresh and retry.",
    "request_id": "uuid"
  }
}
```

Use `401` for missing/invalid tokens, `403` for insufficient scopes, `404` for
resources outside the token subject, `409` for stale or idempotency conflicts,
`422` for validation errors, and `429` for rate limits.

The contract preserves Dofek's existing rule that only the current explicitly
`taken` event contributes supplement nutrients to canonical nutrition. See
[`docs/schema.md`](schema.md) and
[`PostgreSQL CREATE VIEW`](https://www.postgresql.org/docs/current/sql-createview.html).
