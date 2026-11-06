# Pulsar production capacity decision (2026-11-06)

Read-only host census and hard-limit arithmetic for applying the
**qualified local** `minio-mem2g-4` memory envelope on the production OCI host.
**No runtime, stack, or deploy change is authorized by this document.**

Lab envelope evidence (committed):
[`4b381ad5e938`](https://github.com/Asherlc/dofek/commit/4b381ad5e9384bd0f7889e553b1118d0172d1f64)
→ [`docs/evidence/minio-mem2g-4-20261106/`](evidence/minio-mem2g-4-20261106/).
Prior paper math:
[`CAPACITY_ANALYSIS_PULSAR_REPLACES_REDPANDA.md`](evidence/minio-mem2g-4-20261106/CAPACITY_ANALYSIS_PULSAR_REPLACES_REDPANDA.md).

## Decision status

| Item | Status |
|---|---|
| Local envelope `minio-mem2g-4` | QUALIFIED (fixture only) |
| Production hard-limit fit on current host | **FAIL** |
| ClickHouse **13 GiB** / Postgres caps | **Unchanged** (not reduced here) |
| Runtime / `deploy/stack.yml` apply | **Blocked** pending user choice below |

Observed lab peaks do **not** prove production fit. Hard limits are the
admission unit; Docker documents that unconstrained or oversubscribed memory
risks host OOM
([resource constraints](https://docs.docker.com/engine/containers/resource_constraints/)).
Kernel cgroup lifetime peaks/events:
([cgroup v2 memory interface files](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files)).

## Fresh read-only census

Authorized route: SSH `dofek-server` (see
[deploy/README.md](../deploy/README.md#ssh-access) operator diagnostics).
Captured **2026-11-06T21:21:15Z** (inspect) and **21:22:24Z** (stats).
No secrets, no stack mutate, no package/install.

| Host fact | Value |
|---|---|
| Shape (OCI metadata) | `VM.Standard.A1.Flex` |
| CPUs online | 4 |
| `MemTotal` | 25 139 458 048 B (**23.413 GiB** / **23 974.9 MiB**) |
| `MemAvailable` (idle sample) | ~15.2 GiB — **not** a peak bound |
| Swap | **0** |
| Swarm memory reservations | **none** on every inspected service |

Always Free / Flex references:
[Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
(current A1 free allotment described as 1 500 OCPU-hours and 9 000 GB-hours per
month; free-tenancy continuous equivalent **2 OCPU / 12 GB**),
[flexible shapes](https://docs.oracle.com/en-us/iaas/Content/Compute/References/computeshapes.htm),
Terraform defaults 4 OCPU / 24 GB in
[`deploy/oracle-free/variables.tf`](../deploy/oracle-free/variables.tf).
Paid Ampere A1 is billed as separate **OCPU-hour** and **GB-hour** SKUs on the
[Oracle Cloud price list (Ampere)](https://www.oracle.com/cloud/price-list/#compute-ampere)
— read live USD rates before any resize; this doc does not freeze a price.

### Current topology — desired capped services (replicas > 0)

Limit × desired replicas. Oracle override zeros
(`cloudbeaver`, `netdata`, `pgadmin`, `portainer`, `peerdb-ui`) are **excluded**
([`deploy/stack.oracle.yml`](../deploy/stack.oracle.yml)).
History ClickHouse sink desired **0** (held) — **excluded** from current sum
(not double-counted).

| Group | MiB |
|---|---:|
| ClickHouse | 13 312 |
| Postgres (`db`) | 2 048 |
| PeerDB suite (catalog, temporal, flow workers, minio, …) | 4 304 |
| Web×2 + worker + analytics + cdc-health + databasus + reconciliation | 2 712 |
| Three R2 archives @ 1024 MiB | 3 072 |
| Redpanda | 1 500 |
| Two active ClickHouse sinks @ 300 MiB | 600 |
| **Current desired capped total** | **27 348** |

**Current hard-limit sum already exceeds `MemTotal` by ≈ 3 373 MiB** before
uncapped services and OS reserve.

### Unlimited / uncapped Swarm services (not zero)

| Service | Limit | RSS sample (21:22Z) |
|---|---|---:|
| `redis` | unlimited | ~387 MiB |
| `collector` | unlimited | ~115 MiB |
| `traefik` | unlimited | ~45 MiB |
| `ota` | unlimited | ~30 MiB |

RSS samples are **instantaneous**, not guarantees. They are **additive** to
capped hard limits for host pressure; they must not be subtracted from the
capped sum (no double-count of the same service).

Non-stack containers also present at census (`dofek-full-activity-resync-…`,
`dofek-clinical-restore-verify`, `quirky_spence`) — operator leftovers; not
part of the steady Swarm budget but currently consume RSS.

### Final topology — Redpanda + ClickHouse sinks retired, Pulsar envelope added

Qualified **production hard-limit lines** (Seaweed/MinIO lab stand-in **omitted** —
object store is out-of-band B2/R2):

| Service | Hard limit MiB | JVM / runtime |
|---|---:|---|
| `pulsar-broker` | 2048 | `-Xms256m -Xmx768m -XX:MaxDirectMemorySize=768m` |
| `pulsar-bookie` | 2048 | `-Xms256m -Xmx512m -XX:MaxDirectMemorySize=512m` |
| `pulsar-oxia` | 128 | `GOMEMLIMIT=96MiB` |
| `pulsar-oxia-coordinator` | 128 | `GOMEMLIMIT=96MiB` |
| **Pulsar add** | **4352** | |

Retire from **current** desired sum: Redpanda 1500 + two active sinks 600 =
**2100 MiB**. Design retire of the held history sink (300) does not change the
current sum (already 0) and is already reflected in final=no sink.

```text
final_capped = 27348 − 2100 + 4352 = 29600 MiB ≈ 28.91 GiB
host_memtotal = 23974.9 MiB ≈ 23.413 GiB
overcommit    ≈ 5625 MiB ≈ 5.49 GiB
net vs current = +2252 MiB
```

Using the earlier design identity “retire Redpanda+3 sinks (2400) vs add 4352
→ net +1952 on a full named table that still counted zeroed Oracle UIs” yields
the prior **~30.58 GiB** paper figure. That figure **double-counts** Oracle-zeroed
admin UIs relative to live desired topology. This decision uses **live desired
replicas** and therefore **27 348 → 29 600 MiB**. Both agree the host does not
fit; they differ only by which zeroed services are listed.

### Transition overlap

| Cutover mode | Capped MiB | vs MemTotal |
|---|---:|---:|
| **Stop Redpanda+sinks, then start Pulsar** | 29 600 | −5 625 (same as final) |
| **Start Pulsar while Redpanda+sinks still up** | 27 348 + 4 352 = **31 700** | −7 725 |

Dual-run is not free headroom. Cutover must be stop-then-start (or equivalent
non-overlap). Bootstrap one-shots (`pulsar-oxia-bootstrap`, `pulsar-bootstrap`)
are not steady-state line items if they exit after success; if left as always-on
replicas their limits would add further.

## What is not claimed

- Lab RSS/peaks do not authorize lowering production hard limits.
- Idle `MemAvailable` does not authorize admission.
- This lane does **not** reduce ClickHouse or Postgres.
- This lane does **not** resize the host, deploy, or edit shared dirty
  `deploy/stack.yml` / README.

## Smallest durable config hunk manifesto (apply only after capacity choice)

Do **not** apply until the user picks an option that makes hard-limit accounting
fit (or explicitly accepts a different risk posture). Paths owned by other lanes
remain their responsibility; this is the memory/JVM envelope contract only.

When capacity is approved for **this host after resize** (or another approved
fit path), the minimal durable memory hunks are:

1. **`deploy/stack.yml`** (Pulsar services — create or amend; CH/PG untouched):
   - `pulsar-broker` `deploy.resources.limits.memory: 2048M`
   - `pulsar-bookie` `deploy.resources.limits.memory: 2048M`
   - `pulsar-oxia` / `pulsar-oxia-coordinator` `128M` each
   - `PULSAR_MEM=-Xms256m -Xmx768m -XX:MaxDirectMemorySize=768m`
   - `BOOKIE_MEM=-Xms256m -Xmx512m -XX:MaxDirectMemorySize=512m`
   - Keep Oxia `GOMEMLIMIT=96MiB`
   - Do **not** ship the unqualified draft ceilings (working-tree drafts have
     used 768 MiB cgroup + smaller heaps — those are **not** the mem2g-4
     qualified envelope)
2. **Cutover sequence** (separate change set / replicas): scale
   `redpanda` and the three `metric-stream-*-clickhouse-sink` services to
   **0** (or remove) **before** Pulsar replicas consume the add budget; keep
   the three R2 archive services unless a separate archive cutover says
   otherwise
3. **Uncapped services**: add explicit memory limits for `redis`, `traefik`,
   `collector`, and `ota` in the same release train that admits Pulsar, or
   document an explicit OS+uncapped reserve ≥ observed sample (~0.6 GiB RSS)
   plus kernel headroom — unlimited services remain host risk per Docker
4. **`deploy/stack.oracle.yml`**: no Pulsar memory change required
5. **Local** `docker-compose.pulsar.yml`: optional parity later; not a
   production gate

ClickHouse `13G` and Postgres `2G` stay as-is in every option this lane
recommends.

## Stock choices if the current host cannot fit

| Option | Capacity implication | Cost / ops implication |
|---|---|---|
| **A. Defer Pulsar; keep Redpanda** | Capped sum stays **27 348 MiB** (still over MemTotal); Pulsar transport blocked | No new compute spend; foundation cutover blocked |
| **B. Force qualified envelope on current 24 GB host** | Final **29 600 MiB** capped; worse overcommit | **Rejected by this census** as hard-limit fit |
| **C. Resize this `VM.Standard.A1.Flex` memory upward** | Target ≥ hard-limit final + explicit OS reserve + uncapped budget. Example paper minimum: 29 600 + 2 048 OS + 1 024 uncapped ≈ **32 672 MiB (~32 GiB)**; **48 GiB** preferred if PeerDB + conversion overlap remain | Paid Ampere A1 **GB-hour** (and unchanged OCPU-hour if CPUs stay 4). Confirm live rates on the [price list](https://www.oracle.com/cloud/price-list/#compute-ampere). Terraform `instance_memory_gb` in `deploy/oracle-free/` |
| **D. Second compute instance for Pulsar only** | Moves 4 352 MiB Pulsar off the DB/CH host | Second A1 (or other) instance: OCPU-hour + GB-hour; private networking; operational split |
| **E. Reduce ClickHouse / Postgres caps** | Would free headroom | **Out of scope** for this lane unless the user explicitly re-opens it; not recommended here |
| **F. Bookie cgroup &lt; 2048 MiB** | Saves ≤512 MiB vs qualified bookie | **UNQUALIFIED** (`minio-mem2g-3` peak==limit / `max>0`) |
| **G. Retire PeerDB suite (−4 304 MiB)** | Final would be ≈25 296 MiB — **still over** MemTotal by ≈1.3 GiB with CH 13 GiB held | CDC retirement **not** qualified ([pulsar-cdc-assessment.md](pulsar-cdc-assessment.md)); not a silent pivot |

## Exact remaining user decision

Choose **one** before any production Pulsar memory hunk or cutover:

1. **Defer** Pulsar on this host (option A), or
2. **Resize / add capacity** so hard limits + OS reserve + uncapped budget fit
   (option C and/or D), or
3. Explicitly authorize a **different** risk posture (E/G or accepted
   overcommit) in writing — this lane will not invent that posture.

Until that choice, production caps remain unresolved and **no runtime hunk
changes** from this lane.

## Evidence index

| Artifact | Role |
|---|---|
| This document | Production capacity decision + hunk manifesto |
| Commit `4b381ad5e938` | Sanitized mem2g-4 lab evidence + qual section |
| `docs/evidence/minio-mem2g-4-20261106/CORE_PROOF.json` | Lab peaks/events |
| SSH census 2026-11-06T21:21Z / 21:22Z | Fresh MemTotal + Swarm limits/replicas + uncapped RSS samples |
| `deploy/stack.oracle.yml` | Which admin UIs are desired-zero (excluded from sums) |
