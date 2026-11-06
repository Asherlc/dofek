# R2→B2 erasure portability design (**DRAFT**)

> **DRAFT.** Alternatives **A** (version-lineage + lease) and **C** (Connect quiesce + listing settle) remain **REJECTED / unproven** — do not implement. No pointer-table, dual-backend, custom CAS, or audit-fence framework. No product/coordination code here.

**Branch:** `r2-to-b2` (PR [#3232](https://github.com/Asherlc/dofek/pull/3232))  
**Region:** `us-west-004`  
**Status:** draft docs only  
**Probe evidence:** [`docs/r2-to-b2-b2-erasure-probe.md`](r2-to-b2-b2-erasure-probe.md) · [`docs/evidence/b2-erasure-probe-20261106t180758z/`](evidence/b2-erasure-probe-20261106t180758z/)  
**Frozen probe SHA256:** `5fd159e002ecd97d97a6c23b2358fbcb1eed5b36ffe68f5824b675eef521ec44`

### User steering (archive exception — recorded direction)

| Surface | Direction | Notes |
|---|---|---|
| **Canonical JSONL metric archive** | **Stay on R2** | Retain existing Cloudflare dest CAS (`cf-copy-destination-if-match`). Removes **archive** dest-CAS portability from **this** migration PR’s blockers **if** archive remains R2. |
| **Pulsar BookKeeper tiered / sealed-ledger offload** | **B2** (stock `aws-s3`) | Proven separately; **lives in the Pulsar PR / B7 stock Pulsar CI**, **not** this migration PR — no mixed Pulsar offload config here. Needs **separate** B2 endpoint/credentials when provisioned (design coordination only; no runtime/Infisical/prod in this PR). |
| **Account-erasure restore ledger** | **Still R2 pending decision** | Do **not** assume ledger weaken or B2 placement approved. |
| **Other R2 buckets** | **Constraints unchanged** | Probe IfNoneMatch / dest-CAS findings still apply wherever those contracts are required. Remaining partial migration scope is **not** assumed user-approved. |

B2 offload objects (immutable UUID keys): native Delete **hides** prior versions — physical version cleanup / lifecycle qualification remains open; **no** erasure-complete claims for offload history.

Root: **Alt A rejected**; **Alt C unproven/invalid**; ledger Alt B = different threat contract (**no** equivalence); pointer/audit tables **not** approved.

---

## 1. Probe facts used by design (see probe report for full table)

| Observation | Design use |
|---|---|
| Put `IfNoneMatch:*` → **501 NotImplemented** | Ledger create-once cannot port as-is |
| Copy destination `IfMatch` → **501 NotImplemented** | R2 `cf-copy-destination-if-match` / stock dest CAS cannot port |
| `CopySourceIfMatch.good` → **200** | Valid source-condition request was **accepted** — **not** proof of mismatch enforcement |
| `CopySourceIfMatch.bad` → **403 Unknown** | Enforcement **UNQUALIFIED**; do not treat as 412 |
| Legal hold blocks version delete; same-key Put still **200** new current | Hold ≠ current-key freeze / rewrite fence |
| All-version delete + retain-new purge | Stock history mechanics work |
| CF dest header → **200** | Accept/ignore only — remove as guard |

Primary B2 docs: native [`b2_upload_file`](https://www.backblaze.com/apidocs/b2-upload-file) (no If-Match / If-None-Match); native [`b2_copy_file`](https://www.backblaze.com/apidocs/b2-copy-file) (`sourceFileId` source pin only); [Object Lock](https://www.backblaze.com/docs/cloud-storage-object-lock); S3-compatible [versioned-by-default](https://www.backblaze.com/apidocs/introduction-to-the-s3-compatible-api).

---

## 2. Current caller contracts

### 2.1 Connect archive writer (unconditional)

[`deploy/redpanda/metric-stream-r2-archive.connect.yml`](../deploy/redpanda/metric-stream-r2-archive.connect.yml): key embeds `{topic}-{partition}-{first_offset}-{last_offset}`; **no** conditional headers. Same-batch redelivery ⇒ **same key** ⇒ unconditional Put (new current VersionId on B2).

`ingest_fence` = `fenceClickHouseAccount` only — **does not** stop Connect archive Puts.

### 2.2 Archive erasure staging (R2 today)

[`commitStagedObject`](../src/account-erasure/archive-erasure.ts): `CopySourceIfMatch` + Cloudflare `cf-copy-destination-if-match: expectedTargetEtag`. Destination CAS rejects the copy when the target ETag changed since scan.

### 2.3 Restore ledger (R2 today)

[`recordIntent`](../src/account-erasure/restore-ledger.ts): `IfNoneMatch: "*"`; on 412, GET and compare. Runbook relies on R2 bucket lock for current-key immutability ([account-erasure-runbook](account-erasure-runbook.md)).

### 2.4 Postgres coordination ≠ storage fencing

`claimAccountErasureRequest` / lease, active-user unique index, and `pg_advisory_*` work locks serialize **request/work scheduling**. They do **not** fence already-issued object-store Put/Copy: connection loss or lease expiry can release PG ownership while an in-flight write still lands later.

### 2.5 Seven-day verification path

`archive_initial` → `waiting_replay` (`replay_retained_until`) → `archive_verification` (full resweep) → `request_pii_scrub` → day-29 `retention_verification`. Connect same-key redelivery remains possible until drain/replay expiry; verification is the post-commit net for **new** archive pollution after a completed rewrite.

**Important asymmetry vs R2 dest CAS:** post-commit Connect pollution is one class of gap. A **delayed Copy from a previous eraser** that lands **after** `archive_verification` / PII scrub is a **different** class — R2 destination CAS would have rejected that late Copy once the destination ETag was no longer the scanned value. Listing/lease asserts cannot reject a write that has not arrived yet.

---

## 3. Concrete interleaving that kills “lineage + lease” as CAS replacement

Actors: archive object contains Alice+Bob lines. Worker **A** erases Alice. Worker **B** erases Bob (lease steal / separate claim after A’s lease expires).

1. **A** reads current `V0`, stages rewrite that removes **Alice only**, sends `Copy` (in flight / delayed).  
2. **A**’s lease expires (or session dies). **A** may never run follow-up.  
3. **B** reads `V0` (or current), removes **Bob**, commits `Vb`, completes **`archive_verification`** and **PII scrub**.  
4. Delayed **Copy A** lands: current view becomes “remove Alice only” content that still contains **Bob**, **after** B’s verification believed the object clean.

On **R2**, destination CAS would reject Copy A after `Vb` changed the destination ETag — so this is **not** equivalent to the Connect-after-successful-commit gap.

**Conclusion:** any protocol that only lists versions / asserts lease / runs finite settle loops **before** a write arrives cannot bound a **future** in-flight Put/Copy. Those mechanisms are **rejected** as a recommended safe replacement for destination CAS.

---

## 4. Rejected / unproven strategies (do not recommend)

### 4.1 Alternative A — version-lineage fail-closed + lease assert (**REJECTED**)

Previously sketched as: Copy with source condition → list versions → fail closed if unexpected VersionIds → assert lease → purge superseded.

**Rejected reason:** cannot bound delayed Copy/Put that lands after the list/lease check (interleaving §3). Not equivalent to R2 destination CAS. Do **not** maintain settle-loop, per-key VersionId checkpoint-pin, or “lineage commit protocol” as recommended product concepts.

### 4.2 Alternative C — Connect quiesce + “list MPU + versions settle proves no in-flight Put” (**UNPROVEN / INVALID**)

Single-part Put/Copy are **not** enumerated by multipart listing. A finite quiet period of version listings is **not** fencing of writes already on the wire or scheduled outside the observer. Mark **unproven**; not a valid no-late-write proof strategy. Do not recommend.

### 4.3 Other standing rejects

- PG advisory/lease **alone** as storage fence.  
- Legal hold as rewrite authorizer or current-key freeze (probe: overwrite Put still 200).  
- GET→PUT / Head-then-write races to emulate dest CAS.  
- New custom CAS microservice / general lock framework.  
- Silent removal of destination CAS without a Root-accepted replacement that actually rejects late conflicting commits.  
- Claiming `CopySourceIfMatch` **enforcement** from good-path 200 alone.

---

## 5. Stock B2 mechanics still factual (not a CAS replacement)

Independent of the open dest-CAS problem:

1. Exact-key `ListObjectVersions` with fail-closed pagination / missing VersionId.  
2. All-version delete + post-list emptiness proof.  
3. After a **correct** content replace, retain intended new VersionId and delete only superseded (probe retain-new case).  
4. Remove CF `cf-copy-destination-if-match` (not a B2 guard).  
5. PeerDB Seaweed stays out of B2 migration.

These do **not** solve destination replace-if-etag. `CopySourceIfMatch` may remain as a **request** for staging identity where the platform accepts it; mismatch **enforcement** is **unproven** on this fixture (bad case UNQUALIFIED).

---

## 6. Ledger sketch (Alternative B) — different threat contract; no equivalence claim

R2 today: current-key create-once (`IfNoneMatch`) + bucket lock ⇒ clients with object write still cannot overwrite/delete the locked current object under the runbook’s lock model.

B2 Put `IfNoneMatch` is **501**. A version+legal-hold sketch is **not** claimed equivalent. Open requirements if Root explores it:

| Topic | Requirement / threat note |
|---|---|
| Where pinned VersionId lives | Must survive **Postgres restore / PG loss**: cannot live only in volatile memory. Candidates (for Root, not chosen here): sealed object metadata only; durable store outside the wiped user row; reconcile-from-storage discovery. Must specify restore-reconciler behavior when PG request rows are missing or replayed. |
| Discovery of all held versions | Startup / reconcile must **list all versions** under the ledger key (and any known prefix), identify every legal-held VersionId, not trust “current” HEAD alone. |
| Conflicting duplicates | Multiple versions with **unequal** sealed intents → **fail closed** (incident). Equal duplicates: define compare path (ledger already GETs bodies on R2). |
| Hold timing | Legal hold applied **after** Put leaves a window where the VersionId exists **unheld** (delete/overwrite races). Native/S3 “hold at upload” headers exist in B2 docs for some paths — any design must state whether hold is atomic with Put or accept the window as a distinct threat. |
| Capability to OFF hold | Probe/child keys used `writeFileLegalHolds`. A writer that can **OFF its own hold** is a **different threat model** than R2 bucket lock that blocks overwrite/delete for ordinary object writers. Account for who holds `writeFileLegalHolds` / `writeFileRetentions` in production. |
| Equivalence | **No claim** that version+hold equals R2 current-key lock. Material contract change requires Root/user decision — not silent adoption. |

---

## 7. Open problems (post archive-on-R2 steering)

| Problem | Status |
|---|---|
| Metric-archive dest CAS on B2 | **Out of migration path** while archive stays R2 (CF dest CAS retained) |
| Ledger create-once on B2 | **Still blocked / undecided** — ledger remains R2 pending decision; no weaken |
| Other buckets needing atomic create/replace | Probe constraints **still apply**; remaining partial scope **not** assumed approved |
| Pulsar B2 tiered offload | **Pulsar PR / B7** owns config; separate endpoints/credentials when provisioned; version hide vs physical cleanup qualification remains |
| Alt A / Alt C / pointer-audit CAS substitutes | **Rejected / unproven / not approved** |

Do **not** implement CAS-replacement coordination, dual-backend, or silent keep-R2 for undecided surfaces.

---

## 8. Decision table

| Topic | Status |
|---|---|
| Metric archive on R2 (user steering) | **Recorded direction** — CF dest CAS kept; archive CAS portability not a migration blocker |
| Pulsar BookKeeper offload on B2 | **Pulsar PR / B7**, not PR 3232 |
| Restore ledger placement | **R2 pending decision** |
| Remaining buckets / partial migrate | **Not assumed approved** |
| All-version delete / retain-new | Probe-supported where B2 history applies; not a CAS substitute |
| Alt A / Alt C | **REJECTED** / **UNPROVEN** |
| Pointer/audit / custom CAS | **Not approved** |
| Product / Infisical / copy / new probes | **Blocked** in this PR |
