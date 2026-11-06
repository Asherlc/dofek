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
| Configured budget shortfall (Σ caps vs MemTotal) after Kafka+Pulsar | **≈5.5 GiB** (paper admission) |
| Proven “physical simultaneous need” for whole host | **Not fully reconstructed** (lifetime peaks ≠ same-instant sum) |
| CH 13 GiB rightsize from “~2 GiB RSS” | **Rejected** — lifetime cgroup peak ≈ limit; see peaks section |
| Archive 1024→300 without proof | **Unsafe** — history peak ≈471 MiB, live ≈325 MiB |
| Quitting Kafka/Redpanda | Already subtracted in final budget (**do not double-count**) |
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

## Reclaim-before-resize (2026-11-06T21:27–21:28Z read-only)

User asked to free RAM on the current host instead of resizing, and is willing
to quit Kafka/Redpanda. This section is **inspect-only** — no service stop,
cap change, volume prune, Pulsar enable, or deploy.

### Do not double-count Kafka retirement

| Step | Capped MiB | Notes |
|---|---:|---|
| Current desired>0 | 27 348 | Includes Redpanda 1500 + 2 active CH sinks 600 |
| After Kafka path retire (STOP RP + 2 sinks) | **25 248** | −**2100** only; history CH sink already 0 |
| After + qualified Pulsar add | **29 600** | +4352 (broker/bookie/oxia/oxia-coord) |
| Host `MemTotal` | 23 974.9 | |

**Quitting Kafka frees the 2100 MiB already in the final formula.** Counting it
again as “reclaim toward the 8 GiB gap” is double-counting.

After Kafka retire **before** Pulsar, the host is still over hard-limit sum by
≈**1 273 MiB**. After Pulsar add, over by ≈**5 625 MiB**. Dual-run is avoided
by STOP-BEFORE-START (below); the ≥8 GiB ask was for overlap+OS — with
stop-before-start, overlap drops out, but **OS + uncapped + 5.5 GiB deficit
remain**.

### Immediate RSS vs guaranteed capacity

| Class | What it frees | Use for Pulsar admission? |
|---|---|---|
| **Hard-limit reclaim** (scale service to 0 / lower durable limit) | Guaranteed Swarm ceiling | **Yes** — this is the budget unit |
| **RSS sample drop** (process idle / leftover container) | Observed pages now | **No** as sole proof — another spike can return |
| Oracle-zeroed UIs (already `replicas: 0`) | **0** | Already excluded |
| Cap an unlimited service | Converts risk; **does not reduce** capped sum | Needed for safety, not for closing the MiB gap |

### Kafka / Redpanda dependency (live)

Producers (env present; values redacted in census):

- `dofek_web` — `REDPANDA_BROKERS`, live + history topic keys
- `dofek_worker` — `REDPANDA_BROKERS`, legacy + live + history + R2 bucket

Consumers (Swarm + consumer groups, lag at 21:28Z):

| Group | State | TOTAL-LAG |
|---|---|---:|
| `metric-stream-clickhouse-sink` | Stable | **0** |
| `metric-stream-live-clickhouse-sink` | Stable | **0** |
| `metric-stream-r2-archive` | Stable | **0** |
| `metric-stream-live-r2-archive` | Stable | **0** |
| `metric-stream-history-r2-archive` | Stable | **0** |
| `metric-stream-history-clickhouse-sink` | Empty (replicas 0) | **18 836 612** |

History **R2 archive is caught up**; history **ClickHouse sink is not** (held at
0 with unread local tail). R2 remains the durable archive for that tail; CH
history coverage is incomplete until a separate restore/replay decision
([pulsar-remaining-work](pulsar-remaining-work.md) retained-history notes).
Local Redpanda data dir ≈ **38 GiB** on `/mnt/dofek-data` — retain on disk for
rollback; stopping the process frees RAM, not that disk, until an explicit
data-retirement gate.

Existing hold / pause machinery (stock; do not invent a bridge):

- Deploy Web workflow: `disabled_manually` (verified via GitHub API 2026-11-06)
- History CH sink desired **0** (conflicts with full-stack deploy replica check
  until hold restoration — see remaining-work)
- Deploy overlays: [`stack.cdc-quiesce.yml`](../deploy/stack.cdc-quiesce.yml)
  (zeros analytics + all three CH sinks + reconciliation),
  [`stack.maintenance.yml`](../deploy/stack.maintenance.yml) (web during
  schema migrate)
