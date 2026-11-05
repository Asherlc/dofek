# Analytics and transport physical storage boundaries

<!-- cspell:words cloudbeaver FSTYPE fsprogs quotaon repquota mountinfo chattr Privs tmpfs offloader prjquota setquota -->

This runbook prepares the physical storage gate for the
[transport-first release](pulsar-remaining-work.md). Production project quotas,
the storage preflight script and its startup integration are not implemented.
This document authorizes no filesystem change or production deployment. PeerDB
remains canonical CDC; the analytics-refresh, Ride with GPS, Strava and history
sink holds remain in force until their separate restoration decision.

The [qualification record](pulsar-qualification.md) documents a disposable
host-kernel ext4 test: project 4242 with an 8 MiB hard limit rejected an
unprivileged writer with EDQUOT, while a writer with `CAP_SYS_RESOURCE` bypassed
the limit. These are test values, not production allocations. The production
data filesystem was observed without project/quota features. The failed local
Docker-kernel quota mount is not enforcement evidence. See the
[recorded physical-storage results](pulsar-qualification.md#production-safety-and-next-decision).

## First-release cap scope and journal retention

R1 physically bounds new storage whose growth depends on backlog or R2
availability: BookKeeper journal/ledgers, actual broker/offloader local staging,
Oxia data, ClickHouse query spill, and the new effect journal and receipts.
Use a dedicated ClickHouse disk with a stock storage policy for the journal,
effect receipts and prepared/committed delivery manifests. Its project cap
must cover table parts and their merge/mutation overlap; a query-temporary
path cap alone does not bound those table files. See
[ClickHouse storage policies](https://clickhouse.com/docs/concepts/features/configuration/server-config/storing-data)
and [MergeTree rewrite overlap](https://clickhouse.com/resources/engineering/clickhouse-optimize-table-final).
No paths, project IDs or numerical production allocations have been adopted.

R1 qualifies physical backpressure against excess writes from backlog, R2
outages, slow consumption and runaway growth. It does not claim isolation of
a deliberately hostile writer. Dropping capabilities and setting
`no_new_privs` does not revoke inode ownership: upstream Linux permits an
owner in the initial user namespace to change project attributes. The ordinary
EDQUOT fixture does not test that escape. The November 5 host inspection found
kernel `6.17.0-1011-oracle` and the current ClickHouse writer in the host's initial
user namespace. Do not describe the cap as hostile-writer containment. See
[Linux project-attribute checks](https://github.com/torvalds/linux/blob/v6.17/fs/file_attr.c#L170-L205)
and [ownership admission](https://github.com/torvalds/linux/blob/v6.17/fs/file_attr.c#L249-L279).

Other existing databases, jobs, volumes and logs remain explicit measured
reserve/growth obligations. They are not all required to gain new project-quota
startup packaging in R1. The required preflight and final writer checks apply
to the capped set above; the whole-host budget still accounts for every owner.
Do not count Redpanda space until it is actually retired.

Analytics stays held in R1, so the journal is retained and can fill its cap.
The cap must fail closed: failed sink writes prevent acknowledgment, bounded
Pulsar backlog then holds producers. Measure live intake, size the retained-work
window with merge margin, and alert before exhaustion with estimated time to
full. R1 makes no indefinite-ingestion claim. Restoring the holds requires
retirement support or proof that the cap covers the complete drain, including
remaining providers and the verified history tail, with margin.

No age-only TTL or partition purge is approved. Current
[covered replay](../src/analytics/analytics-delivery.ts) re-verifies original
journal/receipt proofs even after frontier advancement and owner release.
Pending, uncertain and retained completed groups must remain recoverable.
Safe retirement needs a durable protocol certificate plus downstream coverage;
it remains mandatory R2 work. R2 raw-effect bootstrap also covers R1 intake.

The November 5 live-topic metadata window, 10:03:50–10:09:15 UTC, observed
partition 0 at epoch 1 with the high watermark unchanged at 238,803,373.
That is zero deliveries over 325 seconds, an idle interval rather than a
long-run growth bound. Later measurements below replace this idle interval as
the initial sizing input; raw-table bytes per row do not size the journal cap.

### Initial journal runway inputs

A November 5 read-only Axiom aggregate over 1,358 retained live-sink observations
spanned November 4 11:00:06.713 to November 5 10:31:09.030 UTC. The high-watermark
increase was 2,495,670 offsets over 84,662.317 seconds: 29.48 offsets/s. The
largest observed within-hour span was 63.75 offsets/s, 2.16 times the average.
Neither is an instantaneous peak or future rate bound. A fresh local group of
500 verified every raw row, effect, receipt and frontier, then measured active
parts and filesystem allocation. See the
[measurement limits](pulsar-qualification.md#november-5-journal-sizing-and-mutation-metadata-observations).

| Initial fixture input | Bytes/event | GB/day at average | GB/day at higher observed rate | Days per GB, average / higher |
| --- | ---: | ---: | ---: | ---: |
| Journal, receipts and manifests: parent part bytes | 402.88 | 1.03 | 2.22 | 0.975 / 0.451 |
| Same three tables: filesystem allocation | 827.39 | 2.11 | 4.56 | 0.475 / 0.219 |
| Including source placement: filesystem allocation | 1,187.84 | 3.03 | 6.54 | 0.331 / 0.153 |
| After merges, journal: active part allocation | 303.51 | 0.77 | 1.67 | 1.294 / 0.598 |
| After merges, source placement: active part allocation | 83.15 | 0.21 | 0.46 | 4.722 / 2.184 |
| After merges, combined active part allocation | 386.66 | 0.98 | 2.13 | 1.015 / 0.470 |

GB means decimal gigabytes. The first three rows describe fresh 500-event
parts. The last three come from one 10,000-event fixture after native merges;
active part allocation excludes retained inactive parts and table metadata.
Neither measures sustained physical allocation or justifies a cap. Projection
bytes are included in parent totals and must not be added twice. Source
placement has its own retention and bootstrap obligation; do not assume it can
be retired with delivery proofs. Measure sustained post-merge bytes per event
for each table, merge/mutation peak and the expected retention interval before
adopting allocations. Compare the resulting runway with the time needed to
ship safe retirement. If it cannot fit the host budget, explicitly decide
between bringing retirement into R1 and a planned stop of live intake.
The smaller merged figures supersede fresh-part allocation as an estimate of
retained active data, while the larger immediate allocation remains evidence
that rewrite overlap must be budgeted. Native sink assembly waits for that
retention decision; independent shutdown and erasure work can continue.

## Latest read-only host observation

On November 5, 2026 UTC, `findmnt`, `df -B1`, `tune2fs -l` and
`dpkg-query --status` confirmed the existing data mount: `/dev/sdb`, ext4,
UUID `450afc84-97ef-4dfe-9b31-cd6d639a5ba2`. Available bytes were
33,000,845,312; the superblock still had neither project nor quota features.
The installed e2fsprogs package was `1.47.0-2.4~exp1ubuntu4.1`, util-linux was
`2.39.3-9ubuntu6.5`, and the quota package was absent. The 1,966,080 reserved
blocks at 4,096 bytes each must be distinguished from available-space and
project-allocation arithmetic. These observations changed no filesystem state
and do not qualify enforcement. The inspection commands are documented below;
their field semantics are described by [tune2fs](https://man7.org/linux/man-pages/man8/tune2fs.8.html)
and [findmnt](https://man7.org/linux/man-pages/man8/findmnt.8.html).

### November 5 storage-owner census

A bounded read-only census at 08:38 UTC confirmed DockerRootDir is
`/var/lib/docker` on the separate root ext4 filesystem (`/dev/sda1`). Root
available space was 12,945,637,376 bytes; data-volume available space was
32,951,267,328 bytes. Website health was OK before and after the census.
These are observations, not quota allocations or startup qualification.

A single-filesystem `du --block-size=1 --max-depth=1` observation returned:

| Data path | Allocated bytes |
| --- | ---: |
| `clickhouse` | 60,916,539,392 |
| `redpanda` | 40,402,919,424 |
| `postgres` | 12,894,035,968 |
| `climbing-cutover-20261015` | 1,384,534,016 |
| `peerdb-catalog` | 333,852,672 |
| `redis` | 201,043,968 |
| `peerdb-minio` | 164,524,032 |
| `databasus` | 71,049,216 |

The retained climbing-cutover directory is an additional obligation whose
ownership and recovery role must be classified; it is not cleanup credit.
The shared `dofek_job_files` named volume was observed under DockerRootDir,
mounted by web and worker containers. Traefik state and two running non-stack
container volumes also live there. Data-volume quotas alone therefore do not
cover all current writes. Preserve these resources until their owners and
maintenance obligations are identified. Docker describes
[volume placement and inspection](https://docs.docker.com/engine/storage/volumes/).

All 30 observed running containers had writable roots. Source declares USER
1000:1000 for the application image, but most native service identities and
drops are inherited. The census records entry-process UID and capabilities;
it does not prove every descendant writer or a pre-write barrier. Include
application temporary files, Docker layers/logs, named volumes, deployment
one-shots and retained inactive volumes in the allocation and quiescence
inventory. See the [stack](../deploy/stack.yml),
[Oracle override](../deploy/stack.oracle.yml),
[application image](../Dockerfile) and
[deployment one-shots](../.github/workflows/deploy-web-stack.yml).

## Prepare the allocation and recovery package

Before proposing maintenance, record the following unresolved production inputs
with timestamps, tool versions and command exit status:

- Actual data-volume UUID/device, mount roots, filesystem features and capacity,
  reserved blocks, project quota enforcement state and installed tool support.
- Every writable path, owner, project ID, byte hard limit, inode policy and final
  runtime UID/capability requirements. There are no default production budgets.
- Conservative concurrent allocations with PeerDB retained, Redis persistence
  and historical peaks, Postgres WAL, ClickHouse merges/temp data, broker and
  metadata files, logs, backups and recovery/evacuation overlap. Preserve the
  unread local tail, original R2 archives and required host reserve. Do not fund
  a replacement from space its still-required source occupies.
- Independently accessible verified backups and recovery instructions for all
  affected state, recovery access if ordinary remount fails, a complete
  quiescence inventory and an explicit approved maintenance window.

Start the path inventory from the actual
[production stack](../deploy/stack.yml), not a new proposed layout:

| Host path under `/mnt/dofek-data/` | Current obligation |
| --- | --- |
| `postgres` | Application database and WAL, including retained CDC WAL |
| `clickhouse` | Serving data, merges, mutations and temporary files |
| `redpanda` | Existing sensor transport and unread local history |
| `peerdb-catalog`, `peerdb-minio` | Retained PeerDB catalog and staging state |
| `redis` | Queue state and persistence overlap |
| `databasus` | Backup scheduler configuration and local backup work |
| `cloudbeaver` | Management workspace |

Resolve additional writable container layers, named volumes, host logs, backup
staging and future Pulsar/Oxia paths explicitly. The table is not a complete
filesystem-owner census. Existing cloud-init and deployment lists must remain
consistent with the stack; see
[Oracle initialization](../deploy/oracle-free/cloud-init.yml) and
[deployment bind-path validation](../.github/workflows/deploy-web-stack.yml).

Sum each unique project ceiling once, together with bounded obligations outside
projects, filesystem overhead and explicit reserve, against usable capacity.
Track inode capacity separately. Current free bytes and idle service usage do
not establish those concurrent bounds. The
[database backup recovery runbook](database-backup-recovery-runbook.md) covers
Postgres; a fresh database object alone does not establish recovery of PeerDB,
Redis, transport, ClickHouse or the rest of this filesystem.

## Read-only preflight

The planned `scripts/check-storage-boundaries.ts` must inspect only; it must
never create projects, enable quotas, change ownership or remount. Its reviewed
requirements must identify filesystem UUID/device plus bind root, project ID,
hard bytes, inode policy, required UID, runtime process identity and reserve.
Missing inputs, unsupported tools, permission errors and ambiguous observations
must fail with a specific reason and nonzero exit status.

For initial read-only orientation, these command bodies were used in the
retained host assessment. Run through the normal authorized host-access workflow;
do not treat their success as a quota preflight pass:

```sh
df -B1 -- / /mnt/dofek-data
findmnt -no SOURCE,FSTYPE,OPTIONS /mnt/dofek-data
```

Before scripting further native commands, validate their exact options and
output against installed versions and native help/manuals. No quota-management
command line is approved here. In particular, the quota utility's print-state
mode is inspection; ordinary enable/disable operations change state. Use fixed
locale and explicit output columns rather than parsing human-readable defaults.
See [findmnt](https://man7.org/linux/man-pages/man8/findmnt.8.html),
[quotaon](https://man7.org/linux/man-pages/man8/quotaon.8.html) and
[repquota](https://man7.org/linux/man-pages/man8/repquota.8.html).

The required observations and acceptance rules are:

| Observation | Required result |
| --- | --- |
| Host and writer mount identity | Match UUID/device and bind root; reject missing mounts, root-filesystem fallback and unexplained nested mounts. Resolve real paths and device identity. |
| Filesystem prerequisites | Inspect superblock features and project quota state; a directory or mount-option string alone cannot pass. |
| Project membership | Match project IDs and inheritance on writable directories; verify existing descendant files are charged correctly. Root-directory inheritance alone is insufficient. |
| Limits | Match finite nonzero byte hard limits with exact integer unit conversion; record inode limits, usage and grace state. Soft limits alone cannot pass. |
| Reserve | Reject ceilings exceeding capacity or unclassified writable owners; deduplicate shared projects and bind mounts. |
| Runtime privilege | Match final effective/filesystem UID and namespace mapping; reject quota-bypassing capabilities or ways to regain them. Apply the growth-only threat model above. |

Mount roots and device numbers are available in the process mount namespace's
[mountinfo](https://man7.org/linux/man-pages/man5/proc_pid_mountinfo.5.html).
Use installed native superblock/quota inspection for the same device; ext4's
project feature and project quota facilities are described in
[ext4](https://man7.org/linux/man-pages/man5/ext4.5.html) and
[tune2fs](https://man7.org/linux/man-pages/man8/tune2fs.8.html).
The project hierarchy attribute is described in
[chattr](https://man7.org/linux/man-pages/man1/chattr.1.html); attribute mutation
is not part of this inspection.

Inspect the actual writer after its final identity drop, including every
thread's UID/fsUID, capability sets, `NoNewPrivs`, user namespace mapping and
process start identity. Reject `CAP_SYS_RESOURCE` and privileges permitting quota,
mount administration, including `CAP_SYS_ADMIN`; unknown capability decoding
fails. A privileged inspector's identity is not the writer's identity.
Capabilities are per-thread and `CAP_SYS_RESOURCE` can override quotas; see
[capabilities](https://man7.org/linux/man-pages/man7/capabilities.7.html) and
[process status](https://man7.org/linux/man-pages/man5/proc_pid_status.5.html).

There are two distinct activation gates. The host check belongs before the first
stack apply alongside the existing bind-path validation in the
[deployment workflow](../.github/workflows/deploy-web-stack.yml). A separate
startup barrier must check the final writer mount/privilege context before its
first write. Checking an old task or inspecting a new task after writes begin
does not meet that condition. The startup barrier and native-service packaging
remain unresolved; do not activate production enforcement until both gates exist.

Split those checks by privilege. The privileged, read-only host preflight
validates enforcement, each project hard limit and reserve before stack apply.
The unprivileged writer checks its own mount, project ID, inheritance and
identity before executing the writer. It must not gain `CAP_SYS_ADMIN` merely
to query limits: Linux's own-user/group quota exemptions do not extend to
project quota queries. See the [quota permission checks](https://github.com/torvalds/linux/blob/v6.17/fs/quota/quota.c#L24-L47).

## Maintenance approval and procedure

### Candidate native command contract

The following templates identify the native operations to qualify against the
installed tools. They are not an executable maintenance procedure or approval
to run mutations. Paths, project IDs, allocations, inode policy and recovery
assets are unresolved. The quota package is absent; its eventual installed
options and report format must be checked before implementing a parser.

| Operation | Candidate command / required qualification |
| --- | --- |
| Offline features | `tune2fs -O project,quota -Q prjquota DEVICE`, after ordinary unmount. Confirm inode-size support, preserve unrelated quota features and follow installed-tool filesystem-check requirements. See [tune2fs](https://man7.org/linux/man-pages/man8/tune2fs.8.html). |
| Existing membership | Assign each reviewed existing inode with `chattr -p PROJECT_ID PATH`; set `chattr +P DIRECTORY` on existing writable directories. Root-only inheritance does not assign old descendants. Resolve nested mounts, symlinks and cross-project hard links before traversal. See [chattr](https://man7.org/linux/man-pages/man1/chattr.1.html). |
| Hard limits | `setquota -P PROJECT_ID BLOCK_SOFT_KIB BLOCK_HARD_KIB INODE_SOFT INODE_HARD FILESYSTEM`. Block units are 1,024 bytes; inode units are counts. Require exact integer conversion and an explicit soft/inode policy; zero can mean unlimited. See [setquota](https://man7.org/linux/man-pages/man8/setquota.8.html). |
| Read-only reports | Inspect features with `tune2fs -l DEVICE`, membership with `lsattr -p -d PATH`, and enforcement with `quotaon -P -p FILESYSTEM`. Candidate limit report: `LC_ALL=C repquota -P -n -v -p -O csv FILESYSTEM`; confirm installed CSV columns and units first. Ordinary `quotaon -P` enables quotas and is a mutation. See [quotaon](https://man7.org/linux/man-pages/man8/quotaon.8.html) and [repquota](https://man7.org/linux/man-pages/man8/repquota.8.html). |

Mount configuration must preserve the reviewed UUID and enable `prjquota`;
actual enforcement still needs inspection. Do not use XFS-only enforcement
options for ext4. See [ext4 mount options](https://man7.org/linux/man-pages/man5/ext4.5.html).

### Delivery and downtime approval

The delivery method remains an approval gate. Existing host configuration is
managed through the stack or Terraform; the canonical Terraform state is not
currently available. Updating the [Oracle cloud-init definition](../deploy/oracle-free/cloud-init.yml)
alone does not update this existing host: cloud-init's
[`runcmd` module runs once per instance](https://cloudinit.readthedocs.io/en/latest/reference/modules.html#runcmd).
The proposed alternative is a committed, idempotent maintenance script, with
matching rebuilt-host configuration and the storage preflight as its post-check.
Obtain explicit approval for that delivery exception together with the concrete
maintenance window. No script or host change is authorized by this proposal.

Prepare and review the exact installed-tool commands, allocations, tracked
infrastructure changes and recovery procedure before requesting maintenance
approval. The following sequence is a gate list, not an executable enablement
script:

1. Verify recovery assets independently of the affected filesystem and rehearse
   the relevant restore. Record the acceptable recovery/loss boundary and owner.
   Keep recovery instructions and access usable while the data volume is absent.
2. Obtain explicit approval for the concrete procedure and downtime. Preserve
   all four holds and original provider checkpoints. Quiesce every filesystem
   user, including host/operator processes and services outside the stack;
   prevent deployment or restart automation from recreating writers.
3. Confirm durable shutdown/checkpoints and no remaining users, then require an
   ordinary unmount of the separate data filesystem. Stop if it is busy; do not
   substitute lazy or forced unmount. Root/SSH may remain available on the
   separate root filesystem, provided they do not hold the data mount busy.
   See [umount](https://man7.org/linux/man-pages/man8/umount.8.html).
4. Only within the approved window, perform the reviewed offline feature/project
   changes and persistence configuration. Follow installed-tool restrictions and
   requested consistency checks; do not assume a universal fsck requirement or
   that a rescue boot is always required. Feature changes and quota inodes are
   documented by [tune2fs](https://man7.org/linux/man-pages/man8/tune2fs.8.html).
   Stop on any unexpected state and use the reviewed recovery procedure.
5. Remount the expected filesystem, verify identity/features/enforcement and
   existing project membership, then pass host and writer gates before writes.
   A missing data mount must prevent service startup rather than create data on
   the root filesystem. Restore only the separately authorized service set.

## Qualification and release evidence

Before production activation, exercise the actual service UID/capabilities on
an isolated filesystem with the required kernel support: force real EDQUOT at
the project hard limit, prove another project's reserve remains available,
verify partial-file handling, restart/remount persistence and absent-mount
startup refusal. Logical backlog limits, tmpfs tests and application temporary
data accounting do not replace this kernel test. Preserve the
[earlier quota result](pulsar-qualification.md) as a narrow feasibility proof.

Then qualify R2 outage, stopped consumption/slow ClickHouse, bookie budget fill
and recovery under measured whole-host ceilings with PeerDB retained. Record
explicit producer rejection, acknowledgment accounting, bounded disk/RSS and
website health, including source/replacement overlap. Reuse the completed local
transport lifecycle result; these are separate storage/outage gates. Follow
[remaining release gates](pulsar-remaining-work.md) for their current status.

A read-only preflight proves observed configuration at that instant. It does
not certify future availability, account-erasure completion, disk-loss restore
or capacity during unmeasured overlap. Keep cutover blocked when any required
allocation, enforcement, recovery or outage proof is missing.
