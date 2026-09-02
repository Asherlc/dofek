# Loading Performance Runbook

Use this runbook when a Dofek page, dashboard, or mobile screen feels slow to load. The goal is to identify which layer is delaying useful pixels before changing code. Do not start with a ClickHouse or dbt change unless current evidence shows a request-time backend bottleneck.

## Evidence Gate

Before implementation, record the current evidence in the GitHub issue, incident note, or `.context/` scratch file:

- User-visible symptom: platform, page or screen, filters, and whether the user sees blank content, stale content, a spinner, or an explicit error.
- Current timings: tRPC procedure names, HTTP trace or log timestamps, server duration, ClickHouse duration if present, and client behavior during refetch.
- First fatal or slow line: the earliest log line that proves the slowdown class.
- Slowdown class: one of the taxonomy entries below, or "unknown" if the evidence is still insufficient.

If Axiom queries are unavailable, record the blocker, trace ID if provided, exact command, and time window. Proceed only with changes that are already proven locally or by checked-in incident evidence.

## Slowdown Taxonomy

| Class | Evidence | First fix to consider |
|-------|----------|-----------------------|
| Client blanking existing data | Query has usable cached or previous data, but the UI switches to a full loading state during `isFetching` or date/filter changes. | Keep stale data visible and show subtle refresh/freshness state. |
| Missing cache persistence | Browser or app restart shows blank authenticated pages even though last-known data was recently available. | Add user-scoped, privacy-safe query persistence with clear logout/user-change isolation. |
| Broad invalidation | Pull-to-refresh, sync completion, or mutation invalidates unrelated tRPC query families and causes a refetch storm. | Invalidate only affected query families. |
| tRPC batching interference | A dashboard-critical request waits behind a slow sibling procedure in the same batch. | Route critical procedures independently or split the noncritical sibling. |
| ClickHouse queue wait | Procedure duration is high, but ClickHouse execution spans are short or delayed behind long reads. | Prioritize dashboard-critical reads or bound exploratory/detail reads. |
| Request-time query shape | A named ClickHouse query family is slow in fresh logs and the SQL scans or aggregates too much per request. | Move expensive derived analytics into an incremental dbt model with a domain-and-grain table name. |
| Readiness fan-out | A readiness or freshness endpoint runs broad checks on every page critical path. | Cache briefly while preserving hard failures and response shape. |
| Freshness trust gap | Cached data appears quickly but users cannot tell when it was refreshed or whether it is stale. | Render server-provided freshness timestamps and stale states. |
| Model-to-cache freshness gap | Incremental models finish successfully, but live Redis query keys still contain pre-build responses until their normal TTL expires. | Replay the registered live query keys after the successful model build; bypass cache reads and overwrite only successful recomputations. |

## Axiom Workflow

Use Axiom before backend optimization. Axiom's query language is APL, and the CLI supports running dataset queries from the terminal; see Axiom's official APL and CLI documentation for syntax and command behavior: <https://axiom.co/docs/apl/introduction> and <https://axiom.co/docs/reference/cli>.

1. Discover the production dataset and schema before filtering on fields:

   ```bash
   rtk "$HOME/.agents/skills/axiom-sre/scripts/discover-axiom" prod
   rtk sh -c "printf %s \"['dofek-logs'] | getschema\" | \"$HOME/.agents/skills/axiom-sre/scripts/axiom-query\" prod --since 15m"
   ```

2. Query the page or procedure family that matches the symptom. Start with the names visible in the UI or issue, then include known loading suspects such as `mobileDashboard.dashboard`, `activity.stream`, `recovery.readinessScore`, `recovery.workloadRatio`, `sync.dataHealth`, `sleep.latestStages`, and `healthspan.score`.

3. Separate total request time from child database time. A slow parent with short ClickHouse spans points to batching, queueing, or app-layer work; a slow ClickHouse span points to query shape or ClickHouse resource pressure.

4. Record exact timestamps, procedure names, counts, max or p95 duration, and the chosen slowdown class in the issue before changing backend behavior.

## Client Loading Policy

Dofek uses TanStack Query through tRPC on web and mobile. TanStack Query distinguishes initial pending state from background fetching and supports placeholder data for keeping previous results visible during key changes; see the official guides for background fetching indicators and paginated queries with placeholder data: <https://tanstack.com/query/latest/docs/framework/react/guides/background-fetching-indicators> and <https://tanstack.com/query/latest/docs/framework/react/guides/paginated-queries>.

Follow this policy on both web and iOS:

- Show a blocking loading state only when no usable data exists.
- Keep previous or cached data visible while `isFetching` refreshes in the background.
- Show refresh or stale indicators separately from the empty/loading/error state.
- Do not hide server errors behind a generic message; render the server-provided error message.
- Scope persisted query data by authenticated user and clear or isolate it on logout or user change.
- Prefer targeted invalidation after sync, refresh, and mutations.
- Keep scheduled model-refresh cache warming app-wide and registry-driven: replay
  the exact live user/timezone/path/input keys already registered in Redis
  instead of inventing a finite list for an unbounded query-input space. Redis
  expiration determines whether a registered key is still live; see the
  official [`EXPIRE` command documentation](https://redis.io/docs/latest/commands/expire/).

## Backend And Analytics Gate

Do not add a ClickHouse read model, dbt model, cache, timeout, retry, or queue change until the evidence names the current bottleneck.

For ClickHouse/dbt work, the issue must include:

- Exact tRPC procedure and screen.
- Fresh Axiom aggregate or a recorded Axiom blocker plus checked-in incident evidence.
- ClickHouse evidence: child span duration, query log, memory or row-count signal, or queue-wait signal.
- Why the existing request-time query shape is too expensive.
- Before/after command or query that will validate the fix.

When the evidence supports a read model, put expensive analytics in incremental dbt models under `analytics/models/`, not TypeScript request handlers. Name route-facing tables by domain and grain, such as `daily_recovery` or `weekly_healthspan`, rather than generic `_summary` or `_read_model` suffixes.

## Documentation And Closure

Before closing the issue or PR:

- Update the issue with before/after findings, including any Axiom blocker.
- Link the PR to the issue with `Fixes #<issue>`.
- If this was a production incident or operational debugging session, update the incident baseline with symptoms, evidence, root cause, fix, remaining risk, and follow-up work.
- If docs added third-party behavior claims, cite official docs, specs, or existing internal evidence.