- Runbook drain checks:
  [`metric-stream-redpanda-r2-runbook.md`](metric-stream-redpanda-r2-runbook.md)

### STOP-BEFORE-START sequence (concrete; not executed)

Stock Swarm replica / stack deploy only — **no** custom migration state machine.
Pulsar must not be consuming the 4352 MiB add until Redpanda+sinks are stopped.

1. **Keep** Deploy Web disabled; do not enable Pulsar producers yet.
2. **Pause metric-stream producers** on `web`/`worker` (fail-closed / hold —
   separate explicit change; today they still have `REDPANDA_BROKERS`).
   Ingestion impact: no new live/legacy/history Kafka events until Pulsar
   producers are wired and enabled.
3. **Prove drain**: live+legacy CH sinks and all three archive groups at lag 0
   (already true at census). Record offsets. History CH lag 18.8 M is **not**
   cleared by this cutover — treat as known unread CH gap with R2 durable;
   do not claim CH catch-up.
4. **Scale to 0** (or remove): `metric-stream-clickhouse-sink`,
   `metric-stream-live-clickhouse-sink`, and confirm history sink stays 0
   (−600 MiB from current; history already 0).
5. **Keep** the three R2 archive services until Pulsar-native archive consumers
   are qualified and cut over (archives are **not** in the 2100 retire sum;
   retiring Connect early risks archive durability).
6. **Scale `redpanda` to 0** (−1500 MiB). **Retain** `/mnt/dofek-data/redpanda`
   until rollback window ends.
7. **Then** start Oxia → bookie → broker at the **qualified** 2048/2048/128/128
   envelope (+4352 MiB).
8. Point producers/consumers at Pulsar in the reviewed release unit; re-enable
   Deploy Web only with hold-restoration decision.

**Rollback:** scale Redpanda + Kafka sinks back up against retained data dir;
restore `REDPANDA_BROKERS` producers; leave Pulsar at 0; Deploy Web stays
disabled until explicit restore. No data deletion in this sequence.

**Ingestion pause window:** from step 2 until Pulsar producers are healthy —
live Apple/sensor paths that publish metric-stream stall; PeerDB/CDC and
non-metric-stream app traffic are out of this Kafka path but still share host
RAM.

### Ranked reclaim plan (other than Kafka — Kafka already counted)

| Rank | Action | Purpose today | Reclaim MiB (guaranteed hard-limit) | Immediate RSS (sample) | Risk / validation / rollback |
|---|---|---|---:|---:|---|
| 1 | Stop non-stack `dofek-full-activity-resync-20261103-independent` | Operator resync leftover (3 d) | **256** (its MemLimit) | ~75 | Confirm job complete/abandoned; `docker stop` only — no volume prune. Rollback: recreate container if still needed |
| 2 | Stop non-stack `dofek-clinical-restore-verify` + `quirky_spence` | Leftover verify / idle databasus | **0** guaranteed (unlimited) | ~29 + ~87 | RSS-only; stop after purpose check. Rollback: recreate |
| 3 | Set `peerdb-minio-lifecycle` desired **0** if confirmed unused | Lifecycle helper; desired 1 but **0/1** | **128** | ~0 | Confirm no required lifecycle job; stack/oracle change. Rollback: replicas 1 |
| 4 | Rightsize three R2 archives **1024→768** (then maybe 640) **after** bounded qual | Durable archive (Connect) | **768** (or 1152 at 640) | peaks ≈93/325/471 | **300 disproven**. Qual proposal in peaks section. Rollback: restore 1024 |
| 5 | Cap unlimited `redis`/`traefik`/`collector`/`ota` | Ingress/cache/telemetry | **0** to capped sum | ~577 combined | Prevents steal under Pulsar; does not close deficit |
| 6 | `web` 2→1 replica | HA edge | **500** | ~270×2 | Loses redundant web. Rollback: replicas 2 |
| 7 | Trim PeerDB flow-worker / suite | CDC | up to **4304** suite | flow-worker ~134 / 2048 | **Not qualified**; sacrifices current CDC requirement ([cdc assessment](pulsar-cdc-assessment.md)) |
| 8 | Reduce CH 13 GiB / PG 2 GiB | Serving / OLTP | large | CH ~2.1 GiB / 13 GiB | **Forbidden** unless user re-opens; not recommended here |

**Optimistic sum without sacrificing CDC/CH/PG:** ranks 1–4 ≈ **2 556 MiB**
guaranteed if archive rightsize is approved with peaks — **still ≪ 8 GiB** and
**still short of the 5 625 MiB final deficit** (29 600 − 2 556 = 27 044 >
23 975).

