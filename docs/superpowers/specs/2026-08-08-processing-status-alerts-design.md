# Processing Status Alert Clarity

## Context

The Wahoo provider status view currently renders one failed row per dataset in
the failed processing operation. A single provider failure can therefore show
the same generic message many times. The rows also show only the last ready
time, not when the failure occurred, and the current status surface has no
durable way to dismiss an acknowledged failure.

The processing event stream already contains the operation, dataset, stage,
status, and event timestamps needed to present this information. This design
improves the derived status and alert presentation without changing provider
sync behavior or discarding raw processing events.

## Goals

- Show when the current provider failure occurred.
- Show the most recent successful update when one exists.
- Present one alert for one failed provider operation instead of repeating the
  same message for every affected dataset.
- Let a user dismiss a specific failure across web and mobile sessions.
- Remove a dismissed or visible failure automatically once a later operation
  succeeds for the affected data.
- Keep web, mobile, the provider status view, and the alerts page consistent.

## Non-goals

- Changing provider authentication, retry, or sync behavior.
- Deleting or mutating processing operations or stage events.
- Adding client-side freshness or status calculations from raw event data.
- Hiding a new failure merely because an earlier failure was dismissed.
- Adding a general notification-preferences system.

## Design

### Durable dismissal state

Add `fitness.processing_alert_dismissal` in a forward-only Drizzle migration.
The table contains:

- `user_id`, referencing the owning user profile;
- `operation_id`, referencing the processing operation;
- `dismissed_at`, defaulting to the current timestamp; and
- a primary key on `(user_id, operation_id)`.

The dismissal is keyed to the failed operation, not a provider name or dataset
label. This means dismissing one Wahoo failure does not suppress a later Wahoo
failure, and the same account-level choice applies to web and mobile. The
table is an explicit relation for event-level state rather than an opaque JSON
entry in the general user-settings key/value store. PostgreSQL foreign keys
provide the ownership and operation relationships used by the existing
processing schema ([PostgreSQL foreign-key documentation](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK)).

The repository will expose a scoped dismissal operation. It must verify that
the requested operation belongs to the authenticated user before inserting a
row. Repeated dismissal requests are idempotent. The tRPC mutation invalidates
the user's processing-status and processing-alert caches after the insert.

### Server status contract

Extend the processing status response as follows:

- Each dataset receives `lastFailedAt`, derived from the newest matching
  failed event across the scoped operation history.
- Each operation receives `dismissed`, derived from the dismissal relation.

The repository remains the source of these derived values. The clients do not
need to inspect event ordering to decide whether a failure is current or when
it occurred.

The current dataset status continues to come from the newest scoped operation.
Only datasets whose current status is `failed` or `blocked` participate in a
visible failure group. A later ready operation therefore removes the old
failure from the current status response without deleting history.

### Failure grouping

The shared provider-status presentation logic groups current failed/blocked
datasets by their current failed operation. A group contains:

- the operation identifier;
- the provider label;
- the affected dataset labels;
- the failure timestamp;
- the latest successful timestamp among the affected datasets, when present;
- the operation's most relevant error message; and
- whether the operation has been dismissed.

For a Wahoo operation affecting Activities, Hiking, Cycling, Recovery,
Training, and Data sources, the UI shows one failure card with those areas
listed once. If independent operations are current, they remain separate so
one failure cannot obscure another.

### Web and mobile presentation

Both `ProcessingStatusWidget` implementations use the same shared grouping
semantics and display:

- a provider-level heading such as “Wahoo sync didn’t finish”;
- “Failed: [relative time]”;
- “Last successful update: [relative time]” when available;
- one error message;
- a compact affected-areas list; and
- a clearly labeled dismiss button for the failure group.

Dismissal is optimistic only through the normal mutation lifecycle: the
control invokes the server mutation, then invalidates the relevant processing
query. While the mutation is pending, the control is disabled. A mutation
error remains visible through the existing server error presentation instead
of silently hiding the failure.

The existing alerts page and active-alert count consume the same dismissed
operation state. Dismissed current failures are excluded from those surfaces;
new operations still appear normally. The provider detail page continues to
offer its existing sync/reconnect controls.

## Data flow

```text
processing events + operation history
                |
                v
      ProcessingRepository.status()
        | timestamps + dismissal state
        v
  tRPC processing.status / alerts
        | one group per current failed operation
        v
      web + mobile widgets/pages
        |
        v
 processing.dismiss(operationId)
        |
        v
processing_alert_dismissal + cache invalidation
```

## Error handling

- Unknown or user-owned-by-another-user operation IDs fail with a specific
  not-found error.
- Database failures from the dismissal mutation propagate to the client and
  are reported through the existing server error/telemetry path.
- A status read failure continues to preserve cached status where the existing
  widgets already support background-refetch errors.
- Missing timestamps remain explicit: the UI omits the corresponding line
  rather than displaying a fabricated age.

## Testing

Add tests before implementation for:

- repository status deriving `lastFailedAt` and operation dismissal state;
- repository dismissal ownership checks and idempotency;
- tRPC dismissal success, cache invalidation, and not-found behavior;
- alert filtering and active-count behavior for dismissed operations;
- shared grouping of several failed datasets into one provider failure;
- failure time and last-success time rendering;
- automatic removal after a later ready operation;
- dismiss controls and mutation error behavior in web and mobile widgets.

Use executable database integration coverage for the migration/repository
foreign-key behavior where database semantics matter. Keep web/mobile
component tests unit-level and colocated with their source files, following
the repository testing guidance in [`docs/testing.md`](../../testing.md).

## Alternatives considered

### Client-only dismissal

This would avoid a migration, but dismissal would be device-specific and would
reappear on another client or after clearing local state. It does not meet the
account-wide behavior requested here.

### JSON dismissal records in `user_settings`

This would reuse an existing key/value table, but it would encode processing
operation relationships as an opaque document, make cleanup and ownership
constraints weaker, and couple an event-level feature to unrelated settings.
The dedicated relation is clearer and matches the existing relational
processing model.

## Scope of implementation

The implementation is limited to the processing schema migration, processing
repository/router contract, shared processing-status presentation helpers,
web/mobile widgets and alert surfaces, and their tests/fixtures/stories. The
sync worker records classified provider failures so authentication failures
direct users to reconnect while service failures direct them to retry.
