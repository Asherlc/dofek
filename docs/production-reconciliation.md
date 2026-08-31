# Production lineage reconciliation

Production is running `dad875a70`, which descends from the clinical-record
commit [`97e370259`](https://github.com/Asherlc/dofek/commit/97e370259b8b8085035741268ce3cc6f22859f77), while `main` does not contain that
lineage. This document tracks the reconciliation work needed to make source,
deployment, and the production schema agree.

## Scope

Reconcile the clinical-record schema migration, ClickHouse/CDC changes,
server APIs, web and mobile clients, provider statistics, seeds, and their
tests from the deployed lineage through `dad875a70`.

## Constraints

- Preserve the production-applied `0099_canonical_clinical_records` migration.
- Validate both a fresh database and a database where `0099` is already
  recorded as applied.
- Deploy only an image whose commit is reachable from `main`.
