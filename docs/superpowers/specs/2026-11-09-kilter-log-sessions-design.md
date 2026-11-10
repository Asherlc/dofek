# Kilter log sessions

Status: proposed behavior; implementation awaits design approval.

## Intent and chosen approach

Show nearby Kilter logs together as their own climbing activity on web and
mobile, separate from a coincident WHOOP/Kaya workout. The user selected
grouping nearby logs over one bucket per local day or manual session creation.
Daily buckets combine separate visits; manual grouping requires repeated work.

Kilter currently supplies individual logs with `createdAt`, board and gym
identities, but no session identity or measured session bounds. See the
[client](../../../src/lib/kilter-board-client.ts) and
[incident evidence](../../production-incident-baseline.md#2026-11-09--synced-kilter-logs-unavailable-for-local-day-activity-attachment).

## Proposed product rules

- Sort active Kilter logs by their source timestamps, breaking ties by native
  log identity, within the same user and source connection.
- A gap of 60 minutes or more between successive logs starts a new session.
  A change in recorded board or gym identity also starts a new session.
  Unknown identities do not establish a location match or an identity change.
- Midnight does not split a session. Display the first log's local date using
  available trustworthy location/timezone context, otherwise the existing
  configured user timezone. Do not treat a UTC date as a local climbing date.
- Show a distinct Kilter Board activity in activity lists and climbing session
  views, with the grouped climbs available on its detail screen on both clients.
  It stays separate from automatically detected workout activities even when
  their time ranges overlap.
- Show first/last log times as a logged-climb window. Do not report that span
  as measured workout duration or use it as a duration-based training load.
  A session with one log has one observed timestamp and unknown duration.
- For the incident's two logs, show one separate Kilter session on November 9
  at approximately 17:48–17:53 Pacific, retaining the WHOOP/Kaya activity.
- Preserve explicit user attachments: attached logs stay with their selected
  activity and do not also appear in a derived Kilter session.

The 60-minute threshold is a proposed product default, not a verified upstream
session boundary. Long rests and delayed logging can change inferred grouping.
No threshold settings screen or manual session editor is included.

## Implementation constraints and builder decisions

- Keep existing log records as the canonical facts; preserve native identities,
  raw payloads, attempts, grades and provider absence behavior. Normalize the
  raw source timestamp where needed through the existing provider boundary;
  do not add provider-specific fields to the shared schema.
- Compute session grouping on the server as a derived projection, rather than
  writing invented provider activities, duplicating logs, or storing calculated
  session bounds as raw application facts. Stock SQL
  [window functions](https://www.postgresql.org/docs/current/functions-window.html)
  can compare successive observations without a new service or dependency.
- Use existing API, cache and analytics paths. Ensure list, detail, search,
  pagination and climbing summaries resolve the same sessions, including after
  new logs arrive or source logs are retired/restored. Do not count any climb
  twice or add inferred durations to recorded workout totals.
- Builders choose the smallest shared projection and API representation that
  satisfy those callers. Session links must remain resolvable when earlier logs
  arrive; prefer resolving an existing member log identity to its current
  session over a new durable session-identity system.
- No permanent automatic attachment to WHOOP/Kaya, unrelated provider rollout,
  new background service, dependency, or configuration secret is included.

## Validation and release

Use tests first for adjacent logs, the exact 60-minute boundary, separate
boards/gyms, midnight/DST, one-log sessions, ownership, explicit attachments,
late history, repeated sync, absence/restoration and duplicate-free totals.
Database behavior requires executable PostgreSQL tests, plus ClickHouse tests
if its serving models change; web and mobile must show the same grouped logs
and honest duration state. Review the actual diff and run relevant checks before
release. Validate the existing account's two logs after canonical deployment;
no production repair or runtime change has yet been authorized by this design.
