# Account-erasure hardening

Status: extraction plan; this branch does not yet contain the runtime changes.
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
  branch. Migration 0179 and required request-store schema belong to this effort;
  transport acknowledgement migration 0178 and Kafka marker changes do not
  automatically belong here. Resolve any actual shared dependency before release.
- [ ] Carry the corrected catalog payload accounting from `cb6c6810d`, keeping
  the 500-table/1 MiB limits and complete catalog/column scope. Reuse the qualified
  regression fixtures and payload evidence where the extracted code is identical.
- [ ] Finish the approved Q19 source audit of current model identity aliases.
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

Q19 authorized the offline mapping audit/fix, qualification and a read-only image
inspection. It did not authorize application deployment, schema migration, service
pauses, Kafka activation or further production table cleanup. The Q18 empty probe
was already removed and verified; do not repeat that action.

This PR must be reviewable while retaining Redpanda. Prepare its own application
image, migration and recovery proposal after qualification, separate from the
broker cutover. No old mixed-image cutover approval transfers to this PR.

## Review focus

The persisted alias set must match real model lineage; relation capture must drive
actual erasure rather than only satisfy startup; nullable/direct ownership must
preserve unrelated users; snapshot/request-store migrations must remain compatible;
the release must keep Redpanda and existing topic routes unchanged.
