# Capacity analysis — Pulsar REPLACES Redpanda (updated 2026-11-06T21:12:34Z)
Source census: `/tmp/prod-host-memory-census.txt` (retained from prior read-only capture) + lab `/tmp/minio-mem2g-4` measured peaks.
Host: MemTotal≈23.41 GiB (24550252 kB). **ClickHouse hard limit 13 GiB untouched. Postgres caps untouched.**

## Verdict (budget risk — not production-fit approval)
Named hard-limit sum still overcommits the 24 GiB host. Bookie disposable candidate raised **1536→2048 MiB** (JVM heap512/direct512 unchanged). Net vs Redpanda retire worsens by **+512 MiB** vs prior ACK envelope.
**NOT production-fit approval.** Local observed headroom only.

## Services that RETIRE (unchanged; census)
| Service | Hard limit (MiB) |
|---|---:|
| `redpanda` | 1500 |
| `metric-stream-clickhouse-sink` | 300 |
| `metric-stream-live-clickhouse-sink` | 300 |
| `metric-stream-history-clickhouse-sink` | 300 |
| **RETIRE SUM** | **2400** |

## Archives STAY (unchanged)
| Service | Hard limit (MiB) |
|---|---:|
| three `metric-stream-*-r2-archive` | 1024 each |
| **ARCHIVES STAY SUM** | **3072** |

## Pulsar candidate ADDED (hard limits)
| Service | Hard limit (MiB) | JVM | mem2g-4 measured peak (MiB) |
|---|---:|---|---:|
| `pulsar-broker` | 2048 | Xms256/Xmx768/direct768 | 1215.3 |
| `pulsar-bookie` | 2048 | Xms256/Xmx512/direct512 (**cgroup-only bump**) | 1653.5 |
| `pulsar-oxia` | 128 | GOMEMLIMIT 96MiB | (lab sample; see monitor) |
| `pulsar-oxia-coordinator` | 128 | GOMEMLIMIT 96MiB | (lab sample; see monitor) |
| **PULSAR ADD SUM** | **4352** | | |

Seaweed/MinIO stand-in is **lab-only** (peak 702.0 MiB / 1024 MiB); production object store is B2/R2 out of band — not added to Swarm hard-limit sum here.

## Net steady-state hard-limit math
```
retire_sum     = 2400 MiB
pulsar_add_sum = 4352 MiB   (was 3840 with bookie 1536; now bookie 2048)
net_delta      = +1952 MiB
```
Current limited-sum (census): **29366 MiB ≈ 28.68 GiB**
After replacement: **31318 MiB ≈ 30.58 GiB**
Host: **24576 MiB = 24 GiB**
ClickHouse reserved untouched: **13312 MiB**
Overcommit after: **6742 MiB ≈ 6.58 GiB** (was ~6.08 GiB at bookie 1536)

## Measured lab headroom (minio-mem2g-4) — not RSS-as-limit
| Role | Limit MiB | Peak MiB | Headroom MiB | max_events Δ |
|---|---:|---:|---:|---:|
| broker | 2048 | 1215.3 | 832.7 | 0 |
| bookie | 2048 | 1653.5 | 394.5 | 0 |
| seaweed stand-in | 1024 | 702.0 | 322.0 | 0 |

Prior mem2g-3 bookie@1536: peak==limit with max=34 during broker restart → UNQUALIFIED. This lab bookie@2048: peak 1653.5 MiB, max_events Δ=0.

## Transitional overlap (maintenance window required)
```
overlap_peak_extra = pulsar_add (4352) while retire still live (2400)
                   = temporary +4352 MiB on top of current stack
```
Cutover still requires stop Redpanda+3 CH sinks before starting Pulsar. Dual-run is not free headroom on 24 GiB with CH 13 GiB reserved.

## What this analysis does NOT claim
- Does not approve production fit or durable stack.yml memory change.
- Does not reduce ClickHouse or Postgres caps.
- Does not treat measured peaks as replacement for hard limits.
- Lab Seaweed 1 GiB is not a production hard-limit line item.
