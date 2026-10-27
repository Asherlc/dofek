# Computed climbing outcomes

User approved removing stored attempt outcomes and computing results from retained
source evidence on 2026-10-15. Existing completion interpretation remains in scope;
Mountain Project top-rope ticks without a result remain unknown.

## Design

Store the original supported result label as `climbing_attempt.source_result` on
the described occurrence. Keep count-expanded occurrences unlabeled. Compute
`outcome` in one PostgreSQL function and expose it through `v_climbing_attempt`;
existing API response contracts continue returning the computed value. Ordinary
PostgreSQL views run their query when referenced rather than storing results:
[PostgreSQL CREATE VIEW](https://www.postgresql.org/docs/current/sql-createview.html).

Migrate known results only when their retained original source label reproduces
the existing outcome. Reject unresolved evidence before removing storage. Preserve
source labels across partial refreshes and match equivalent label corrections to
the existing described attempt. Do not infer completion from rope method, pitch
extent, aid use, or absence of falls alone.

## Tasks and review checkpoints

1. **Raw attempt contract and writer (main):** add a raw record schema separate
   from the computed response schema; replace outcome writes with source labels;
   retain idempotent matching and partial updates. Update normalizer and writer
   tests first, observe failure, implement, verify.
2. **Provider adapters (provider agent):** retain exact supported labels on the
   described attempt for Kaya API/CSV, Mountain Project, OpenBeta, and theCrag.
   Keep current unsupported-label behavior. Review provider regression results.
3. **Schema and migration (migration agent):** add the source column, verify the
   populated backfill, create the computed function/view, update dependent log
   projections, then remove the old column. Exercise actual PostgreSQL behavior
   and reject unverifiable old results. Review migration safety and evidence.
4. **Server readers (server agent):** use the computed view in all outcome
   consumers; preserve API response shapes and web/mobile rendering. Update real
   database fixtures and repository checks. Review computed results and counts.
5. **Historical tooling and lifecycle (main):** adapt conversion, erasure/export,
   shared fixtures, diagrams, and documentation to current storage without
   rewriting applied historical migrations. Verify prepared/finalized tooling.
6. **Whole change review:** run focused and broader unit/mobile, integration,
   type, lint, spelling, migration, and schema checks as appropriate; obtain an
   independent review; fix findings and rerun affected checks. Commit and push.

## Deployment boundary

This change removes a column used by existing web readers and workers. Production
requires coordinated maintenance for all affected readers and writers, followed
by the matching migration and release. Ordinary rolling rollout assumptions do
not apply; see the current [deployment procedure](../../../deploy/README.md).
No production schema or application data changes are authorized by this local
implementation task.
