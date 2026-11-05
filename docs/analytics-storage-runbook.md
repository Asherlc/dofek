# Analytics and transport physical storage boundaries

<!-- cspell:words cloudbeaver FSTYPE fsprogs quotaon repquota mountinfo chattr Privs tmpfs -->

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
| Runtime privilege | Match final effective/filesystem UID and namespace mapping; reject quota bypass or ability to reacquire it. |

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
mount or project mutation, including `CAP_SYS_ADMIN`; unknown capability decoding
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

## Maintenance approval and procedure

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
