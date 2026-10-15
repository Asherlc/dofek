# Climbing log model maintenance cutover

This is a coordinated application/schema upgrade for populated databases.
Migrations 0146 and 0147 prepare and finalize the canonical climbing graph;
the intervening conversion runs in bounded transactions. Fresh empty databases
can apply both migrations normally. See the [conversion implementation](../src/db/climbing-log-model-conversion.ts),
[CLI](../scripts/migrate-climbing-log-model.ts), and [schema](../src/db/schema/climbing.ts).

## Preparation and maintenance boundary

1. Select the immutable release image containing the matching migrations,
   converter, server, workers and web client. Coordinate mobile clients with the
   changed RPC contract. Follow the [deployment guide](../deploy/README.md);
   the ordinary apply-all migration step must not precede populated conversion.
2. Verify a fresh backup and an isolated restore using the
   [backup recovery runbook](database-backup-recovery-runbook.md). Rehearse this
   complete procedure against the restored database using the selected image.
   For a containerized restore, inspect its mounts and `SHOW data_directory`
   before loading data. Explicitly place the scratch data directory on a disk
   with room for restored data, indexes and WAL; an unmounted path uses the
   container's writable layer. See Docker's [storage guidance](https://docs.docker.com/engine/storage/).
3. Inventory and quiesce every old reader and writer: API processes, sync/import
   workers, queued jobs, scheduled/manual imports, MCP readers and startup
   migrators. Keep them stopped throughout preparation, conversion and
   finalization. Merely stopping the scheduled worker leaves other callers
   capable of using the old schema. The release normally migrates on startup;
   consult the [deployment migration ordering](../deploy/README.md#deployment-runbook-cold-start-and-db-availability).
4. Review the applicable CDC table mappings and destination contracts. Drain
   and pause affected mirrors, then plan any required mapping replacement and
   destination reload before resuming analytics. The app reads this graph from
   Postgres; do not assume that a table rename updates a CDC destination. Use
   the [mirror contracts](../src/db/peerdb/mirror-contracts.ts),
   [schema validator](../src/db/peerdb/mirror-schema-validator.ts), and
   [PeerDB mirror reference](https://docs.peerdb.io/sql/commands/create-mirror).
5. Supply the existing `DATABASE_URL` through the approved secret environment.
   Do not print secret values or private raw payloads. Store inspection reports
   privately because conflict IDs can identify user records. No new secret or
   automatic external-provider refresh is required by this conversion. See
   [production secret handling](../deploy/README.md#production-secrets).

## Operator commands

Run the following from the selected release with the target environment loaded:

```bash
pnpm migrate:climbing-log-model inspect
pnpm migrate:climbing-log-model prepare
pnpm migrate:climbing-log-model convert --batch-size 100
pnpm migrate:climbing-log-model validate
pnpm migrate:climbing-log-model finalize
```

For an isolated restore with an explicitly supplied `DATABASE_URL`, invoke
`pnpm exec tsx scripts/migrate-climbing-log-model.ts <command>` directly from
the matching release checkout. The package command above calls
[`with-env.ts`](../scripts/with-env.ts), which applies `.env.local` after the
inherited environment and can replace that scratch target. Verify the target
before each phase. Use the locked TypeScript runner rather than assuming
Node's type stripping accepts every construct used by the converter; see the
[CLI source](../scripts/migrate-climbing-log-model.ts) and
[pnpm exec](https://pnpm.io/cli/exec).

`inspect` is read-only and reports source inventory and conflicts. A conflict
makes the command fail. Resolve the evidence before continuing. Conflicting
shared names, ancestry, coordinates or published grades need verified source
evidence and reviewed corrections; creation order and ascent/posting dates do
not establish which catalogue definition is current. Preserve the original
source evidence and review precise corrections rather than arbitrarily
rewriting raw payloads. Leave unresolved cases blocked for review. See the
[preflight checks](../src/db/climbing-log-model-conversion.ts) and
[historical source mapping](../src/db/climbing-log-legacy-source.ts).

`prepare` runs the registered migration prefix through 0146, preserving its
original journal timestamps and complete history metadata in an operator-local
temporary directory. It calls the existing migration runner rather than
changing deployment's apply-all behavior. This leaves the legacy evidence
available until validation. See [prefix copying](../src/db/migration-prefix.ts),
[migration locking](../src/db/migrate.ts), and
[Drizzle migrations](https://orm.drizzle.team/docs/migrations).

`convert` commits at most the requested number of logs per transaction. Its
default batch size is 100. Rerunning resumes unconverted rows; a failed batch
does not partially convert a log. Every batch checks the full retained source
inventory before writes. Keep all old application processes quiesced even
between batches. See the [transactional converter](../src/db/climbing-log-model-conversion.ts)
and PostgreSQL's [transaction behavior](https://www.postgresql.org/docs/current/tutorial-transactions.html).

Conversion preserves log and detailed-attempt UUIDs, creation timestamps,
source raw payloads, tombstones, source ownership and Activity associations.
It restores independent source dates only where retained evidence establishes
them; an attached Activity's day does not fill an unknown source date. Published
and reported grade roles remain distinct. Reported totals become scoped
Attempt rows; missing totals retain one occurrence or existing detailed rows.
Legacy local ordinals do not establish global attempt order. Fell/Hung leaves
completion unknown; ambiguous `clean=false` and unsupported failure taxonomies
block conversion rather than inventing canonical facts. See the
[executable conversion cases](../src/db/climbing-log-model-conversion.integration.test.ts).

`validate` checks conversion coverage, scoped counts, retained execution facts,
owned grades, ownership and target/parent graphs. It must report no remaining
conflicts before finalization. Inspect UUID retention, user/provider inventories,
native points, source dates and representative current hierarchy projections
on the rehearsal database. The [lifecycle tests](../src/export.integration.test.ts)
also exercise export of the complete owned graph.

`finalize` validates again and applies the full tracked migration directory.
0147 removes legacy columns and the preparation marker, renames canonical log
storage, and installs final constraints and projections. No dual storage,
legacy write path or compatibility alias remains. An already finalized schema
is detected before an earlier prefix is attempted. PostgreSQL describes these
DDL operations in [ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html);
the exact guards are in [0147](../drizzle/0147_climbing_log_model_finalize.sql).

The SQL carries statement-level Squawk exceptions for intentional column and
object renames, legacy nullability relaxation, replacement of association
constraints, removal of obsolete views, functions and enums, and index removal
during this quiesced transactional upgrade. Each exception records its
maintenance justification beside the operation in [0146](../drizzle/0146_climbing_log_model_prepare.sql)
or [0147](../drizzle/0147_climbing_log_model_finalize.sql).
They do not permit a rolling cutover. PostgreSQL forbids
[`DROP INDEX CONCURRENTLY`](https://www.postgresql.org/docs/current/sql-dropindex.html)
inside a transaction; the remaining migration rules stay enabled. See
[Squawk's statement-level directives](https://squawkhq.com/docs/cli#disabling-rules-via-comments).

## Verification and restart

Verify the final inventory, native coordinate order `(longitude,latitude)`,
owned grade collections, parent/Pitch relationships, provider record browsing,
explicit attachment, and representative rock and generic completion queries.
The intentional setting change is that Mountain Project/OpenBeta no longer
imply outdoor from provider identity alone. Missing source facts stay null.
Run the matching release's required migrations/fence checks, validate any
changed CDC destination schema and refresh only affected read models before
resuming analytics. See the [model guide](climbing-context.md),
[account-erasure fences](../src/account-erasure/postgres-erasure.ts), and
[read-model deployment runbook](clickhouse-read-model-deploy-runbook.md).

Restart only matching application processes and clients after these checks.
Before resuming the canonical deployment, verify that the stopped web service's
desired image is the selected release and that its tag still resolves to the
rehearsed digest. The [pre-migration stack apply](../.github/workflows/deploy-web-stack.yml)
reads that desired image even at zero replicas, strips its digest suffix and
restores web replicas. Leaving the legacy desired image would restart old code
against finalized storage. Keep web stopped while updating and verifying the
selected image.
Do not restart the old image against finalized storage. Before 0147, keep
legacy evidence and the verified backup available for reviewed recovery.
After finalization, the recovery choices are a verified backup restore with
the matching old application release, or a reviewed forward repair. Do not
attempt an automatic reverse migration. Follow the
[backup recovery runbook](database-backup-recovery-runbook.md) for restore
verification and the [deployment guide](../deploy/README.md) for release
coordination. This document supplies a reviewable procedure; it does not itself
authorize a production maintenance operation.
