# Merge Selected Activities Design

## Goal

Let a user select multiple activities in the activity log and combine them into
one activity whose displayed time range spans the earliest start through the
latest end. The merged activity must remain merged after later provider syncs.
Web and mobile must offer the same operation.

## Agreed behavior

- Merge at least two visible activities of the same canonical activity type.
- Keep every provider activity row and its raw provider data. Change only group
  membership and group metadata.
- Keep the group whose activity starts earliest as the merged activity's stable
  ID. Preserve links to the other group IDs through the existing alias table.
- Derive the merged start and end from the existing activity view's group bounds
  (`MIN(started_at)` and `MAX(ended_at)`).
- Mark the retained group as manually merged. During later automatic
  reconciliation, treat active records in a manually merged group as connected
  so overlap-based reconciliation cannot split them apart.
- Reject hidden/provider-absent activities and mixed activity types. Validate
  ownership, current visibility, and type consistency on the server as well as
  in the clients.
- Invalidate activity and calendar query caches and refresh ClickHouse analytics
  for affected source records and group IDs after the transaction commits.
- Add a merge action and clear confirmation in the existing bulk-selection
  controls on both platforms. Require two or more eligible selections.

## Data and transaction flow

1. The protected mutation receives selected canonical activity IDs.
2. Inside the account-erasure write fence, acquire the same per-user
   transaction-level advisory lock used by group reconciliation. Resolve all
   requested IDs to currently visible, non-hidden groups and confirm there are
   at least two unique groups with the same canonical type.
3. Select the retained group deterministically by earliest activity start,
   followed by ID as a tie-breaker.
4. Move the selected groups' source rows to the retained group, set its manual
   merge marker, retarget aliases that pointed at retired groups, and create an
   alias from each retired group ID to the retained ID. Commit atomically.
5. Enqueue the existing activity analytics refresh for the old and new group
   IDs and their member records, then invalidate activity and calendar caches.
6. On success, both clients clear selection and refresh their activity lists,
   calendar summaries, and calendar heatmap. On error, display the server's
   actionable message and preserve the selection.

The shared transaction lock is appropriate because PostgreSQL transaction-level
advisory locks are released at commit or rollback; the application's existing
group reconciliation already uses this locking convention. See [PostgreSQL
explicit locking and advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS).

## Schema and reconciliation

Add a non-null boolean marker to `fitness.activity_group`, defaulting to false,
and mirror it in the Drizzle schema and canonical schema artifacts. This marker
stores the user's merge intent; it is not derived activity data.

Extend group reconciliation to read the marker and connect all active members
of marked groups before calculating connected components. Preserve the marker
when groups are consolidated and aliases are retargeted. Leave unmarked groups'
current overlap-based reconciliation unchanged. Foreign keys continue to
enforce group ownership and alias targets; see [PostgreSQL foreign-key
constraints](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK).

## User interface

Add a Merge action beside the existing bulk delete action on web and mobile.
The action is disabled until at least two eligible activities are selected. A
confirmation explains that selected activities will become one activity and
their original provider records will remain as sources. Hidden activities do
not qualify. Mixed types cannot be merged; provide a short explanation when
the selection contains multiple types.

## Errors and boundaries

- Return a specific precondition error if an ID is stale, hidden, unavailable,
  belongs to another user, or if the selected types differ.
- Return a specific validation error if fewer than two distinct visible groups
  remain after resolving selection IDs.
- Do not add an unmerge operation in this change.
- Do not aggregate or rewrite provider measurements. Existing group/read-model
  behavior continues to combine member records.

## Review focus

- Confirm reconciliation keeps marked members together through provider syncs
  and preserves marker state when aliases are retargeted.
- Confirm legacy aliases resolve to the retained group after repeated merges.
- Confirm date bounds, detail/stream lookups, deletion, and analytics refresh
  continue to use the stable merged group ID and all member IDs.
- Confirm web and mobile expose matching eligibility, confirmation, loading,
  error, and success states.