**Even PeerDB suite + archive rightsize + leftovers** ≈ **6 860 MiB** — under
8 GiB, and PeerDB retirement is not a current-requirement-preserving option.

### Configured budget vs physical simultaneous need

| Metric | Meaning | This host |
|---|---|---|
| **Configured budget** | Σ (limit × desired replicas) for admission | Current 27 348 MiB; final Kafka+Pulsar **29 600 MiB** vs MemTotal **23 975 MiB** → **configured shortfall ≈5 625 MiB** |
| **Instant RSS / `docker stats`** | One sample | Misleading alone (CH earlier sample ~2 GiB; cgroup **current** later ≈9.6 GiB) |
| **Lifetime `memory.peak`** | High-water since cgroup create | Strong per-service evidence; **not** proof peaks were simultaneous |
| **Sum of lifetime peaks** | Upper bound if worst cases coincided | Useful stress ceiling; overstates typical concurrent use |

Kafka retirement still **must not be double-counted**. Prefer reclaim before
resize, but reclaim claims need peak proof — missing coverage ≠ proven fit.

### Stock peak evidence (read-only 2026-11-06T21:32Z)

Kernel cgroup v2
([memory interface files](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files)).
Axiom MCP **not authenticated** this session; Netdata desired **0** — no host
time-series from those paths. Retained evidence used: live cgroup
`memory.peak`/`memory.events`, ClickHouse `system.query_log` /
`system.part_log` / server settings, Redis `INFO memory`.

| Service | Limit MiB | `memory.current` MiB | `memory.peak` MiB | `memory.events max` | Note |
|---|---:|---:|---:|---:|---|
| `clickhouse` | 13 312 | ≈9 585 | **≈13 312** (≈limit) | **29 370** | Envelope **binding**; not idle-sized |
| `db` (Postgres) | 2 048 | ≈1 896 | ≈2 051 | **3 119 064** | Peak at/over limit |
| `redpanda` | 1 500 | ≈1 002 | ≈1 059 | 0 | |
| `peerdb-flow-worker` | 2 048 | ≈212 | ≈1 761 | 0 | Little unused headroom |
| `metric-stream-r2-archive` | 1 024 | ≈56 | ≈93 | 0 | Go Connect, not JVM |
| `metric-stream-live-r2-archive` | 1 024 | ≈185 | ≈325 | 0 | |
| `metric-stream-history-r2-archive` | 1 024 | ≈135 | ≈471 | 0 | Highest archive peak |
| CH sinks (legacy/live) | 300 | ~117/125 | ≈143/177 | 0 | |
| `redis` (unlimited) | — | ≈393 | **≈2 648** | 0 | `used_memory_peak_human` 2.79 G; **maxmemory 0** |

### ClickHouse — why “~2 GiB observed” does not authorize a cut

- Mounted profile
  [`memory-limits-13g.xml`](../deploy/clickhouse/config.d/memory-limits-13g.xml)
  sets `<max_server_memory_usage>13958643712</max_server_memory_usage>` matching
  the 13 GiB Swarm limit ([deploy README](../deploy/README.md)).
