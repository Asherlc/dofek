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
now defines the repeatable Docker source-build regression: ARM, a verified 4 GiB
memory and memory-plus-swap limit on the
[container builder](https://docs.docker.com/build/builders/drivers/docker-container/),
no imported host NAR and no cached build layers. The
[Dockerfile](../deploy/pulsar/Dockerfile) runs the affected upstream test class,
both style checks and NAR packaging with retries disabled, then copies that NAR
into the broker image. It runs independently of the existing Test Gate and does
not run services, publish images or use R2 credentials. Commit-specific success
must be established by its [workflow runs](https://github.com/Asherlc/dofek/actions/workflows/pulsar-source-build.yml);
the [ARM source-build job](https://github.com/Asherlc/dofek/actions/runs/41993332932/job/127130525556)
passed at commit `7f98465d7330c554d5f71364cab29aff325e0f0c`. That cold build
compiled and packaged the NAR, ran both style checks, then executed the selected
upstream tests in a separate RUN step under the same 4 GiB limit. The
[tested Dockerfile](https://github.com/Asherlc/dofek/blob/7f98465d7330c554d5f71364cab29aff325e0f0c/deploy/pulsar/Dockerfile)
ends compiler/style process lifetimes before starting the test JVM; it changes
no heap, worker, retry or test-selection settings.

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

## November 5 native journal storage routing

The local qualification used ClickHouse
[26.10.2.103 stable](https://github.com/ClickHouse/ClickHouse/releases/tag/v26.10.2.103-stable).
The upstream release API identified it as the latest stable release during this
check. The registry's multi-platform image index was
`sha256:d474afd5cd0abfb9fdc6e2ebbc82116324779b085f5c15a851aa91bec968291d`;
the local ARM64 manifest was
`sha256:88ccb7d52d9c2efe263ded5616417295dcdfbb4832b9e27ec7bb97a6f4ff3c2a`.
Compose, CI and the proposed production configuration use the image index so
each architecture selects its corresponding manifest.

The [journal configuration](../deploy/clickhouse/config.d/metric-stream-storage.xml)
defines a local disk and policy named `metric_stream_journal`, rooted at
`/var/lib/clickhouse/metric-stream-journal/`. For the local qualification, the
configuration was copied into the existing test container and loaded with stock
`SYSTEM RELOAD CONFIG`. Its existing data volume, 4 GiB container memory limit
and 3 GiB server memory limit were preserved. No production service was changed.
ClickHouse documents [storage policies](https://clickhouse.com/docs/operations/storing-data)
and [configuration reload](https://clickhouse.com/docs/sql-reference/statements/system#system-reload-config).

The [real-engine storage test](../src/db/metric-stream-journal-storage.integration.test.ts)
ran the registered current-schema migration in two isolated databases. It
verified all four journal/receipt/placement tables use the named policy, an
actual receipt part lands on that disk, and a raw insertion reaches the
placement materialized view on that disk. The raw part remained on its existing
default disk. Every test query used a 128 MiB allowance; the test databases were
dropped after the run.

The placement view covers future insertions. This test inserted a new row;
neither migration `0112` nor this test populates placements for existing raw
history. The bounded historical placement bootstrap remains an activation gate;
see the [view definition](../src/metric-stream/clickhouse-table.ts).

This qualifies storage routing, **not the physical quota**. Production activation
still requires the host directory's project quota, writer identity and capability
checks, measured allocations and reserve, the maintenance procedure, and the
whole-host test. Policy configuration alone does not establish those boundaries.
See the [living remaining-work index](https://github.com/Asherlc/dofek/blob/dull-baboon/docs/pulsar-remaining-work.md).

## November 5 native grouped sink database qualification

The [sink integration file](../src/metric-stream/clickhouse-sink.integration.test.ts)
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

## November 5 real broker to native sink composition

The [native composition test](../src/metric-stream/native-sink.pulsar.integration.test.ts)
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
