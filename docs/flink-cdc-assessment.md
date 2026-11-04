# Flink CDC compatibility and existing-server assessment

Assessed November 4, 2026 UTC. **Result: do not adopt the assessed released Flink
path under the current constraints.** Flink exposes the native Pulsar metadata
missing from SeaTunnel, but the released connector combination does not satisfy
the current-version and application-specific durability requirements. Existing
server capacity is also unqualified. This is a source/documentation assessment,
not a runtime benchmark, migration plan or production change.

The user authorized assessment of Flink in place of SeaTunnel, retaining Pulsar,
the existing server, no enterprise or managed-service requirement, and maintained,
widely used connectors. Original R2 conversion, exact job/checkpoint preservation,
erasure and the [bounded analytics contract](superpowers/specs/2026-11-03-bounded-analytics-design.md)
remain required. The confirmed SeaTunnel limitation is recorded in the
[CDC assessment](pulsar-cdc-assessment.md#native-cdc-effect-identity-confirmed-connector-blocker).

## Released version and support matrix

| Component | Released evidence | Assessment |
| --- | --- | --- |
| Flink engine | [Apache downloads](https://flink.apache.org/downloads/) identifies 2.3.0 as latest stable. | No released Pulsar connector support for this engine is listed. |
| Official Pulsar connector | Latest 4.2.0, Maven artifact `4.2.0-1.20`; Apache lists only Flink 1.20.x compatibility. [Matrix](https://flink.apache.org/downloads/#apache-flink-pulsar-connector-420), [artifact inventory](https://repo.maven.apache.org/maven2/org/apache/flink/flink-connector-pulsar/maven-metadata.xml). | 1.20.5 is a maintained LTS option, but not the latest engine requested. No older engine or unsupported combination was selected. |
| Bundled Pulsar Java client | Published connector [parent POM](https://repo.maven.apache.org/maven2/org/apache/flink/flink-connector-pulsar-parent/4.2.0-1.20/flink-connector-pulsar-parent-4.2.0-1.20.pom) fixes `pulsar.version=3.0.5`. The 3.0 line's security support ended May 2, 2026. [Support policy](https://pulsar.apache.org/contribute/release-policy/). | Current connector tag does not imply a supported bundled client. No dependency override or unreleased build was accepted as the released artifact. |
| Official ClickHouse connector | [0.2.0 release](https://github.com/ClickHouse/flink-connector-clickhouse/releases/tag/v0.2.0). The `flink-connector-clickhouse-1.17:0.2.0:all` artifact exists and its [CI](https://github.com/ClickHouse/flink-connector-clickhouse/blob/v0.2.0/.github/workflows/tests.yaml) includes Flink 1.20.2; a separate module builds against 2.0.0. | A released 1.20 family pairing exists despite the artifact's name. This does not establish 2.3 compatibility or qualify the exact complete stack. |
| Apache JDBC | [4.1.0 SQL connector](https://github.com/apache/flink-connector-jdbc/blob/v4.1.0/docs/content/docs/connectors/table/jdbc.md) has no ClickHouse dialect; its SQL path is non-XA. | A driver JAR alone does not create a released ClickHouse SQL dialect or declarative cross-destination transaction. |

Flink and the official connector repositories use Apache-2.0 licensing; the
assessed source and sink do not require a managed service or enterprise license
([Pulsar connector license](https://github.com/apache/flink-connector-pulsar/blob/v4.2.0/LICENSE),
[ClickHouse connector license](https://github.com/ClickHouse/flink-connector-clickhouse/blob/v0.2.0/LICENSE)).
Both repositories show maintenance, but broad production adoption of this exact
version combination and metadata/commit path was not established. Flink engine
[production users](https://flink.apache.org/what-is-flink/powered-by/) are not
evidence for every connector pairing. No security audit or vulnerability-free
claim is made.

## Native identity is available

Released `PulsarReadableMetadata` supplies `message_id BYTES` directly from
`message.getMessageId().toByteArray()` and `topic` from `getTopicName()`. The SQL
source advertises and attaches these fields, so no custom deserializer is needed
for this narrow capability. Native bytes preserve batch/partition identity;
there is no separate SQL partition metadata field. Keep full topic scope and
bytes, rather than substituting a timestamp, LSN, producer sequence or decoded
entry-only string. [Released metadata implementation](https://github.com/apache/flink-connector-pulsar/blob/v4.2.0/flink-connector-pulsar/src/main/java/org/apache/flink/connector/pulsar/table/source/PulsarReadableMetadata.java#L87-L110).

The released source also supports Debezium JSON changelog decoding. Before/after
rows from one message retain that message's identity and require distinct row-role
effects. This is static capability evidence; it does not prove this application's
replica identity, all 18 mappings, unchanged external values or exact nullable
microsecond behavior. [Released changelog integration tests](https://github.com/apache/flink-connector-pulsar/blob/v4.2.0/flink-connector-pulsar/src/test/java/org/apache/flink/connector/pulsar/table/PulsarChangelogTableITCase.java).

## Checkpoint durability is not target visibility

The official ClickHouse connector's 0.2.0 writer waits for requests already in
flight during `flush(false)`, but leaves unsent buffered records. Its snapshot
stores those records for restoration. Flink 1.20.5 calls `flush(false)` before
the checkpoint barrier. A checkpoint can therefore succeed while some covered
records are still absent from ClickHouse. This is recoverable buffering, not a
durable target receipt. Root independently verified the matching
[1.20.5 operator](https://github.com/apache/flink/blob/release-1.20.5/flink-streaming-java/src/main/java/org/apache/flink/streaming/runtime/operators/sink/SinkWriterOperator.java#L169-L176)
and released [1.17-family writer](https://github.com/ClickHouse/flink-connector-clickhouse/blob/v0.2.0/flink-connector-clickhouse-1.17/src/main/java/org/apache/flink/connector/clickhouse/sink/writer/ExtendedAsyncSinkWriter.java#L490-L515).

A receipt/marker branch can become visible before its raw branch, and a raw
branch can write before its structural-intent branch. This counterexample is
inferred from the released control flow, not an executed failure fixture.
Faster flush timers, smaller batches or parallelism one do not establish an
acknowledgment dependency between sibling sinks. The released sink is DataStream
only and does not ship a configurable committer/frontier output; newer Table API
work on main is not release evidence. [Released README](https://github.com/ClickHouse/flink-connector-clickhouse/blob/v0.2.0/README.md).

The JDBC comparison has different semantics: its
[snapshot path flushes output](https://github.com/apache/flink-connector-jdbc/blob/v4.1.0/flink-connector-jdbc-core/src/main/java/org/apache/flink/connector/jdbc/internal/GenericJdbcSinkFunction.java#L56-L62).
Its DataStream API can use PostgreSQL XA to delay a separately programmed
frontier transaction until checkpoint completion. That is a possible programming
building block, not an assessed configurable solution. It still needs correct
record-to-frontier association and structural-intent-before-raw ordering. The
released SQL sink constructs a non-XA implementation; ClickHouse's driver itself
does not provide those transactions
([SQL sink](https://github.com/apache/flink-connector-jdbc/blob/v4.1.0/flink-connector-jdbc-core/src/main/java/org/apache/flink/connector/jdbc/core/table/sink/JdbcDynamicTableSink.java#L68-L78),
[XA builder](https://github.com/apache/flink-connector-jdbc/blob/v4.1.0/flink-connector-jdbc-core/src/main/java/org/apache/flink/connector/jdbc/core/datastream/sink/JdbcSinkBuilder.java#L50-L92),
[ClickHouse connection implementation](https://github.com/ClickHouse/clickhouse-java/blob/v0.11.0/jdbc-v2/src/main/java/com/clickhouse/jdbc/ConnectionImpl.java#L250-L269)).

Flink programming APIs could support custom coordination. That is not proof that
Flink is incapable in principle; it means a native configurable replacement has
not met the approved no-custom-consumer gate. No custom job, connector, fork or
commit bridge was built to obtain a pass.

## Existing-server fit

The unchanged [recorded candidate allocation](pulsar-cdc-assessment.md#whole-server-result)
already fails. Removing the 768 MiB SeaTunnel consumer from that calculation
leaves:

```text
24,568 MiB candidate caps - 4,504 MiB retired PeerDB group
  + 512 MiB capture + 2,858 MiB observed Redis peak
= 23,434 MiB before Flink, uncapped processes, OS reserve and migration overlap
```

Root read production `MemTotal=24,550,252 KiB` at 02:31:15 UTC, approximately
23,974.86 MiB. That leaves only 540.86 MiB in this recorded allocation. Default
metaspace plus minimum-overhead reservations for one JobManager and one
TaskManager alone total 896 MiB, before heaps, network and managed state
([1.20.5 JobManager options](https://github.com/apache/flink/blob/release-1.20.5/flink-core/src/main/java/org/apache/flink/configuration/JobManagerOptions.java#L222-L245),
[TaskManager options](https://github.com/apache/flink/blob/release-1.20.5/flink-core/src/main/java/org/apache/flink/configuration/TaskManagerOptions.java#L629-L645)).

These are planning reservations, not measured simultaneous RSS or an absolute
minimum for every possible Flink configuration. They reject the unchanged
allocation; they do not prove the physical server can never fit a revised one.
A lower ClickHouse ceiling after bounded analytics and a full warm-host soak
remain unqualified. No unrelated cap was lowered, and no runtime was launched
on the strength of idle memory.

## Decision and remaining work

Do not adopt this candidate under the current constraints. Relaxing only the
latest-engine preference would not resolve the bundled-client support gap,
application-specific commit ordering or host qualification.

No executable Flink fixture was run because released support and native causal
gates failed before resource-intensive testing. The original source archives,
provider jobs and checkpoints remain intact. PeerDB remains in production;
analytics-refresh, sync-ride-with-gps and sync-strava remain paused, and the
history ClickHouse sink remains at zero. Full R2 conversion and incident closure
are not complete.

Retrospective: inspecting exact artifact dependencies and pre-barrier behavior
answered the key questions before another runtime prototype. Add a connector
preflight checklist covering emitted native identity, bundled-client support,
buffer-versus-target durability and complete host budget before dependent work.
Use source review followed by focused real-engine/native recovery fixtures for
any future candidate; no new framework was selected by this assessment.