- Live server settings: `max_server_memory_usage_to_ram_ratio=0.9`,
  `memory_worker_use_cgroup=1`, effective tracked cap ≈11.7 GiB when cgroup is
  13 GiB. ClickHouse documents server memory settings under
  [Server Settings](https://clickhouse.com/docs/operations/server-configuration-parameters/settings).
- Absolute cache knobs remain large (e.g. `mark_cache_size` /
  `primary_index_cache_size` / `index_mark_cache_size` each **5 GiB**).
  **Lowering the container limit alone** without shrinking those (and the XML
  cap) can still drive cgroup OOM under cache+query+merge pressure.
- 14 d `system.query_log`: max `memory_usage` **≈9 029 MiB** (dbt Inserts
  2026-11-02/03). `system.part_log` merge peaks **≈2 562 MiB**.
- `QueryMemoryLimitExceeded` event count **3** (process lifetime counter).
- Therefore: CH is a **proven near-full-envelope** service for configured
  budget; reclaim-via-CH is **not** evidence-backed without a dedicated
  workload qualification (and would be a requirements change).

### Archives — evidence-backed rightsize range (not 300)

Connect is a single Go process (`redpanda-connect run`); buffers from stock
config: `partition_buffer_bytes: 16MB`, `max_yield_batch_bytes: 4MB`,
`fetch_max_partition_bytes: 8MiB`, `max_in_flight: 8`, plus gzip compress
([Connect runbook](metric-stream-redpanda-r2-runbook.md)).

| Candidate durable limit (each of 3) | Headroom vs history peak 471 MiB | Configured reclaim (3×) | Status |
|---|---:|---:|---|
| **300 MiB** | **negative** (below live 325 and history 471) | 2 172 | **Unsafe — disproven by peaks** |
| 512 MiB | ≈18 MiB | 1 536 | Insufficient headroom without soak |
| **640 MiB** | ≈146 MiB | **1 152** | Candidate **only after** bounded qual |
| **768 MiB** | ≈274 MiB | **768** | Prefer first candidate |
| 896 MiB | ≈402 MiB | 384 | Conservative small reclaim |

Smallest evidence-backed **discussion** range: **640–768 MiB** per archive,
not 300. Still **≪ 5.5 GiB** configured shortfall even at 640 (−1 152 MiB).

### Bounded qualification proposal (approval required; not run)

No custom monitor, no unbounded synthetic load, no production cap mutation
until this passes and is reviewed:

1. **Target under test:** set disposable/lab-or-canary archive limit to
   **768 MiB** first (or 640 if 768 passes and more reclaim is required).
2. **Workload:** production-shaped only — keep normal live+legacy+history
   Connect consumers for a fixed window (propose **24 h** wall, or until each
   route archives ≥ N objects with lag remaining 0). No extra replay storm.
3. **Pass criteria:** cgroup `memory.peak` &lt; limit − **64 MiB** guardband;
   `memory.events` `max`/`oom`/`oom_kill` delta **0**; archive lag stays 0;
   no Connect OOM restart.
4. **Fail →** restore 1024 MiB; do not retry lower without new evidence.
5. **CH / PG:** out of scope for this qual; do not lower.

Optional follow-up (separate approval): authenticate Axiom and pull any
existing container memory series; Netdata remains desired 0.

### Reclaim vs configured shortfall (updated)

| Lever | Configured MiB if approved | Blocks Pulsar paper fit alone? |
|---|---:|---|
| Kafka path retire | 2 100 (**already in final**) | No — already applied in 29 600 |
| Leftovers + lifecycle | ≤384 | No |
| Archives →768 / →640 after qual | 768 / 1 152 | No — shortfall remains ≈4.9 / ≈4.5 GiB |
| Cap Redis to bound risk | 0 to Σcaps (adds a cap) | Needed for uncapped peak ~2.6 GiB honesty |
| CH / PG cut | large | **Not evidence-backed**; requirements change |

**Missing peak coverage** (Axiom/Netdata continuous host series; true
same-instant stack sum) means we **cannot** claim the physical host “already
fits” under Pulsar. **Proven cannot-rightsize-CH** from cgroup peak≈limit.
**Proven cannot-archive-at-300**. Configured shortfall after best archive
reclaim still needs another lever (resize/node, named sacrifice, or accepted
overcommit).

## Exact remaining user decision

Choose **one** before any stop/cap/Pulsar enable:

1. **Approve bounded archive qualification** at **768 MiB** (then optionally
   640) per proposal above — reclaim-first path, still expect remaining
   configured shortfall afterward, or
2. **Approve leftover stops only** (resync / idle non-stack / lifecycle→0) —
   tiny configured reclaim, or
3. **Defer Pulsar** / keep Kafka, or
4. **Authorize a named** CH/PG/PeerDB sacrifice or written overcommit, or
   resize/node **after** reclaim quals you approve, or
5. **STOP-BEFORE-START Kafka cutover design only** (capacity still blocked for
   Pulsar add).

Until that choice: **no runtime hunk changes** from this lane.

## Evidence index

| Artifact | Role |
|---|---|
| This document | Production capacity decision + reclaim plan + hunk manifesto |
| Commit `4b381ad5e938` | Sanitized mem2g-4 lab evidence + qual section |
| `docs/evidence/minio-mem2g-4-20261106/CORE_PROOF.json` | Lab peaks/events |
| SSH census 2026-11-06T21:21Z / 21:22Z / 21:27–21:28Z / 21:32Z | MemTotal, Swarm limits, RP lag, cgroup peaks/events, CH logs |
| `deploy/stack.oracle.yml` | Admin UIs desired-zero (excluded; no further reclaim) |
| GitHub `deploy-web.yml` | `disabled_manually` hold |
| Axiom / Netdata | **Gap this session** (Axiom needsAuth; Netdata replicas 0) |
