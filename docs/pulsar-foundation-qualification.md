# Pulsar foundation qualification

This checkpoint adds isolated infrastructure and native storage tests only.
Production remains unchanged. It does not include CDC replacement, analytics
activation, publisher cutover, archive conversion or production configuration.

The repeatable-payload correction was tested against actual Cloudflare R2 using
a separately scoped qualification bucket; the immutable
[corrected native offloader record](https://github.com/Asherlc/dofek/blob/ee7350f79/docs/pulsar-qualification.md#corrected-native-offloader-evidence)
records upload and remote reads, host source compilation, upstream tests and
packaging, and distinguishes those artifacts from a normal Docker source build.
The patch is maintained locally and is not a claim of stock R2 compatibility.

The standalone [source-build workflow](../.github/workflows/pulsar-source-build.yml)
is the registered cold ARM Docker source-build and GHCR publish path: verified
4 GiB memory and memory-plus-swap on the
[container builder](https://docs.docker.com/build/builders/drivers/docker-container/),
`--no-cache`, no imported host NAR. The
[Dockerfile](../deploy/pulsar/Dockerfile) runs the affected upstream test class,
both style checks and NAR packaging with retries disabled, then copies that NAR
into the broker image. PR path filters cold-build with `--load` only;
`workflow_dispatch` and main `workflow_call` push
`ghcr.io/<repo-lower>-pulsar-qualification:5.0.1-r2` plus a commit-specific
`sha-<GITHUB_SHA>` tag and write the OCI digest from buildx metadata (digest pin
is the immutable reference; the SHA-named tag is not). It does not run Pulsar
services or contact R2. Commit-specific success must be established by
its [workflow runs](https://github.com/Asherlc/dofek/actions/workflows/pulsar-source-build.yml).
The earlier [ARM source-build job](https://github.com/Asherlc/dofek/actions/runs/41993332932/job/127130525556)
passed at commit `7f98465d7330c554d5f71364cab29aff325e0f0c` (compile/package/style/tests
under the same 4 GiB limit; no publish). The
[tested Dockerfile](https://github.com/Asherlc/dofek/blob/7f98465d7330c554d5f71364cab29aff325e0f0c/deploy/pulsar/Dockerfile)
ends compiler/style process lifetimes before starting the test JVM; it changes
no heap, worker, retry or test-selection settings.

## November 6 published image pin and initial real-R2 functional lab

**Publish (remote GHA only).** [Run 42252694136](https://github.com/Asherlc/dofek/actions/runs/42252694136)
(`workflow_dispatch` on `pulsar-foundation`, commit
[`eab7e32dfa9509e1e1e893560a10dbe288a09f80`](https://github.com/Asherlc/dofek/commit/eab7e32dfa9509e1e1e893560a10dbe288a09f80))
completed SUCCESS in about 4m57s. Immutable pin:

`ghcr.io/asherlc/dofek-pulsar-qualification:5.0.1-r2@sha256:d99e2776fcdac9268a0f2f78d014d879e86a0a547ab7829f9e3d2d70fa59b822`

Independent `docker buildx imagetools inspect` confirmed OCI index digest
`d99e2776…` with linux/arm64 child
`sha256:6515ca137b78cb47bf62f3e9c756e3eb6a5c01f7ea830e47439860cd7a0e59db`
(plus attestation manifest). Image source:
[deploy/pulsar/Dockerfile](../deploy/pulsar/Dockerfile) +
[repeatable-offload-payload.patch](../deploy/pulsar/repeatable-offload-payload.patch).
No stack digest pin and no production deploy.

**Initial functional R2 lab** (`--project-suffix r2-offload-gap-1`, temporary
`/tmp` operator overlay only; no maintained Compose/CLI). Same published digest;
private bucket `dofek-pulsar-qualification`; region `auto`; existing Infisical
`R2_ENDPOINT` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` only (no new
`PULSAR_OFFLOAD_*`). Broker command redirected stock
`apply-config-from-env.py` stdout to `/dev/null` (stderr/exit kept). Separate
lab-only tool container on the owned network (not CLI JVM inside broker/bookie
cgroup). Broker 768 MiB / 1 CPU / `-Xmx256m`+192 MiB direct; bookie 768 MiB.
Stock Pulsar CLI:

1. `topics create-subscription -m earliest` before seed
2. `pulsar-client produce --client-api V5 -f … -n 1000` (8192 ASCII bytes, no LF)
3. `topics unload` then `topics offload -s 0` → **Offload was a success**
4. Broker restart; new Earliest subscription; `consume --client-api V5 -p Earliest -n 1000`
5. Unsubscribe both subs; `topics delete -f`; poll HEAD of captured keys until absent

**Sanitized outcomes.** Data-bearing sealed ledger **5**; offload UUID
`f5d9c5df-7203-46e6-9d4d-7b4add0c8fd0`; keys
`{uuid}-ledger-5` and `{uuid}-ledger-5-index` (log-attributed, then HEAD).
`stats-internal`: ledger 5 `offloaded=true`, 1000 entries, size 8239872. BookKeeper
HTTP `/api/v1/ledger/list` lacked id `5` before remote consume (ids 1–4,7 only).
Observed effective `jclouds.mpu.parts.size=5242880` from broker offload
`getOverrides`. Consume: 1000 `----- got message -----` boundaries and 1000
`content:` lines; LINE-CANONICAL SHA-256 of `(payload+LF)×1000`
(`8193000` bytes) matched
`87d5759ccd7e07b0267621aefd81b8606832c5ab0bbb12348d351d7d54d7b63c`. After topic
delete, first HEAD poll reported both keys absent (`NATIVE_GC_KEYS_ABSENT`;
deleteOffloaded path — not timed retention, not manual R2 delete). Cgroup
`memory.peak` / `oom`: broker 707104768 / 0; bookie 716894208 / 0; tool
302538752 / 0. Owned project `down --volumes --remove-orphans`; ephemeral
`/tmp/r2-offload-gap-1.*` cleared; preserved container `580f1c69f82f` untouched.

**Scope limits.** Functional upload, forced remote read after BK metadata
disappearance + broker restart, and stock topic-delete object GC only. Does
**not** qualify N=10k, storage-footprint `du`/hardBytes, outage/retry soak,
sustained heap, oversized-entry later-block behavior, Swarm addressing, or
production cutover. Stock CLI references (Apache Pulsar
[v5.0.1](https://github.com/apache/pulsar/tree/v5.0.1)):
[CmdProduce.java](https://github.com/apache/pulsar/blob/v5.0.1/pulsar-client-tools/src/main/java/org/apache/pulsar/client/cli/CmdProduce.java),
[ConsumeV5.java](https://github.com/apache/pulsar/blob/v5.0.1/pulsar-client-tools/src/main/java/org/apache/pulsar/client/cli/ConsumeV5.java)
(with [V5MessageSupport.java](https://github.com/apache/pulsar/blob/v5.0.1/pulsar-client-tools/src/main/java/org/apache/pulsar/client/cli/V5MessageSupport.java)
output grammar), and
[CmdTopics.java](https://github.com/apache/pulsar/blob/v5.0.1/pulsar-client-tools/src/main/java/org/apache/pulsar/admin/cli/CmdTopics.java)
(create-subscription / unload / offload / delete).

**Stock B2 alternative (separate lane; not a production pivot).** Parallel
validation on `dull-baboon` at
[`39143faa8`](https://github.com/Asherlc/dofek/blob/39143faa8/docs/pulsar-qualification.md#november-6-stock-offloader-passes-backblaze-b2)
records that stock Pulsar 5.0.1 with the **unmodified** `aws-s3` NAR passed a
small real Backblaze B2 fixture (201 synthetic payloads; native BK deletion;
broker-restart remote read). That result does **not** retract the Cloudflare R2
evidence above, does **not** claim the R2 source patch is required for every S3
compatible store, and does **not** authorize Infisical/prod credential changes
or a storage migration. Limits stated there remain: small fixture only — not
large MPU, Oxia topology, outage, erasure, or production cutover. Further
storage-provider scoping awaits the user.

The historical, pre-PR [native evacuation ARM job](https://github.com/Asherlc/dofek/actions/runs/41871869660/job/126721886208)
passed at commit 10735959f in 135.687 seconds, within its 300-second bound and
without retries. It verified surviving payloads, replacement ensembles,
old-storage-offline reads, restart and new writes, and marker scans. The CI
fixture is retained here with the dedicated native test project.
That historical run does not qualify a later commit. The extracted fixture
also passed the [PR ARM job at commit 3a320e12c](https://github.com/Asherlc/dofek/actions/runs/41974906401/job/127072892431).
Subsequent fixture changes must pass that required job again before merge.

The subsequent [local stable-endpoint lifecycle result](https://github.com/Asherlc/dofek/blob/ee7350f79/docs/pulsar-qualification.md#november-5-stable-endpoint-lifecycle-passes)
also passed mixed-ledger expiry/offload/removal, exact surviving-data reads
before and after broker/replacement restarts, and fixture cleanup. That model
used a stable Compose endpoint; it does not validate Swarm addressing.

These results qualify local mechanisms, not production fit.
Physical storage isolation, host memory/disk,
stable production addressing, metadata restore, large-account erasure, archive
preservation and sealed cutover remain release gates. Retain source data and
production holds until their own restoration decision.

The source patch preserves the [pinned native offload layout](https://github.com/apache/pulsar/blob/v5.0.1/tiered-storage/jcloud/src/main/java/org/apache/bookkeeper/mledger/offload/jcloud/impl/BlobStoreManagedLedgerOffloader.java).
Offloaded data is not a substitute for metadata recovery; see [Pulsar tiered storage](https://pulsar.apache.org/docs/5.0.x/tiered-storage-overview/).

## November 5 retained archive line-size measurement

This is the retained aggregate record of a bounded local scan performed on
November 5, 2026, from 13:04:00.613 to 13:04:00.872 UTC. It read three retained
manual-offload objects, checking each compressed digest, decompressed digest
and line count against its verified export receipt. No new production or R2
read was made. Payloads, credentials and account identifiers are excluded from
this record; source offset ranges identify the sampled portions.

| Source offset range, end exclusive | Lines | Largest payload, bytes | Decompressed bytes | Compressed and decompressed receipt digests matched |
| --- | ---: | ---: | ---: | --- |
| 21,161,777–21,261,777 | 100,000 | 655 | 52,195,417 | Yes |
| 55,561,777–55,609,019 | 47,242 | 902 | 21,336,359 | Yes |
| 55,609,019–55,709,019 | 100,000 | 454 | 42,583,647 | Yes |

Totals were 247,242 lines, 8,779,459 compressed bytes and 116,115,423
decompressed bytes, with a maximum line payload of 902 bytes. The scan's
limits were 64 MiB compressed, 256 MiB decompressed and 30 seconds. The
900,000-byte erasure limit is above this observed sample; this is not a
measurement of every offloaded record or the older legacy inventory.
Oversized records remain a fail-closed erasure condition with an
[operator recovery path](account-erasure-runbook.md#backup-and-restore-behavior).

## Historical analytics journal qualification

The journal, receipt and placement storage routing check belongs to the deferred
analytics implementation preserved at [checkpoint 4be97e4ff](https://github.com/Asherlc/dofek/commit/4be97e4ff).
Its tables, storage policy and test are excluded from the transport release. That check established
routing only; it did not establish a physical quota.

## Historical November 5 grouped sink database qualification

Before the transport release scope reduction, the [sink integration file at checkpoint 4be97e4ff](https://github.com/Asherlc/dofek/blob/4be97e4ff/src/metric-stream/clickhouse-sink.integration.test.ts)
passed all 19 cases against real Postgres and ClickHouse, with one worker,
no retries and a 128 MiB per-query allowance. Exact raw contents, receipts and
frontiers were checked for groups of one and 500, replay, deletion scopes and
native completion markers. The complete run observed 879 ClickHouse requests
and no HTTP errors; its isolated databases were removed afterward.

The grouped writer uses the official client's
[`exec(values)` streaming API](https://clickhouse.com/docs/integrations/javascript#exec-method),
with synchronous execution and `wait_end_of_query=1`. The query owner reads the
response to EOF before admitting its next query. The response's written-row count
is checked only as a lower bound: materialized views can add writes, so equality
would reject valid inserts. Exactness is checked against actual raw rows in the
integration tests. Unit tests cover interrupted responses and invalid summaries.
Independent source review found no critical or important issue in this checkpoint;
the interrupted-response boundary has not yet been exercised as one real-engine
crash fixture.

Four individual native deletion controls, three matching and one empty, followed
by a replacement preserved exact versions and produced a receipt for each control.
The controls alone took about 1.40 seconds and 134 ClickHouse requests, excluding
setup, assertion reads and the replacement. A 350-control burst and realistic
provider-deletion drain remain whole-host soak checks.

These database tests use synthetic native positions. They do not qualify
current-path throughput, production addressing, physical quotas or the historical
placement bootstrap. No production deployment or hold restoration occurred.

## Historical November 5 real broker to native sink composition

Before the transport release scope reduction, the [native composition test at checkpoint 4be97e4ff](https://github.com/Asherlc/dofek/blob/4be97e4ff/src/metric-stream/native-sink.pulsar.integration.test.ts)
passed both finite cases against the existing standalone Pulsar 5.0.1 broker,
the official Node client and the same real Postgres/ClickHouse fixture. It used
one worker, no retries, a 128 MiB per-query allowance, a receive queue of 20,
one-message native/application groups and 8 MiB byte bounds. The complete run
took 11.61 seconds; this includes fixture work and is not a throughput result.

The first case published a row and completion marker, verified exact raw
contents, a committed receipt and the Postgres frontier, then deliberately failed
immediately before forwarding the first native acknowledgement. After closing
and restarting the Consumer on the same subscription, it received the original
ID and bytes, preserved the physical raw-version count and acknowledged the row
and marker. Native marker evidence and the final frontier matched the actual
producer-returned positions. The second case verified an initial row, a native
delete control and its replacement in order, with exact versions and receipts.
These exercise the [Consumer](../src/metric-stream/pulsar-consumer.ts) and
[grouped sink](../src/metric-stream/clickhouse-sink.ts), not a simulated broker.

The initial run stopped on a test representation mismatch: `count()` returned
numeric `1`, while the assertion expected string `"1"`. Correcting that exact
expectation allowed both cases to pass without changing application behavior,
timeouts or resource settings. All owned clients and databases were closed and
only the unique fixture topics were deleted; the preexisting broker was preserved.

This qualifies finite delivery and acknowledgement-failure replay. It does not
qualify a process kill during a ClickHouse response, sustained throughput/RSS,
production Swarm addressing, R2 outage behavior or physical storage caps. Those
remain release gates in the living index.

## November 5 native archive and paged identifier checks

The [archive consumer](../src/metric-stream/r2-archive.ts) now has a production
CLI caller. Its focused tests cover original bytes, contiguous publish-hour
grouping, native provenance keys, create-only uploads, bounded collision reads,
upload-before-ACK ordering and resource cleanup. Two real S3 cases passed using
the existing bounded SeaweedFS fixture, including identical create-only
redelivery and the production eraser's rewrite of a native-key object followed
by refusal to overwrite those changed bytes. The final run used the paged
erasure API, observed 37 requests and no HTTP errors, and removed its owned
test container. See the [integration cases](../src/metric-stream/r2-archive.integration.test.ts).

The curated [identifier store](../src/account-erasure/identifier-store.ts) passed
47 real Postgres cases, including the canonical migration's empty-state success
and legacy-request refusal, lease checks, crypto ownership and paging across
500 identifiers. Its source curation has 423 focused unit cases passing. This
does not qualify the full ClickHouse erasure path or production account size;
  the 400,000/800,000-row evidence from the earlier development branch must be
repeated after release integration.

On 2026-11-05 the user approved raising only the combined
`physically erases 400000 and 800000…` Vitest case budget from 120s to 180s
(zero retries, unchanged 128 MiB `max_memory_usage` and assertions). Measured
Foundation phase totals under `--retry=0` were about 51s for 400k plus 69s for
800k (`/tmp/pulsar-foundation-erasure-resource-phase-diag-120s-retry0.log`);
product `executeinitial` dominated, so no product wait or assertion changes.
Earlier 120s first-failure evidence remains
`/tmp/pulsar-foundation-erasure-resource-120s-FAIL-retry2-894693.log`.
The approved 180s / `--retry=0` qualification then passed in 126.8s
(`/tmp/pulsar-foundation-erasure-resource-180s-retry0.log`): both sizes kept
identical family/snapshot shapes; EXIT:0. The budget claim is enforced
`max_memory_usage` 128 MiB on every client query/command/insert; logged seed
`query_log` peaks (2 080 278 bytes) are seed-fixture evidence only, not an
erasure-path memory measurement (`erasurePeakBytes` remains unset).

The native broker composition is now selected explicitly by a required
`Native Pulsar Sink` CI job; the existing BookKeeper job selects a different
fixture. The new job uses a separate standalone broker, Postgres and ClickHouse,
with service memory limits totaling 9 GiB and a 512 MiB Node heap. GitHub
currently specifies 16 GB for the public repository's
[ARM64 standard runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories).
Workflow/Compose validation passed; execution on that CI runner is pending.
These service limits do not qualify production physical quotas or RSS.

Release remains blocked on native erasure fencing/drain, safe writer handoff
when retained work fails, and replay after erasure removes personal journal
data, in addition to storage and deployment qualification. No production service
or held provider queue has been changed.


The historical runs above include the deferred receipt path. They do not qualify
the reduced raw transport sink. Its current source requires fresh database and native
broker qualification after review; no production deployment or hold restoration
is authorized by these results.
