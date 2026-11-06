# Sanitized evidence — `minio-mem2g-4` (2026-11-06)

Local-only stock Pulsar 5.0.1 dual-topic offload memory envelope lab.
Nonsecret artifacts only. No credentials, no payload bodies, no B2 traffic.

Narrative:
[pulsar-foundation-qualification.md](../../pulsar-foundation-qualification.md#november-6-local-stock-memory-envelope-lab-minio-mem2g-4).

## Scope (PASS bound)

| Item | Value |
|---|---|
| Verdict | **QUALIFIED** for this fixture only (integrity + no cgroup max/OOM) |
| Production fit | **NOT approved** |
| Broker cgroup | 2048 MiB |
| Broker JVM | `-Xms256m -Xmx768m -XX:MaxDirectMemorySize=768m` |
| Bookie cgroup | 2048 MiB (raised from 1536 MiB disposable-only; prior lab peak==limit) |
| Bookie JVM | `-Xms256m -Xmx512m -XX:MaxDirectMemorySize=512m` (**unchanged**) |
| Seaweed stand-in | 1024 MiB **local Compose only** (not a production hard-limit line) |
| Offload | stock `aws-s3`, 64 MiB blocks, `managedLedgerOffloadMaxThreads=2` |
| Workload | 128×1 MiB distinct messages × topics A/B; dual overlapping offload |
| Integrity | BK data ledgers absent + broker restart + full count/order/body SHA-256 |

**Not claimed:** sustained load, outage/soak, B2/R2 cloud offload, production
cutover, durable Compose/stack memory changes.

## Observed peaks (lifetime `memory.peak`)

| Role | Peak | Limit | Headroom |
|---|---:|---:|---:|
| broker | 1274347520 (~1215 MiB) | 2048 MiB | ~833 MiB |
| bookie | 1733775360 (~1653 MiB) | 2048 MiB | ~395 MiB |
| Seaweed | 736120832 (~702 MiB) | 1024 MiB | ~322 MiB |

`memory.events` max/oom/oom_kill stayed **0** (idle baseline → final oneshot).
Kernel file semantics:
[cgroup v2 memory interface files](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files).

## Memory capture gap (explicit)

- Dual offload trigger: **2026-11-06T21:06:07Z** (HTTP 204; SUCCESS by 21:06:12Z).
- Continuous 2 s cgroup TSV **first row: 21:08:16Z** (restart+hash window only).
- **Do not claim** continuous sampling through upload.
- Upload is covered by persistent cgroup `memory.peak` / `memory.events`:
  the first post-gap sample already shows bookie peak `1733775360` and
  `max=0`. Idle baseline (~21:01) bookie peak was ~755 MiB.
- Continuous sampling covers broker restart (**21:08:19Z**) through hash done
  (**21:11:28Z**). Raw 2 s TSV is omitted from durable evidence; peaks/events
  summaries are in `CORE_PROOF.json`, `memory-summary.json`, and oneshot files.

## Async BK delete

`managedLedgerOffloadDeletionLagMs=0` still deletes asynchronously.
This lab observed Offload succeed **21:06:12Z** → ledger delete
**21:07:48Z** (~96 s). Poll `listledgers` until data ledger ids are absent
before broker restart ([BookKeeper CLI](https://bookkeeper.apache.org/docs/reference/cli/)).

## Production budget (unresolved)

Retained census math with bookie hard limit 2048 MiB: Pulsar add **4352 MiB**,
retire Redpanda+3 sinks **2400 MiB**, net **+1952 MiB**; after limited-sum
**~30.58 GiB** vs host **24 GiB**. ClickHouse **13 GiB** and Postgres caps
**untouched**. Documented only — no deployment change in this packet.
See `CAPACITY_ANALYSIS_PULSAR_REPLACES_REDPANDA.md`.

## Files

- `CORE_PROOF.json` / `CORE_PROOF.sha256` — consolidated verdict + capture bound
- `lab.override.yml` — ephemeral limits (not for durable compose commit)
- `cgroup-baseline-events.json`, `cgroup-oneshot-*.txt`, `memory-summary.json`
- `offload-status-*.json`, `offload-msgid-*.json`, `offload-overlap.log`
- `bk-absent-*.json`, `hash-result-*.json`
- `broker-flags.txt`, `bookie-flags.txt`, `*-limit.txt`, wall/restart timestamps
- `CAPACITY_ANALYSIS_PULSAR_REPLACES_REDPANDA.md`
