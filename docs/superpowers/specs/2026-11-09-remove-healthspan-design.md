# Remove Healthspan

The user explicitly chose “Remove Healthspan end to end” after the remaining
API, mobile Recovery card and analytics callers were identified. This replaces
the previously approved lint-only repair.

Remove the feature's API/router types, mobile payload and card, dormant web
layout entries, scoring/formatting exports, dbt models and build registrations,
and obsolete tests/fixtures. Add a forward-only ClickHouse migration dropping
the two derived Healthspan tables. Preserve raw source facts, shared models,
historical migrations and dated research/incident records. No replacement
score, compatibility bridge, dependency or service is needed. The existing
[maintenance deployment selector](../../../scripts/migration-deployment.ts)
must stop old Recovery readers before the derived tables are dropped, using a
new PostgreSQL journal boundary without changing PostgreSQL schema.

## Approaches

The user chose complete removal over repairing the existing SQL lint issues.
Hiding the card alone would retain unwanted computation and storage. The
smallest complete implementation deletes the feature and reuses the existing
[migration registry](../../../src/db/clickhouse-migrations/registry.ts) and
[processing contracts](../../../src/processing/dataset-contracts.ts).

Retained recovery, body and cycling behavior must continue to pass existing
tests. Follow the repository rule against adding tests for feature absence;
verify removal through typechecking, existing tests, executable migration
checks, dbt builds, lint and a review of references. No production deployment
or database change is part of this work.
