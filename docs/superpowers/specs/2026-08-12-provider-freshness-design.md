# Provider Freshness Design

## Problem

The web and iOS dashboards currently call every connected API provider stale
when the newest dashboard observation is before the current date. That
observation is derived from recovery, sleep, or strain data, not from a
provider sync. A provider can therefore complete its scheduled sync and still
be treated as stale simply because it has no observation for today.

## Decision

Provider freshness and health-data coverage are separate concepts.

- Provider freshness is server-authored from that provider's most recent
  successful scheduled sync.
- A provider is overdue only when a connected pull provider has no successful
  sync within the scheduled interval plus one interval of grace. Push-only and
  import-only providers do not receive a scheduled-sync freshness state.
- Dashboard observation dates remain coverage/readiness evidence. They do not
  trigger a provider sync and cannot change a provider's freshness state.

## API and UI

`sync.providers` returns a freshness status and its last successful sync time
for each pull provider. The server owns the evaluation; web and iOS only render
the status, label, and timestamp.

Provider cards render an actionable overdue state only for connected providers
whose successful-sync timestamp exceeds the server's freshness boundary.
Existing connection and authorization states remain unchanged. The dashboard
continues to refresh its own queries, but no longer auto-syncs every provider
because a health observation has not appeared today.

## Data Flow

```text
sync_log successful entries
  -> SyncRepository last successful timestamp per provider
  -> server freshness evaluation
  -> sync.providers response
  -> web and iOS provider cards

dashboard recovery/sleep/strain dates
  -> coverage and readiness displays only
```

## Tests

- Server/repository tests distinguish the latest attempt from the latest
  successful sync and classify current, overdue, and unknown timestamps.
- Web and iOS tests verify that a prior-day dashboard observation does not
  trigger a provider-wide auto-sync.
- Web and iOS provider-card tests verify rendering of the server-authored
  overdue state without client-side freshness calculations.

## Scope

This does not introduce per-vendor polling intervals, alter sync scheduling, or
infer missing health data. All currently scheduled pull providers share the
existing scheduler interval and grace boundary.
