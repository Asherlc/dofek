# Testing Notes

## Native Swift mutation testing

Run the [native mutation runner](../scripts/run-swift-mutation.ts) from the
repository root with Xcode's Swift toolchain on macOS ARM64. Install the
checksum/provenance-pinned MutantKit declared in [mise.toml](../mise.toml)
and [mise.lock](../mise.lock):

```bash
mise install --locked github:juntaki/mutantkit
mise exec -- pnpm tsx scripts/run-swift-mutation.ts --base origin/main
```

The base comparison uses Git's merge base with `HEAD`, so unrelated commits on
main and uncommitted-only paths are not selected. MutantKit tests the working
copy of each selected package. For each changed Swift file, the
runner finds the owning `Package.swift`, reads SwiftPM's compiled source
inventory, and keeps non-test Swift targets. Test files, manifests and excluded
Expo bridge files do not become mutation inputs. See the
[Git comparison contract](https://git-scm.com/docs/git-diff) and
[SwiftPM describe command](https://github.com/swiftlang/swift-package-manager/blob/main/Sources/Commands/PackageCommands/Describe.swift).

The [canonical configuration](../packages/mobile/mutantkit.yml) is shared by
package-local symlinks. Each run derives an exact source scope while retaining
the owning package's full tests. The runner validates source with the official
Swift compiler and matches the plan's complete source inventory and hashes.
The runner rechecks those hashes immediately after execution. Zero-candidate
plans must retain the complete pinned default operator catalogue.
An official verified plan with zero candidates is reported as not applicable,
without a mutation score; its compiler, source and verification evidence is
retained. Missing or malformed selected source still fails. See MutantKit's
[planning interface](https://github.com/juntaki/mutantkit/blob/1e345263e36e1658adeed6ae919b7f5875a2601b/Sources/CLI/Commands/PlanCommand.swift)
and [configuration loading](https://github.com/juntaki/mutantkit/blob/1e345263e36e1658adeed6ae919b7f5875a2601b/Sources/CLI/ConfigurationLoader.swift).

Preparation (`--base origin/main --prepare`) writes a commit-bound campaign
manifest and full per-file plans under `reports/swift-mutation/`. The pinned
tool's [official sharding](https://github.com/juntaki/mutantkit/blob/1e345263e36e1658adeed6ae919b7f5875a2601b/Sources/MutationPlanner/PlanSharding.swift)
partitions every candidate into workers of at most twelve candidates. Uneven
hash partitions are reshaped by increasing the shard count, never by removing
candidates. Workers (`--job '{"file":"<repository-relative.swift>","shard":0}'`)
retain the full owning-package tests and the existing 30-minute step timeout.

Keep every plan, derived configuration, report, verification output and raw
evidence archive. The required merge (`--merge`) revalidates every shard archive
and uses the [official merge command](https://github.com/juntaki/mutantkit/blob/1e345263e36e1658adeed6ae919b7f5875a2601b/Sources/CLI/Commands/MergeCommand.swift)
against the original full plan. Missing, duplicate or changed candidate IDs,
stale sources and failed baselines fail. A shard may contain only unviable
mutants, but each nonempty full-file campaign requires positive measured work.
The required CI aggregate includes preparation, every selected worker and the
full-plan merge, including reverification of zero-candidate files. Inspect
individual matrix outcomes as well as the aggregate; see [CI wiring](../.github/workflows/test.yml) and official
[report reverification](https://github.com/juntaki/mutantkit/blob/1e345263e36e1658adeed6ae919b7f5875a2601b/Sources/MutationModel/ReportReverification.swift).

Each recorded command retains separate `.command.stdout.log` and
`.command.stderr.log` files; `.command.json` holds their paths and the command's
status, signal and startup error when present. File-descriptor recording avoids
the captured-output limit, while human diagnostics replay in bounded chunks
after synchronous completion. Machine verification JSON remains separate; see
[Node subprocess stdio](https://nodejs.org/api/child_process.html#optionsstdio)
and the [runner](../scripts/run-swift-mutation.ts).

Review surviving mutants and add tests for real coverage gaps. Assertion kills,
confirmed crashes/timeouts, survivors, compile failures and inconclusive outcomes
remain distinct under the official
[outcome model](https://github.com/juntaki/mutantkit/blob/1e345263e36e1658adeed6ae919b7f5875a2601b/Sources/MutationModel/MutationOutcome.swift).
Nonempty plans retain the existing positive-work policy without a numeric
threshold; having candidates but no measurable outcomes still fails. Default optional independent assertion confirmation can
remain unverified; that status does not establish named-test attribution.
Native unit tests, app builds and Simulator checks remain separate;
physical background reconnection and capture still require a device.

For queue query tests, seed persisted SQLite rows directly instead of replaying
ingestion for every fixture and isolated mutation. SQLite supports bounded
set-based fixtures through [recursive CTEs](https://www.sqlite.org/lang_with.html#recursive_query_examples).
The [WHOOP store tests](../packages/mobile/modules/whoop-ble/Tests/WhoopBleSampleStoreTests.swift)
retain 10,000-row instruction-budget fixtures and cross the former 86,400-row
queue boundary through public append after restoring a persisted backlog. They
check actual stored rows as well as lifecycle counters. Keep public ingestion,
acknowledgment, erasure and failure paths under test; fixture setup must not
replace the behavior being verified. This reduces repeated fixture cost while
retaining the full mutation suite and existing CI deadlines.

## CI build caches

Docker layers use the existing central GHCR registry caches:
`ghcr.io/asherlc/dofek:server-buildcache`, `ghcr.io/asherlc/dofek:e2e-buildcache`,
and `ghcr.io/asherlc/dofek-ml:buildcache`. PR checks import these caches without
exporting; trusted main and manual builds publish them. See the
[image builds](../.github/workflows/build-docker.yml),
[ML build](../.github/workflows/build-docker-ml.yml),
[PR checks](../.github/workflows/test.yml), and
[manual builds](../.github/workflows/deploy.yml).
The E2E producer and consumers use matching `DEPENDENCY_CACHE_BUST` inputs.
Native build and dependency caches remain in GitHub Actions; its
[storage limits and least-recently-used eviction](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#usage-limits-and-eviction-policy)
make restored entries expendable. Docker's [registry cache backend](https://docs.docker.com/build/cache/backends/registry/)
keeps layer caches separate from published images and permits builds without a cache hit.
Caches are optional accelerators; successful cached builds do not establish cold-build
correctness or completion within CI deadlines. Validate cold builds separately.

## Integration Dependencies

The default and changed-test commands are intentionally Docker-free:

```bash
pnpm test
pnpm test:changed
pnpm test:coverage
```

Use an explicit integration command when database behavior is under test:

```bash
pnpm test:integration
pnpm test:integration -- src/db/db.integration.test.ts
pnpm test:peerdb-integration
pnpm test:all
pnpm test:changed:all
pnpm test:coverage:all
```

These commands start the current workspace's Postgres, ClickHouse, Redis, and
Redpanda services through `pnpm compose:up` and wait for their Compose health
checks before Vitest starts. Docker documents the `--wait` health-gated startup
behavior in its [Compose startup-order guide](https://docs.docker.com/compose/how-tos/startup-order/).
The command loads `.env.local` and sets `TEST_DATABASE_URL` to the workspace
Postgres URL. Redpanda-backed integration
tests receive the generated workspace-local `REDPANDA_BROKERS` value so they
cannot connect to another workspace's broker. `setupTestDatabase()` fails
immediately when the Postgres URL is absent; it never creates an unbounded
generic Testcontainers instance. Within a Vitest process it creates one
migrated template database and clones an isolated database for each test file.

`pnpm test:peerdb-integration` is the end-to-end CDC contract tier. It adds the
pinned PeerDB/Temporal stack from `docker-compose.peerdb.yml`, runs only
`*.peerdb.integration.test.ts`, and removes the current workspace's disposable
containers and volumes when it finishes. The suite builds the current
ClickHouse raw schema directly, creates mirrors from the checked-in production
contract, and proves that Postgres rows normalize through PeerDB while excluded
source columns remain absent from ClickHouse. This tier intentionally does not
replay heavyweight historical ClickHouse backfills. PeerDB documents table
mapping column exclusions in its
[CREATE MIRROR reference](https://docs.peerdb.io/sql/commands/create-mirror).

The stack runs PeerDB's catalog migration command before starting the API,
workers, and SQL server, following the upstream
[migration service ordering](https://github.com/PeerDB-io/peerdb/blob/v0.37.12/docker-compose.yml).
On startup or test failure, the runner prints container status and service logs
before teardown, preserving evidence from failed initialization services; see
[Compose logs](https://docs.docker.com/reference/cli/docker/compose/logs/).

The Vitest projects remain separate in CI: unit, mobile, four database integration
shards, and the PeerDB CDC integration tier are invoked explicitly. Stryker uses the Docker-free mutation config and
must not collect `*.integration.test.ts` files. CI mutation discovery therefore
only sends changed TypeScript files with a colocated `.test.ts` or `.test.tsx`
unit suite to Stryker; integration-only implementations are covered by the
integration shards instead of being counted as uncovered Docker-free mutants.
Use `pnpm test:integration` for integration behavior and `pnpm test:mutation`
for mutation quality; do not mix the two execution models.

For dbt first-build schema tests, execute the adapter's actual
[`CREATE TABLE ... EMPTY AS` path](https://github.com/ClickHouse/dbt-clickhouse/blob/v1.10.3/dbt/include/clickhouse/macros/materializations/table.sql),
then compare the created table's complete schema with the canonical table and
verify inserted rows. On pinned ClickHouse 26.6.1.1193,
[`DESCRIBE TABLE (SELECT ...)`](https://github.com/ClickHouse/ClickHouse/blob/v26.6.1.1193-stable/src/Interpreters/InterpreterDescribeQuery.cpp#L155-L173)
can build unexecuted materialized CTE plans that retain source tables and block
synchronous cleanup; the [incident record](production-incident-baseline.md#2026-10-28--describe-subquery-retained-cadence-source-tables-during-ci-teardown)
documents the executable reproduction and ownership evidence.

Sources:

- PostgreSQL `CREATE DATABASE` template option: https://www.postgresql.org/docs/current/sql-createdatabase.html
- Vitest test projects: https://vitest.dev/guide/projects
- Vitest `--shard` option for splitting CI test runs: https://vitest.dev/guide/cli.html#shard
- Stryker Vitest runner configuration: https://stryker-mutator.io/docs/stryker-js/vitest-runner/
- Redpanda Kafka API compatibility: https://docs.redpanda.com/current/develop/kafka-clients/

### S3 fixture allocation

The [shared SeaweedFS fixture](../src/account-erasure/test-helpers.ts) configures
`master.volume_growth.copy_1 = 1` for its small, single-node test collections.
The pinned release otherwise defaults to [seven volumes per single-copy growth](https://github.com/seaweedfs/seaweedfs/blob/4.47/weed/command/scaffold/master.toml)
and an [eight-volume server cap](https://github.com/seaweedfs/seaweedfs/blob/4.47/weed/command/server.go).
Allocating one at a time keeps multiple test buckets writable without raising
that cap. Real S3 operations, multipart uploads and signed-upload identity
configuration remain exercised by the fixture's integration consumers.

If an S3 fixture returns `InternalError`, run the affected file alone with
`pnpm test:integration <file>`. While its container is running, identify it with
`docker ps` and capture `docker logs <container-id>` before test teardown removes
it. Inspect master/volume errors such as `No writable volumes and no free
volumes left` before changing storage settings or retry behavior. See
[Docker container logs](https://docs.docker.com/reference/cli/docker/container/logs/)
and the [reproduced allocation incident](production-incident-baseline.md#2026-10-31--pr3177-seaweedfs-fixture-volume-exhaustion-unresolved).

### Duration-balanced integration shards

The four integration jobs use one committed measured baseline,
[`scripts/integration-test-timings.json`](../scripts/integration-test-timings.json).
The [sequencer](../scripts/integration-test-sequencer.ts) allocates discovered
files by descending duration to the least-loaded shard, with stable path and
shard tie breaks. It preserves every discovered specification, existing serial
execution, coverage and the 12-minute test-step limit. New or renamed files use
the baseline's positive-duration median and appear explicitly as estimates.
Removed files are never rediscovered from timing data. Other projects retain
Vitest's allocation; see the [public sequence extension](https://v4.vitest.dev/config/sequence).

Do not restore independent result caches as allocation input. All jobs must use
the same checked-in baseline. Preserve the historical runner version that
measured it; a runner upgrade can consume those weights, while all artifacts
in a new complete refresh must match one current runtime. Each job records its
assignment and checks the public per-specification cache before execution. The
[timing reporter](../scripts/integration-timing-reporter.ts) publishes an owned
artifact only after a successful complete run of exactly the assigned files,
with current-run timestamps and matching assignment identity. The export command
validates this artifact before publishing `results.json`; Vitest's internal
cache filename and disk schema are not part of the contract.
The public cache records whole-suite duration, including suite hooks, rather than JSON
reporter intervals between individual tests; import, collection and coverage
overhead remain outside that estimate. See Vitest's
[per-specification cache](https://vitest.dev/api/advanced/vitest#cache)
and [reporter API](https://vitest.dev/api/advanced/reporters).

After a complete successful CI run, download `integration-timings-1` through
`integration-timings-4` from the same run attempt into four separate directories.
Refresh and review the committed baseline with:

```bash
pnpm tsx scripts/update-integration-test-timings.ts merge scripts/integration-test-timings.json <shard1-directory> <shard2-directory> <shard3-directory> <shard4-directory>
```

The command requires coherent revision, run, attempt, runtime, baseline and
inventory provenance, with an exact disjoint union of successful results. Invalid
or incomplete input leaves the old file intact. The existing coverage job also
publishes `integration-timings-complete` after its coverage gates; committing a
baseline update remains an explicit reviewed change. Refresh when suite costs
change materially or allocation diagnostics show skew or new-file estimates.
See the [refresh implementation](../scripts/update-integration-test-timings.ts)
and [CI wiring](../.github/workflows/test.yml).

For Vitest 4.1.11, `list --filesOnly --shard` bypasses the sequencer and reports
the full inventory; it does not prove shard membership. Verify allocation through
actual runtime assignment manifests and their four-way union. A lightweight
operator probe may use public `createVitest`, discovered specifications and the
configured sequencer without collecting database suites; see Vitest's
[files-only listing path](https://github.com/vitest-dev/vitest/blob/v4.1.11/packages/vitest/src/node/cli/cli-api.ts)
and [advanced API](https://v4.vitest.dev/advanced/api/).

### Integration request interception

The integration project starts its single [MSW server](../src/test/early-msw-setup.ts)
before test modules load, so retained provider clients capture an intercepted
fetch function. Integration setup owns listening and closing; fixtures select
their handler baselines and unhandled-request policies without opening another
server. Resets must restore each fixture's baseline, and teardown must clear its
handlers and policy before the next file. MSW recommends [one global or individual
server pattern](https://mswjs.io/api/setup-server/), and documents the
[client-construction ordering requirement](https://github.com/mswjs/msw/issues/2180).
Vitest documents [setup-file execution with cached modules](https://vitest.dev/config/setupfiles).
The guarded lifecycle regression checks early capture, exactly-once request
effects, strictness, baseline restoration and independent cleanup across real
runner files without external traffic.

### Hosted ClickHouse Failure Diagnostics

Integration progress diagnostics supplement the default reporter with immediate
module, suite, case and hook events through Vitest's [public reporter API](https://v4.vitest.dev/api/advanced/reporters).
Start events are emitted before completion, so an unmatched start identifies the
last active operation in a partial log. Events identify code by repository file,
task ID and source location; dynamic test titles and fixture values are excluded.
Failed module, suite and case events include bounded error metadata immediately,
so a hard stop need not erase the original failure before the final summary.
Fixture statement stages identify pending drop/create/seed awaits; bootstrap
events record the child's [spawn](https://nodejs.org/api/child_process.html#event-spawn)
and [close](https://nodejs.org/api/child_process.html#event-close) metadata without
printing commands, arguments or environment. Correlate a missing end event with
the failure events before deciding whether an operation stalled or rejected.

The integration setup also observes Node's [HTTP request diagnostic channels](https://nodejs.org/download/release/v26.7.0/docs/api/diagnostics_channel.html#built-in-channels).
Local request failures include a fixed method and operation bucket with the
canonical sanitized error fields; successful traffic contributes only numeric
summary counts. Dynamic routes, queries, headers, bodies and exception messages
are excluded. A Docker-shaped operation identifies a matching route, not a
proven server or Unix socket: classification uses documented request fields and
does not infer Unix versus TCP. Match a request error to the surrounding setup
events before assigning a transport cause. Reproductions should record the exact
Node version and operating system used by the failing job.

Seed-container diagnostics use Testcontainers' [documented lifecycle callbacks](https://node.testcontainers.org/features/containers/#lifecycle-callbacks).
These bracket runtime/image resolution, creation, start/inspection and readiness;
they do not identify an internal failing operation by themselves. Error events
retain allowlisted codes, syscalls, observed status/abort metadata and bounded
causal stack locations. They exclude raw error messages, request options, URLs,
headers, credentials, SQL, bodies and environment. Raw [debug namespaces](https://node.testcontainers.org/quickstart/logging/)
are outside this contract. Query-log observations retain only correlation IDs,
row presence and field presence; missing evidence does not prove a query failed.

On an integration-test failure, CI runs the
[ClickHouse diagnostics collector](../scripts/collect-clickhouse-ci-diagnostics.ts)
before GitHub removes the job's [service containers](https://docs.github.com/en/actions/tutorials/use-containerized-services/use-docker-service-containers).
The `clickhouse-diagnostics-<shard>` artifact uploads even if the collector fails;
the original test failure remains a failure. Inspect `manifest.json` first for
capture failures and collection bounds, then correlate query IDs and timestamps
across the snapshots and actual server log tails. ClickHouse's
[query log](https://clickhouse.com/docs/reference/system-tables/query_log) records
query starts, finishes and exceptions; [dropped tables](https://clickhouse.com/docs/reference/system-tables/dropped_tables)
identifies Atomic tables awaiting physical removal. A synchronous drop can wait
for table users, as described by the [Atomic engine](https://clickhouse.com/docs/reference/engines/database-engines/atomic#dropdetach-table);
a client timeout alone does not establish that cause.

The collector uses Docker's [formatted inspection](https://docs.docker.com/reference/cli/docker/container/inspect/)
to select identity, image, state, health status and resource limits without Env,
health commands or health output. It collects resource stats, the last 4,000
lines of Docker/server/error logs, and bounded read-only process, query-log,
drop, merge, mutation, active-DROP raw-stack and settings snapshots. The stack
query selects at most 100 active DROP thread IDs before sampling, retaining raw
addresses without enabling symbolization settings; see the
[pinned stack-table implementation](https://github.com/ClickHouse/ClickHouse/blob/v26.6.1.1193-stable/src/Storages/System/StorageSystemStackTrace.cpp).
An empty snapshot can mean the query finished before capture. Each subprocess is capped at 15
seconds and 8 MiB per output stream; native queries additionally have execution,
memory, row and connection bounds. The query-log window covers 20 minutes, with
separate drop/error records so a busy shard's recent queries do not crowd out
the drop evidence. Capture errors remain explicit and do not suppress the
test failure. These are diagnostic bounds; test and cleanup timeouts are unchanged.

Before artifact writes, known credential values from the existing URL,
credential URLs, authorization values, labeled secrets and recognized SQL log
payloads are redacted at their structural boundaries, including leading dbt
comments and `EXPLAIN`. Query-text columns are omitted, while structured query
IDs, timestamps, error codes and stack fields remain available. Redaction can
remove context and cannot guarantee detection of unknown sensitive free text;
the manifest records this limitation. Use these artifacts for CI diagnosis,
and do not add raw environment/config dumps or unredacted SQL to extend them.
Known prerequisite failures identify usage, container ID or `CLICKHOUSE_URL`
without echoing supplied values; unexpected errors keep a generic message and
safe telemetry.

### Isolated browser end-to-end stack

Use the repository Compose wrapper with the `e2e` project suffix for every
browser E2E command. The wrapper resolves that to `<workspace>-e2e`, which is
stable within the workspace and distinct from the normal `<workspace>` project:

```bash
pnpm compose -- --project-suffix e2e -f docker-compose.e2e.yml up -d --build --wait --wait-timeout 180
pnpm compose -- --project-suffix e2e -f docker-compose.e2e.yml ps -a
if ! pnpm e2e:web:run; then
  pnpm compose -- --project-suffix e2e -f docker-compose.e2e.yml ps -a
  pnpm compose -- --project-suffix e2e -f docker-compose.e2e.yml logs --no-color
  pnpm compose -- --project-suffix e2e -f docker-compose.e2e.yml down -v
  exit 1
fi
pnpm compose -- --project-suffix e2e -f docker-compose.e2e.yml down -v
```

The isolated topology includes Redpanda and explicit metric-stream producer
configuration. Server startup connects the producer before opening the HTTP
listener, and Compose waits for both broker health and `/readyz`; Docker
documents health-gated dependency startup in its
[startup-order guide](https://docs.docker.com/compose/how-tos/startup-order/).

Use the `e2e` suffix for startup, reuse, service inspection, logs, and teardown.
Docker documents project-name isolation and precedence here:
<https://docs.docker.com/compose/how-tos/project-name/>.

The failure branch preserves container state and complete service logs before
teardown. Both paths remove only this isolated project's containers and fresh
volumes.

The default Compose service uses a bounded ClickHouse review profile: a 1536
MiB container ceiling and a 1280 MiB `max_server_memory_usage` setting. The
isolated E2E service uses its own bounded profile: a 2048 MiB container ceiling
and a 1792 MiB `max_server_memory_usage` setting. The E2E profile is larger
because the CI browser stack runs the complete seeded analytics build, not just
the small review fixture; both profiles retain an explicit server cap and a
256 MiB outer headroom gap. Docker documents `mem_limit` as the Compose service
memory ceiling ([service reference](https://docs.docker.com/reference/compose-file/services/#mem_limit));
ClickHouse documents `max_server_memory_usage` in its
[server settings reference](https://clickhouse.com/docs/operations/server-configuration-parameters/settings#max_server_memory_usage).

If a review analytics build reaches the tracked limit, treat the ClickHouse
memory error as a fixture/profile sizing failure and collect the rendered
Compose config plus container inspection before changing the profile. Do not
add retries or waits to the review workflow.

This topology currently validates browser paths. It is not a complete mobile
write-path environment; that confirmed gap is tracked in
[#1806](https://github.com/Asherlc/dofek/issues/1806).

### Native FIT Decoder

Wahoo, Coros, and Suunto integration tests invoke the native FIT decoder at
`.build/fit-decoder/bin/dofek-fit-decoder`. If they report `Unable to start the
native FIT decoder`, first verify that the file exists and matches the host
architecture:

```bash
file .build/fit-decoder/bin/dofek-fit-decoder
```

The `fit-decoder-linux` CI artifact is an ELF executable and cannot run on
macOS. On macOS, build a native decoder with the repository's pinned vcpkg
toolchain:

```bash
VCPKG_ROOT=/path/to/full/vcpkg/checkout pnpm build:fit-decoder
```

Use the vcpkg commit and bootstrap sequence from
[`test.yml`](../.github/workflows/test.yml); the project uses vcpkg manifest
mode as documented by Microsoft:
<https://learn.microsoft.com/vcpkg/concepts/manifest-mode>.

### Docker Address-Pool Exhaustion

If `pnpm compose:up` fails with `all predefined address pools have been fully
subnetted`, inspect networks before changing daemon configuration:

```bash
docker network ls
docker network inspect NETWORK_NAME --format '{{json .Labels}} {{len .Containers}}'
```

Resolve the owning workspace from the Compose labels. Obtain explicit approval
before removing another workspace's network, then recheck that it has zero
attached containers immediately before `docker network rm NETWORK_NAME`.
Never disconnect live containers to make a network removable. Docker documents
[network inspection](https://docs.docker.com/reference/cli/docker/network/inspect/)
and requires connected containers to be disconnected before
[network removal](https://docs.docker.com/reference/cli/docker/network/rm/).
After freeing an approved unused network, rerun `pnpm compose:up` from the
current workspace; do not replace its generated service ports while running.

If all existing networks are occupied and the current workspace's default
network is absent, create only that network with an explicitly chosen subnet.
From the repository root, obtain the project and default-network names through
the [workspace Compose wrapper](../scripts/compose-command.ts), which uses the
physical workspace directory rather than inherited shell configuration:

```bash
pnpm --silent compose -- config --format json | jq '{project: .name, defaultNetwork: .networks.default.name}'
docker network ls --quiet | xargs docker network inspect --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}'
```

Check host and VPN destination ranges as well: use `netstat -rn -f inet` on
macOS or `ip -4 route show table all` on Linux, with the relevant VPN connected.
Choose a private CIDR that overlaps none of the Docker subnets or host/VPN
destination ranges, excluding default routes. Do not copy a subnet from a
previous incident; it may now be allocated. Docker requires non-overlapping
subnets and supports explicit allocation through
[`network create --subnet`](https://docs.docker.com/reference/cli/docker/network/create/).

Confirm the reported default network is still absent with
`docker network inspect CURRENT_WORKSPACE_DEFAULT_NETWORK`, then replace all
three placeholders below with the checked subnet and the wrapper's reported
names:

```bash
docker network create --driver bridge --subnet CHECKED_UNUSED_PRIVATE_CIDR \
  --label com.docker.compose.project=CURRENT_WORKSPACE_PROJECT \
  --label com.docker.compose.network=default \
  CURRENT_WORKSPACE_DEFAULT_NETWORK
```

The labels match [Compose's network metadata](https://docs.docker.com/reference/compose-file/networks/#labels).
Inspect the created network's labels and subnet, then rerun the original
command unchanged through the workspace wrapper. Preserve every occupied
network and other workspace's containers and volumes. This operator action
does not expand the daemon's default address pools; future workspaces need
their own checked-unused subnet or a separately approved pool change.

### Shared Docker VM Resource Pressure

When independent services restart or database setup times out, collect capacity
and usage evidence before increasing timeouts:

```bash
docker info --format 'CPUs={{.NCPU}} Memory={{.MemTotal}} Running={{.ContainersRunning}}'
docker ps --format '{{.ID}} {{.Names}} {{.Label "com.docker.compose.project"}}'
docker stats --no-stream
```

Inspect CPU, memory, and process/thread counts together. Docker's
[`stats` documentation](https://docs.docker.com/reference/cli/docker/container/stats/)
explains that `PIDS` includes kernel threads, not just processes. Start with
current-workspace cleanup. If resource relief requires another workspace to
stop, obtain explicit approval from that workspace's owner and record the
approved container IDs before using `docker stop CONTAINER_ID` with those
inspected identifiers. Without that approval, preserve its running services.
Preserve containers and volumes rather than deleting state; the
[`stop` command](https://docs.docker.com/reference/cli/docker/container/stop/)
signals the running process and may forcibly terminate it after its grace
period. Warn active users before interrupting their services.

Measure capacity again, verify current-workspace service health, and rerun the
exact failed command unchanged. Record what was stopped so those workspaces
can restart their services when needed. The September 7 recovery evidence is in
the [incident baseline](production-incident-baseline.md#2026-09-07--local-docker-capacity-blocked-modification-system-validation).

### Docker Disk Recovery

If a required validation command fails with `No space left on device`, inspect usage before
deleting anything:

```bash
docker system df -v
```

Remove disposable containers created by the current workspace while retaining
named database volumes, then prune the build cache, which Docker can recreate:

```bash
pnpm compose -- down --remove-orphans
docker builder prune -af
```

Compose retains named volumes when `down` runs without `--volumes`; see Docker's
[`down` documentation](https://docs.docker.com/reference/cli/docker/compose/down/).

If that does not reclaim enough space, prune images that are not used by any container:

```bash
docker image prune -af
```

Preserve running containers belonging to other workspaces and all named database volumes. Do not run
`docker volume prune` or `docker system prune --volumes` unless the user explicitly approves
deleting unused cross-workspace data. Docker documents which object types each prune command
removes in its [resource pruning guide](https://docs.docker.com/engine/manage-resources/pruning/).

Paseo teardown and Conductor archive share the
[workspace archive command](../scripts/workspace-archive.ts). It shuts down
the default `<workspace>`, isolated `<workspace>-e2e`, and
`<workspace>-peerdb-integration` projects from the archived workspace's physical
directory, including all profiles and PeerDB's declared volumes. See the
[workspace lifecycle and verification procedure](development-environment.md#workspace-setup-and-archive)
and Docker Compose's documented
[`down --volumes` behavior](https://docs.docker.com/reference/cli/docker/compose/down/).

Router integration tests that exercise activity sensor analytics use ClickHouse-backed
test stores. The test helper isolates ClickHouse databases per test database, creates
the current ClickHouse schema/read models directly, syncs the seeded Postgres fixtures,
and drops the isolated databases during test cleanup.

Do not make router integration setup call the tracked production ClickHouse migration
runner. Historical one-off migrations and backfills should not be replayed by broad
test suites; tests should validate application behavior against the current schema.

## Web E2E

Use the full reset command when Dockerfiles, migrations, analytics models, or seeded
state changed:

```bash
pnpm e2e:web
```

For repeated local runs after the E2E image and volumes already exist, reuse the
stack instead:

```bash
pnpm e2e:web:reuse
```

`pnpm e2e:web:reuse` starts the existing E2E compose services with `--no-build`,
waits for migrations and analytics setup, keeps volumes after Cypress exits, and
passes extra flags through to Cypress. Both commands use the isolated
`<workspace>-e2e` Compose project:

```bash
pnpm e2e:web:reuse -- --spec cypress/e2e/dashboard.cy.ts
```

CI runs Cypress specs in one job because the Docker build, service startup,
migrations, analytics setup, and server startup dominate the runtime. Manual
spec sharding on GitHub-hosted runners repeats that setup for each shard.
Cypress's built-in `--parallel` orchestration requires recorded Cypress Cloud
runs, so the workflow does not use Cloud orchestration either.

Source: Cypress parallelization requirements: https://docs.cypress.io/cloud/features/smart-orchestration/parallelization

## Chain-Mock Assertions (`values(...)`)

When testing DB write paths that use chainable mocks (`insert().values().onConflict...`), assert on the recorded payloads directly from `db.values.mock.calls`.

### Pattern: collect `values(...)` arguments

```ts
function getValuesCallArgs(db: ReturnType<typeof makeChainableMock>): unknown[] {
  return db.values.mock.calls.map((call: unknown[]) => call[0]);
}
```

### Pattern: assert a specific inserted record exists

```ts
const valuesCallArgs = getValuesCallArgs(db);
const exerciseInsert = valuesCallArgs.find(
  (arg) =>
    arg &&
    typeof arg === "object" &&
    !Array.isArray(arg) &&
    "name" in arg &&
    (arg as { name?: string }).name === "Bench Press",
);
expect(exerciseInsert).toBeDefined();
```

### Pattern: assert no empty batch insert happened (`values([])`)

Use this when code should skip `insert(...).values(setRows)` if `setRows.length === 0`.

```ts
const insertedEmptyBatch = db.values.mock.calls.some(
  (call: unknown[]) => Array.isArray(call[0]) && call[0].length === 0,
);
expect(insertedEmptyBatch).toBe(false);
```

### Pattern: assert an alias/write was not attempted

```ts
const valuesCallArgs = getValuesCallArgs(db);
const aliasInsert = valuesCallArgs.find(
  (arg) =>
    arg &&
    typeof arg === "object" &&
    !Array.isArray(arg) &&
    (arg as { providerExerciseId?: string }).providerExerciseId === "NOT_FOUND",
);
expect(aliasInsert).toBeUndefined();
```
