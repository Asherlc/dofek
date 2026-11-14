# PeerDB catalog migration gate implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Keep native qualification and final independent review explicit.

**Goal:** Restore processing by upgrading the PeerDB catalog through its supported migration command before the release asks the Flow API to inspect existing mirrors.

**Architecture:** Reuse the stock `/home/peerdb/peer-flow migrate` command already present in local Compose. Run it once in the serialized canonical server workflow, against the existing catalog and with the immutable image selected by the Flow API service. Reuse the current private database-operations environment file and overlay network. Preserve the CDC contract gate and final consumer restoration.

**Tech Stack:** Existing GitHub Actions, Docker Swarm, PeerDB 0.37.15, PostgreSQL 18, existing workflow validation and native database qualification.

**Spec:** User explicitly approved "Repair PeerDB compatibility and restore processing" after the failed automatic release. This authorizes stock supported catalog migration, qualification and canonical release. It does not authorize deleting/recreating mirrors, slots, data or owners, manual replica changes, or changing analytics lock/scheduling semantics.

## Evidence and primary sources

- Release [43548055355](https://github.com/Asherlc/dofek/actions/runs/43548055355/job/132304064613) failed at Prepare PeerDB CDC contract: HTTP500, missing catalog column (error42703), before app migrations.
- Direct live catalog inspection on Nov14 found legacy refinery journal52, no Goose journal and no failed column.
- Latest stable upstream release [0.37.15](https://github.com/PeerDB-io/peerdb/releases/tag/v0.37.15) has [migration57](https://github.com/PeerDB-io/peerdb/blob/v0.37.15/flow/db/migrations/00057_qrep_runs_failed.sql) adding the column and migration58 rebuilding an index concurrently.
- [Upstream migration implementation](https://github.com/PeerDB-io/peerdb/blob/v0.37.15/flow/db/migrations.go) bootstraps Goose from the refinery journal and uses stock advisory migration locks. [PR4827](https://github.com/PeerDB-io/peerdb/pull/4827) removed Nexus startup migrations.
- Local `docker-compose.peerdb.yml` already runs the stock command. Production lacks that step. API and worker are0.37.15; old server/snapshot versions alone do not prove the catalog failure cause. Do not expand into unrelated version updates.

## Global Constraints

- Existing branch/workspace only; no branch switch/rebase/new branch. Automatically push commits.
- No SSH deployment mutations or manual Docker service/stack changes. Production migration and restoration run only through the corrected canonical release.
- Never inspect/print environment values, credentials or mirror connection payloads. Catalog fixture copies schema and migration history only, never live peer or flow data.
- Use workspace Compose wrapper with an isolated project suffix for native qualification; preserve all database volumes and other workspace resources.
- No new dependency, secret, environment-input requirement, maintained script, migration retry, larger timeout or custom migration SQL. Existing POSTGRES_PASSWORD is already a required Infisical-managed input.
- Preserve all stock CDC prepare/finalize/verify checks and normal zero-replica drain gates.
- Static configuration uses schema-aware validation and real native command qualification; do not add YAML snapshot tests or a bespoke upgrade harness.
- No analytics model edits in this plan. Resume original profiling after recovery; memory acceptance and adequate net backlog drain remain separate open gates.

## Review Focus

- Migrator image must follow the desired API service's immutable image instead of a second independently drifting version pin.
- Use the existing private secret file without shell tracing, printing secrets, or copying runtime environments.
- Migration failure must stop the release before CDC contract preparation and consumer restoration.
- Existing catalog data and legacy migration history survive bootstrap; a second invocation is a no-op.
- API startup, mirror availability and version changes must not silently bypass migration readiness.

### Task 1: Qualify and add the stock migration gate

**Files:** modify `.github/workflows/deploy-web-stack.yml`, `deploy/README.md`, `docs/production-incident-baseline.md`. The directly related cohort and staging startup corrections are qualified in Task2.

**Interfaces:** Consume the desired `${STACK_NAME}_peerdb-flow-api` service image, existing `DATABASE_OPERATIONS_ENV_FILE` and `${STACK_NAME}_default` network. Produce successful stock catalog migration before `Wait for PeerDB before migrations` and `Prepare PeerDB CDC contract`.

- [ ] Prepare an isolated local catalog using schema-only production dump and non-secret refinery history. Seed one synthetic query replication record; no live mirror/peer records are copied.
- [ ] Run a SQL assertion selecting the failed column before migration. Expected: error42703 matching production; record exit code and exact error.
- [ ] Execute the intended stock migration command against that local catalog with target API0.37.15. Expected: bootstrap52 and apply53–58 successfully; the failed-column query succeeds, synthetic record survives with failed=false and Goose maxversion58. Repeat command: no new migrations or data changes.
- [ ] Add the catalog startup prerequisite using the existing database-readiness budget, then one migration step before PeerDB API reachability/contract checks. Resolve image using stock Docker service inspect metadata; run it on the existing network using the existing private database-operations env file. Map existing POSTGRES_PASSWORD to PEERDB_CATALOG_PASSWORD only inside the container shell; set existing catalog hostname/port/user/database constants and exec the stock binary. No actual environment inspection.
- [ ] Document stock migration ordering and upstream source; update incident cause and validation limits. No custom recovery framework.
- [ ] Validate actionlint, workflow download policy, YAML parsing, focused existing workflow suite and diff/spelling for added prose. Native qualification above is the database behavior proof. Commit and automatically push.
- [ ] Retain the source and native evidence for the single final independent review after Task2.

### Task 2: Preserve existing staging buckets during startup

**Files:** `deploy/docker-compose.yml` and `docker-compose.peerdb.yml`; related runbook and incident receipts.

**Evidence:** live PeerDB staging service is0/1 and repeatedly fails `s3.bucket.create` with bucket-already-exists under SeaweedFS4.52. Upstream [PR11455](https://github.com/seaweedfs/seaweedfs/pull/11455) intentionally rejects duplicate creation to preserve bucket metadata. This is a second concrete PeerDB-restoration prerequisite, not a different storage backend.

- [ ] Reproduce the duplicate-create failure natively with an owned isolated SeaweedFS volume and synthetic bucket/object; no live staging data is copied or deleted.
- [ ] Remove bucket creation from the SeaweedFS process startup. Use the existing AWS CLI lifecycle initializer for HEAD-or-create followed by the existing lifecycle configuration. Reuse its readiness budget; never suppress arbitrary errors or parse an error string as success.
- [ ] Qualify both missing-bucket creation and existing-bucket startup, preserving a synthetic object and bucket metadata through container recreation.
- [ ] Keep production and local Compose in parity. Align remaining PeerDB images with the already-selected0.37.15 cohort so legacy Nexus startup does not compete with the explicit migrator on a fresh catalog. No unrelated dependency or service changes.
- [ ] Run schema-aware Compose validation and changed-file checks. Keep the native fixture and preserve its volume after stopping owned containers.

### Task 3: Canonical release and recovery verification

**Interfaces:** Task1 produces reviewed corrected workflow and native receipts. Require one fresh-context independent final source/spec and quality review, exact final-head full CI and actionable PR feedback before normal merge; preserve all full CI gates.
- [ ] Open/update a PR against current main without changing branches; ensure only intended workflow/docs changes and preserved incident receipts are included.
- [ ] Require full exact-head CI, address actionable feedback, merge normally (no force/admin/auto bypass).
- [ ] Track matching main qualification and only the serialized canonical release. Do not overlap active releases or use a mismatched ref/image.
- [ ] Require catalog migration step, CDC preparation/finalization/canary verification and final service stability all to pass. Capture live Goose version and failed column, preserved mirror identities and healthy source slots read-only, without secrets.
- [ ] Confirm source/digest, healthy web/worker/analytics/sinks, analytics successful cycle and fresh commits in both nonempty sink groups. Capture backlog against arrivals; do not equate restored processing with catch-up.
- [ ] Stop owned local fixture container after qualification; preserve its volume. Update incident receipt and task dashboards. Original backlog heartbeat expiry remains unchanged; no completion or catch-up claim from expiry.
