# Kilter log sessions

Status: revised after user clarification; implementation remains paused.

## Intent and chosen approach

Derive a Kilter activity from nearby logs, then connect that activity to the
existing Kaya/WHOOP activities when the evidence links them to one gym visit.
Show the connected activity group as one session on web and mobile while
preserving each source activity and its climbs. The user selected proximity
grouping over daily buckets and manual session creation, then clarified that
wall climbing and board climbing during the same gym visit are one session.

Kilter currently supplies individual logs with `createdAt`, board and gym
identities, but no session identity or measured session bounds. See the
[client](../../../src/lib/kilter-board-client.ts) and
[incident evidence](../../production-incident-baseline.md#2026-11-09--synced-kilter-logs-unavailable-for-local-day-activity-attachment).

## Product rules

- Sort active Kilter logs by their source timestamps, breaking ties by native
  log identity, within the same user and source connection.
- A gap of 10 minutes or more between successive logs starts a new session.
  A change in recorded board or gym identity also starts a new session.
  Unknown identities do not establish a location match or an identity change.
  This is an inactivity gap, not a maximum session length: consecutive nearby
  logs can form a session longer than 10 minutes.
- Midnight does not split a session. Display the first log's local date using
  available trustworthy location/timezone context, otherwise the existing
  configured user timezone. Do not treat a UTC date as a local climbing date.
- Represent each Kilter session as a source activity that can participate in
  the existing connected activity-group model. Overlap connections are
  transitive: Kaya overlaps WHOOP, and Kilter overlaps WHOOP, so all source
  activities belong to one conceptual session even without Kaya/Kilter overlap.
  The [existing grouping domain](../../../src/domain/activity-grouping.ts)
  already computes connected components.
- Show the resulting group once in activity lists and climbing session views,
  with Kaya and Kilter climbs and source attribution on the detail screen.
  A Kilter activity without a matching recorded workout remains visible alone.
- Show first/last log times as a logged-climb window. Do not report that span
  as measured workout duration or use it as a duration-based training load.
  A session with one log has one observed timestamp and unknown duration.
- For the incident's two logs, derive one Kilter activity on November 9 from
  logs approximately 4 minutes 33 seconds apart. Its first log at 17:48:51.544
  falls within WHOOP's recording ending at 17:48:59.410. Connect it to the
  existing Kaya/WHOOP/Peloton group, producing one visible gym activity with
  both wall and board climbs, not two visible activities.
- Preserve explicit user attachments: attached logs stay with their selected
  activity and do not also appear in a derived Kilter session.

The user chose a 10-minute grouping window; interpreting this as an inactivity
gap is the proposed precise rule, not a verified upstream session boundary.
Long rests and delayed logging can change inferred grouping.
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
- The [current overlap selector](../../../src/db/activity-group-reconciliation.ts)
  requires over 80 percent overlap under its supported criteria; the incident's
  approximately eight-second intersection does not satisfy them. Extend
  matching for log-derived climbing activities: a source log timestamp inside
  an active recorded climbing activity establishes an overlap edge for its
  derived activity. Use actual observations, not an unobserved gap between
  logs or an invented duration. Retain existing matching rules for other
  activities and existing user ownership/visibility checks.
- Builders choose the smallest shared projection and API representation that
  satisfy those callers. Session links must remain resolvable when earlier logs
  arrive; prefer resolving an existing member log identity to its current
  session over a new durable session-identity system.
- Keep logs associated with their derived Kilter source activity and connect
  source activities at the group level; do not reassign every Kilter log to a
  WHOOP or Kaya source record. Preserve existing explicit user attachments.
- No unrelated provider rollout, new background service, dependency, or
  configuration secret is included.

## Validation and release

Use tests first for adjacent logs, the exact 10-minute boundary, separate
boards/gyms, midnight/DST, one-log sessions, ownership, explicit attachments,
late history, repeated sync, absence/restoration and duplicate-free totals.
Cover the Kaya–WHOOP–Kilter bridge with the incident's real relative timing,
including an actual log just inside the workout and another just outside;
one-log activities; and an inferred log window intersecting a workout without
any actual log inside it, which must not create that new overlap edge.
Database behavior requires executable PostgreSQL tests, plus ClickHouse tests
if its serving models change; web and mobile must show the same grouped logs
and honest duration state. Review the actual diff and run relevant checks before
release. Validate the existing account's two logs after canonical deployment;
no production repair or runtime change has yet been authorized by this design.
