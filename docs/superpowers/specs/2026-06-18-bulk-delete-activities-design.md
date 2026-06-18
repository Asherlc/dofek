# Bulk Delete Activities Design

## Goal

Add a cross-platform way to delete multiple activities from the activities list. The feature must work on both web and mobile, preserve existing single-activity delete behavior, and keep deletion semantics consistent with deduped activity groups.

## Current State

Web renders recent activities through `ActivityList`, backed by `activity.list`. Row clicks navigate to the activity detail page. Single-activity deletion exists only on the detail page through `activity.delete`.

Mobile renders the activities tab from `calendar.weekList` and `calendar.activityOverview`. Cards navigate to activity detail. Single-activity deletion exists on the mobile detail screen through `activity.delete`.

`ActivityRepository.delete(activityId)` deletes all member rows for the selected deduped activity group by joining `fitness.v_activity` and `fitness.v_activity_members`. Bulk deletion must preserve that behavior for every selected visible activity.

## Chosen UX

Use an explicit select mode on both platforms.

Normal browsing stays unchanged:

- Web rows navigate to activity detail.
- Mobile cards navigate to activity detail.

When select mode is active:

- Rows/cards show selection affordances.
- Row/card press toggles selection instead of navigating.
- A compact action area shows the selected count, a destructive delete action, and cancel.
- Delete requires confirmation before the mutation runs.
- Cancel exits select mode and clears selected IDs.

This pattern is discoverable, avoids always-visible destructive controls, and maps cleanly across web and mobile without relying on hidden gestures.

## Server API

Add `activity.bulkDelete` as a protected mutation:

```ts
activity.bulkDelete({ ids: string[] })
```

Input rules:

- `ids` must contain UUID strings.
- `ids` must contain at least one item.
- Duplicate IDs should be deduplicated before repository deletion.

Return shape:

```ts
{ success: true, deletedCount: number }
```

`deletedCount` should represent the number of selected visible activity IDs accepted by the mutation after deduplication, not the number of underlying member rows removed. The repository remains responsible for deleting all member rows belonging to each selected deduped activity.

The mutation should translate missing activity view errors to the same `PRECONDITION_FAILED` message used by `activity.delete`.

## Repository

Add `ActivityRepository.bulkDelete(activityIds: string[]): Promise<number>`.

The method should:

- Deduplicate selected IDs.
- Return `0` without executing SQL if the deduped list is empty.
- Delete from `fitness.activity` where the row ID belongs to any deduped group selected by the user and the row is scoped to `this.userId`.
- Use the existing `fitness.v_activity` and `fitness.v_activity_members` relationship so a selected visible activity deletes every member row in that deduped group.

The existing `delete(activityId)` can delegate to `bulkDelete([activityId])` to avoid two divergent SQL implementations.

## Web Implementation

Extend `ActivityList` as the presentational owner of select-mode UI state. It should accept `onBulkDelete(ids: string[])`, `bulkDeletePending`, and `bulkDeleteError` props from its parent. The behavior should be:

- Render a `Select` button near the list controls when there are activities.
- In select mode, add a checkbox column and show a bulk action bar.
- Clicking a row in select mode toggles that row.
- Clicking a checkbox must not trigger navigation.
- Delete is disabled while no rows are selected or while the mutation is pending.
- Confirmation text includes the selected count and states that deletion cannot be undone.
- On success, invalidate `activity.list`, clear selection, and leave select mode.
- On error, show the server-provided mutation error message.

`RecentActivitiesSection` should own the `activity.bulkDelete` mutation because it already owns the query and pagination state.

Add the missing `ActivityList.stories.tsx` while touching the component. Stories should include default, loading, empty, and select-mode states.

## Mobile Implementation

Add explicit select mode to `packages/mobile/app/(tabs)/activities.tsx`.

Behavior:

- Add a `Select` action in the activity controls area when list data exists.
- In select mode, each card shows a selection indicator.
- Tapping a card toggles selection instead of navigating.
- The bulk action row shows selected count, `Delete`, and `Cancel`.
- Delete uses `Alert.alert` with destructive confirmation.
- On success, invalidate `calendar.weekList`, `calendar.activityOverview`, and `activity.list`, then clear selection and exit select mode.
- On error, display the mutation error message in the existing screen style.

The mobile activity detail screen can keep using `activity.delete`. Its invalidation can be broadened during implementation if tests show stale activity-tab data after returning from detail.

## Data Flow

1. User enters select mode.
2. User selects one or more visible activities.
3. User confirms bulk deletion.
4. Client calls `activity.bulkDelete({ ids })`.
5. Router validates input and calls `ActivityRepository.bulkDelete`.
6. Repository deletes all member rows for each selected deduped activity group, scoped to the current user.
7. Client invalidates affected queries and clears selection.

## Error Handling

Missing activity views produce:

> Activity data is unavailable because the activity view is missing. Run migrations and retry.

Unexpected server errors should surface through the normal tRPC error path. Clients display the server-provided `error.message` rather than replacing it with a generic message.

## Testing

Server unit tests:

- `ActivityRepository.bulkDelete` returns `0` and skips SQL for an empty list.
- `ActivityRepository.bulkDelete` deduplicates IDs and deletes through the deduped activity group join.
- `ActivityRepository.delete` delegates to the shared bulk path.
- `activity.bulkDelete` returns success and the deduped selected count.
- `activity.bulkDelete` maps missing activity views to `PRECONDITION_FAILED`.

Web component tests:

- Default rows still navigate on click.
- Select mode renders selection controls.
- Row clicks toggle selection while in select mode.
- Delete confirmation calls the bulk delete mutation with selected IDs.
- Success invalidates `activity.list` and exits select mode.
- Mutation errors render the server message.

Mobile tests:

- Default cards still navigate on press.
- Select mode toggles selected cards.
- Cancel clears selected IDs and exits select mode.
- Confirmed delete calls `activity.bulkDelete` with selected IDs.
- Success invalidates `calendar.weekList`, `calendar.activityOverview`, and `activity.list`.

## Out of Scope

- Filter-based deletion such as deleting all activities matching current filters.
- Hidden gesture-only deletion.
- Undo or trash recovery.
- Deleting activities from detail pages through the new bulk endpoint.
