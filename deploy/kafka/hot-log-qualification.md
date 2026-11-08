# Hot-log-only Kafka qualification

Status: **offline investigation; production activation remains blocked**.
Following the stock tiered-storage proof gap in [qualification.md](qualification.md),
the user's November 8 “continue” was treated as approval to qualify the proposed
hot-log-only alternative. It was not approval for deployment, application changes,
retirement of production data, or a cloud experiment. The checked-in broker
candidate still enables tiered storage; this record does not silently change it.

## Observed local storage lifecycle

An isolated stock Kafka 4.4.0 broker used pinned image
`apache/kafka:4.4.0@sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f`,
a 2 GiB container limit and a 256 MiB RAM filesystem for logs. Its generated broker
properties explicitly reported `remote.log.storage.system.enable=false`.
No RSM plugin, object-store credential or production service was involved.

Two batches of 100 synthetic records created segments starting at offsets 0 and
100. Stock Kafka `DeleteRecords` advanced the partition's low offset to 100:

| Observation | Low offset | Old segment 0 | Newer segment 100 |
|---|---:|---:|---:|
| Before logical expiry | 0 | 814,387 B | 814,387 B |
| Immediately after logical expiry | 100 | 814,387 B still present | 814,387 B |
| Physical cleanup observed at 16:51:57 UTC | 100 | Log and index files absent | 814,387 B |

The initial publication/expiry observation began at 16:48:20 UTC. Old bytes were
observed absent about 217 seconds later. This directly demonstrates that the
existing offset-only erasure check can return before local files are removed,
even with tiered storage disabled. It does not demonstrate a production failure.

The broker kept the stock five-minute
[`log.retention.check.interval.ms`](https://kafka.apache.org/44/configuration/broker-configs/)
and one-minute
[`file.delete.delay.ms`](https://kafka.apache.org/44/configuration/topic-configs/).
An initial 90-second harness observation was shorter than those settings and
failed its premature cleanup assertion. Follow-up observation continued through
the same broker's unchanged cleanup cycle; no production or test broker delay
was reduced to manufacture success. A topic fixture also initially used a 1 KiB
segment, below Kafka 4.4's documented 1 MiB minimum, and was corrected to that
minimum. BusyBox file inspection used supported `find`/`stat` commands.

Only synthetic local topic records were deleted. No archive or historical
account-data scan was performed. The owned qualification Compose project was
removed with the workspace wrapper and `down --remove-orphans --volumes`.

## What this establishes and what remains

Existing deployed-image protocol checks already ran with remote storage disabled;
those unchanged results remain in [qualification.md](qualification.md). This
additional fixture isolates logical expiry versus physical local deletion. It
is not a durability benchmark, a full-service boot, a disk-capacity qualification,
or a complete worker erasure implementation.

A hot-log-only release still requires:

- A narrow worker check of physical local storage, covering retained/deleting
  segment files and topic generations, rather than a sleep after offset expiry.
  Unknown/missing storage evidence must block completion. Verify file-handle
  closure and crash/restart behavior before treating path absence as sufficient.
- The previously approved retained-Redpanda completion hold and a separately
  approved retirement procedure. A stopped broker does not perform retention.
- Continued JSONL archive erasure and archive-key collision protection. The
  durable JSONL archive is not a transparent Kafka remote-segment fetch path;
  recovery outside broker retention needs the existing explicit archive replay.
- A local disk budget and operational margin. At the previously proposed one
  partition and 1 GiB per source/quarantine topic, six topics imply a 6 GiB
  configured retention target, before segment overshoot, delayed deletion,
  indexes and broker metadata. This arithmetic is not a hard disk ceiling or
  a measured retention window under production ingest.

The tradeoff is removal of the unresolved live remote-copy fencing problem in
exchange for more local disk use and bounded broker replay. No runtime verifier,
new tracking framework, receipt store, feature flag or relaxed erasure guarantee
has been added by this qualification.

## Workstation prerequisite

The first local broker launch failed before JVM startup with
`mkdir: cannot create directory '/opt/kafka/bin/../logs': No space left on device`.
Docker reported no rebuildable build cache. Stock unused-image cleanup reclaimed
2.239 GB under the standing cleanup authorization, including unused qualification
images; no running container or database volume was removed. The same broker
then started without retry/timeout configuration changes. This local prerequisite
failure is separate from the logical/physical expiry observation above.
