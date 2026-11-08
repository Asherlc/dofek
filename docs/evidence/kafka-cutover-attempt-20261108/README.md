# Kafka cutover blocked; pre-write recovery complete

Q16 (`Y`) authorized the reviewed maintenance operation. The Kafka transition
**did not complete**. Production was restored to Redpanda before any application
write to Kafka or application schema compatibility boundary.

At **2026-11-08T06:17:52Z**:

- Redpanda **1/1**; Kafka **0/0**, with both data directories retained.
- Web **2/2 healthy**, worker **1/1 healthy**; public `/` and `/healthz` returned 200.
- All six original sink/archive groups **Stable, zero lag**.
- Twelve original service task templates match their pre-pause snapshots exactly;
  all original replica targets were restored. The repaired history sink retains
  its previously approved image; other applications retain the old image.
- All three global topic assignments were verified restored to v1.
- Six new Kafka main/quarantine topics had latest offsets **0** before Kafka
  stopped. No replay, manual acknowledgement, offset reset or data deletion occurred.

Writer pause began **05:49:07Z**. Application health was restored before final
verification. This maintenance attempt caused application downtime.

## Blocking gate

`peerdb-cdc-contract prepare` failed with:

> ClickHouse account erasure catalog exceeds its 500-table/1 MiB metadata budget; contact support before retrying

Aggregate metadata showed **214 tables / 3,043 columns**. The current preflight
formula estimates **1,221,082 bytes**, above **1,048,576**. Separate encoding
diagnostics measured **98,023 bytes** for encoded column pairs and an **80,950-byte**
table-encoding bound; these are not a complete response measurement. The
[preflight implementation](../../../src/account-erasure/clickhouse-erasure-coverage.ts)
charges fixed overhead per column before loading the catalog. A correction needs
real-engine qualification while retaining complete ownership coverage and bounds.
No quota was increased and no erasure gate was bypassed.

The failure occurred before the PeerDB mirror preparation API. The Postgres
migration runner was never started, no migration-applied messages appeared in
the failed pre-CDC step, and two new ClickHouse marker migrations remained
unapplied. Application service updates had not begun. These observations and
zero Kafka application offsets established the pre-write recovery conditions.

## Startup corrections retained

- `f50908504`: root-owned host bind directories require explicit sudo without
  prompts for provisioning. Corrected provisioning passed both plugin checksums.
- `919bed696`: the broker's own advertised name must resolve during startup.
  Native `hostname: kafka` fixed self-discovery; the original controller voter
  and client addresses remain unchanged. Kafka became healthy and passed the
  unchanged external API gate. A loopback-only controller change was insufficient
  for the remote log metadata manager and was removed.

These corrections are in the existing workflow/stack, without timeout increases,
new retry layers or a deployment framework. Database, ClickHouse, PeerDB and
collector service specifications were unchanged.

## Evidence and follow-up

[Aggregate receipt](summary.json) and [service comparison](service-spec-comparison.json)
contain no credentials, user identifiers or event bodies. Private snapshots,
environment exports, logs and extracted local assets were removed. The empty
owned canary volume was removed after verifying no container references. The
execution heartbeat was deleted; it must not retry this cutover automatically.

Before another maintenance window, qualify the catalog-size preflight on a
realistic catalog and run the existing read-only coverage inspection from the
new image before pausing ingress. Then prepare a new digest-pinned release
proposal. Completed historical identity audits do not need repeating.
