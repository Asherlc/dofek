# Provider Sync Degradation Runbook

Provider sync degradation means a provider step returned usable records but hit a recoverable provider API anomaly, such as stalled pagination, an empty page with a continuation cursor, or a max-page guard. `withSyncLog()` records these as `fitness.sync_log.status = 'degraded'` with the first degradation kind in `degradation_kind`, and reports each degradation through the OpenTelemetry counter `sync.degradations.total`. See [`src/db/sync-log.ts`](../src/db/sync-log.ts), [`src/sync/sync-degradation-reporting.ts`](../src/sync/sync-degradation-reporting.ts), and [`src/sync-metrics.ts`](../src/sync-metrics.ts).

## Query Recent Degraded Steps

```sql
SELECT
  synced_at,
  user_id,
  provider_id,
  data_type,
  degradation_kind,
  record_count,
  error_message,
  duration_ms
FROM fitness.sync_log
WHERE status = 'degraded'
ORDER BY synced_at DESC
LIMIT 100;
```

Use `degradation_kind` as the primary triage dimension. It is a first-class nullable column on `fitness.sync_log`, not text embedded in `error_message`; see [`src/db/schema/events.ts`](../src/db/schema/events.ts).

## Common Meanings

| Kind | Meaning | First check |
|------|---------|-------------|
| `pagination_stalled` | The provider repeated the same cursor or returned a previously seen cursor. | Query `fitness.sync_log` for the matching provider and step, then compare cursor fingerprints in structured logs. |
| `pagination_empty_page_with_cursor` | The provider returned no records while still advertising more pages. | Confirm records fetched before the anomaly were persisted, then check whether the provider API is returning inconsistent pagination metadata. |
| `pagination_max_pages_exceeded` | The shared guard stopped a list fetch after the configured page limit. | Check whether the sync window is too wide or the provider is repeating pages. |
| `optional_endpoint_unavailable` | An optional provider endpoint was unavailable, commonly because the connected account lacks a scope. | Confirm the rest of the provider sync completed and avoid treating this as failed auth for required endpoints. |

## Correlate With Metrics And Logs

1. Query `sync.degradations.total` by `provider`, `step_name`, and `degradation_kind`.
2. Query structured logs for `[provider-sync] Degraded provider sync step`.
3. Compare the logged `cursorFingerprint` value with repeated database rows for the same provider and step.

Only safe context is sent to logs. Raw cursors and tokens are filtered out unless the field is a fingerprint; see the `safeContext()` filter in [`src/sync/sync-degradation-reporting.ts`](../src/sync/sync-degradation-reporting.ts).

## Reconciliation Safety

Activity-list providers must skip absence reconciliation when list pagination degrades. Degraded list fetches are partial by definition, so tombstoning missing activities after a degraded fetch can hide valid upstream activities. Completed authoritative list fetches should still call `finishProviderActivityListSync()` as described in [`src/providers/README.md`](../src/providers/README.md).

## Reconnect Emails And Recovered Authorization Failures

Match the email timestamp to the provider's overall `data_type = 'sync'` attempts
in `fitness.sync_log`, including `origin`, `auth_failure_reason`, and the next
successful attempt. A recovered request rejection does not prove refresh-token
revocation. Compare the matching Sentry event's HTTP breadcrumbs with shared
`[provider-diagnostics]` warnings; see the [sync log writer](../src/db/sync-log.ts)
and [HTTP observer](../src/lib/provider-diagnostics.ts).

For a rejected request, inspect `tokenExpiresAt`,
`tokenExpiresInSecondsAtRequestStart`, `tokenExpiresInSecondsAtResponse`, and
allowlisted `authErrors`. These fields can distinguish expiry during a request
from a provider-reported scope or credential error without exposing credentials.
Expiry metadata is available only when the shared credential lifecycle recorded
it in the current user's context. An HTTP 401 alone remains ambiguous:
[RFC 6750 section 3.1](https://www.rfc-editor.org/rfc/rfc6750#section-3.1)
includes expired, revoked, and malformed credentials under `invalid_token`.

For Strava, compare expiry against both the successful list request and the
rejected detail request. Its [authentication documentation](https://developers.strava.com/docs/authentication/)
defines `expires_at` as the access token's expiration timestamp. Preserve the
historical rejection as unresolved when its expiry and structured error were
not captured; do not infer a reason from a later refreshed token.
