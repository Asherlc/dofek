# Explicit climbing location groups

The user approved explicit provider Area mapping on November 11, replacing the
earlier nickname proposal. Kaya gym `270` and Kilter gym `151237` represent the
same physical gym; their source names and IDs must remain intact.

Use an owner-scoped `area_group` identity and an optional `area.group_id`
membership. Composite [PostgreSQL foreign keys](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK)
enforce owner consistency. A source Area belongs to at most one group; there
are no alias chains, automatic geographic matches, new dependencies, or editor.
The existing source sync writer must preserve manually assigned membership.

The activity-log repository exposes the effective leaf Area's group as
`areaGroupId`. Response version 5 includes this optional field; supported older
responses omit it using the existing [versioned serializer](../../../packages/server/src/contracts/climbing-log-contracts.ts).
Current web and mobile activity lists request version 5. The existing shared
grouping helper uses explicit group IDs before its existing name-path behavior.
Unmapped records cannot bridge different explicit groups. Original source area
paths, map ownership, entry numbers, ordering, and all log occurrences survive.

Deploy only schema in the migration. Assign the confirmed production Areas to
one group as a separate operator transaction after deployment, with exact owner
and provider identities checked; no user-specific data belongs in migration SQL.
Account-erasure fencing and deletion must cover the new owned table through
the existing [discovery and constraint traversal](../../../src/account-erasure/postgres-erasure.ts).

The independent chart fix adds markers at Kilter's raw `createdAt` log instants,
without inventing per-attempt timing. The attempt-count discrepancy remains
unresolved: the user reports 3 in Kilter while its authenticated `/api/logs`
response and the stored raw record both report 1.
