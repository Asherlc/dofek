# Account-erasure hardening

Status: runtime extraction in review; blocked and not merge-ready. The extracted
candidate has its own checks; source-branch qualification does not transfer.
This is one of two independent efforts requested on November 8. The other is
the Kafka broker migration. Both start at main commit
`2752451fb4a7404e5d887d32341595a42a673dcd`; neither is stacked on the other.

## Goal and boundary

Make the account-erasure changes independently reviewable and releasable while
production continues using Redpanda. Preserve full ownership coverage and physical
deletion guarantees; do not change brokers, topic epochs, broker environment-key
names, archive configuration versions or the infrastructure release as a side effect.

The combined [PR #3231](https://github.com/Asherlc/dofek/pull/3231), frozen at
`ed26f38b8`, is the source reference, not this branch's base. The
[latest qualification receipt](https://github.com/Asherlc/dofek/blob/ed26f38b8/docs/evidence/clickhouse-catalog-budget-20261108/README.md)
records the catalog budget correction, approved empty-probe cleanup and the real
ownership-mapping blocker. Existing historical metric-ID audits are complete;
this effort does not repeat them.

## Extraction and validation

- [ ] Inventory and extract the erasure changes in `src/account-erasure/`,
  `src/jobs/account-erasure-*`, `src/jobs/process-account-erasure-request.*`,
  account-erasure database/schema modules, API/router and privacy presentation.
  Trace shared analytics-query ownership and schema dependencies explicitly.
  Adapt against main's current Redpanda interfaces rather than copying Kafka/Pulsar
  transports or unrelated provider/ingress refactors.
- [ ] Classify migrations individually. Preserve existing request identifiers
  and fail-closed guards; do not copy a whole migration journal from the mixed
  branch. [Migration 0179](../../drizzle/0179_account_erasure_identifiers.sql) and required request-store schema belong to this effort;
  transport acknowledgement migration 0178 and Kafka marker changes do not
  automatically belong here. Resolve any actual shared dependency before release.
- [ ] Extract the required shared analytics ownership dependency explicitly.
  [Source migration 0178](https://github.com/Asherlc/dofek/blob/ed26f38b8/drizzle/0178_native_metric_stream_delivery.sql)
  creates `fitness.analytics_query_owner` and `fitness.analytics_stream_state`;
  these are not merely transport acknowledgements. The
  [erasure runtime](https://github.com/Asherlc/dofek/blob/ed26f38b8/src/jobs/account-erasure-runtime.ts)
  uses `withAnalyticsQueryOwner` for identity preparation, fencing and deletion.
  [The owner module](https://github.com/Asherlc/dofek/blob/ed26f38b8/src/analytics/analytics-query-owner.ts)
  imports delivery-group helpers and consults stream-state reservations when
  releasing terminal dirty source intents. Assign the required schema and
  `analytics-query-owner`, `analytics-delivery-group`, `analytics-delivery` and
  `analytics-work-store` dependencies together with their actual publication
  writer callers; erasure-only locking cannot coordinate writers that bypass it.
  Carry their focused tests, erasure runtime tests and real-engine ownership/
  erasure tests, adapting writer integration to current Redpanda routes. Review
  [delivery callers](https://github.com/Asherlc/dofek/blob/ed26f38b8/src/analytics/analytics-delivery.ts)
  and [work-store integration tests](https://github.com/Asherlc/dofek/blob/ed26f38b8/src/analytics/analytics-work-store.integration.test.ts)
  as explicit extraction dependencies. Classify transport acknowledgement,
  Kafka marker and delivery-position changes separately; neither omit 0178
  wholesale nor import its entire migration/journal as an erasure prerequisite.
- [ ] Carry the corrected catalog payload accounting from `cb6c6810d`, keeping
  the [500-table/1 MiB limits and complete catalog/column scope](../../src/account-erasure/clickhouse-erasure-coverage.ts). Reuse the qualified
  regression fixtures and payload evidence where the extracted code is identical.
- [ ] Finish the source audit of current model identity aliases.
  `activity_effort_identity.canonical_activity_id` derives from a real activity
  ID and is absent from the typed mapping. Check persisted `evidence_activity_id`
  in cycling models too. Distinguish persisted columns from temporary CTE aliases.
  Add only proven relations to existing typed declarations; never label a personal
  identifier harmless or exempt a personal table to make startup pass.
- [ ] Write a failing regression before changing mappings. Test actual physical
  erasure, transitive identity capture, nullable relations and unrelated-owner
  preservation on real ClickHouse. Keep unknown identities and invalid types
  rejected. Use current final schema fixtures, not heavyweight historical backfills.
- [ ] Run focused erasure units, real-engine checks on production 26.6 and target
  26.10, typecheck and lint. Test the extracted Redpanda runtime contract rather
  than inheriting the combined branch's passing status. Confirm web/mobile privacy
  behavior stays consistent if that behavior changes.
- [ ] Publish a commit-specific review image. Invoke its unchanged read-only
  coverage inspector against production before proposing an application release;
  do not call CDC prepare as a substitute because it runs migrations first.

Use existing [ClickHouse mutation semantics](https://clickhouse.com/docs/sql-reference/statements/alter/delete)
and the existing erasure/physical-absence machinery. No new validator, identity
registry, skip path, retry layer or operational framework is needed for the known
mapping gap. New unknown blockers must be diagnosed, not hidden by larger limits.

## Release contract

This plan is limited to offline mapping audit/fix and qualification. Production
deployment, migration, service pauses, Kafka activation and table cleanup require
separate explicit approval. Completed source cleanup is recorded in the
[source qualification receipt](https://github.com/Asherlc/dofek/blob/ed26f38b8/docs/evidence/clickhouse-catalog-budget-20261108/README.md);
no cleanup belongs to this extraction.

This PR must be reviewable while retaining Redpanda. Prepare its own application
image, migration and recovery proposal after qualification, separate from the
broker cutover. No old mixed-image cutover approval transfers to this PR.

## Review focus

The persisted alias set must match real model lineage; relation capture must drive
actual erasure rather than only satisfy startup; nullable/direct ownership must
preserve unrelated users; snapshot/request-store migrations must remain compatible;
the release must keep Redpanda and existing topic routes unchanged.

## Extraction checkpoint

The candidate includes bounded request-owned identifiers, snapshot admission,
ClickHouse catalog/physical deletion, PeerDB identity paging and request/runtime
integration. It retains Redpanda configuration, routes and native marker v1.
Migration 0178 contains only the required analytics ownership/state schema;
0179 retains its identifying-request cutover guard. Their journal entries are
selected individually. No Kafka acknowledgement migration is extracted.

The source's unused `analytics-delivery`/`analytics-work-store` coordinator and
delivery-fence modules are omitted: no publication caller uses them in the frozen
source. Required query-owner/group/position helpers remain dependencies of the
erasure implementation. The Kafka tiered-storage manual maintenance
acknowledgement gate is omitted; current Redpanda automatic retention checks remain.

The [typed alias fix](../../src/account-erasure/clickhouse-erasure-coverage.ts) covers persisted `canonical_activity_id` in effort/route
identity models and `evidence_activity_id` in cycling read models. Temporary
group/stale/prior CTE aliases are not new physical-column declarations. See the
[extraction evidence and remaining writer-safety gate](../evidence/erasure-extraction-20261108/README.md).
