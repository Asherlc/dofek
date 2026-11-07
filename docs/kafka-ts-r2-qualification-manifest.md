# Kafka TS on R2 — ONE cloud qualification packet (Q-MPU + Q-DEL)

**Status:** prepared for **Root review**. **Do not** create buckets, mint
sessions, List/Get/Put/Delete, or run the broker against R2 until Root ACK’s
this packet. No TF apply / merge / deploy. No production topic cutover.

Closes **both** remaining Phase F gaps in **one** disposable lab:

1. **Q-MPU** — actual multipart (`CreateMultipartUpload` / `UploadPart` /
   `CompleteMultipartUpload`), not “eligible because segment > part size.”
2. **Q-DEL** — **native** RLM retention → remote delete for **main and**
   `.quarantine.v1`, ending in empty `ListObjectsV2` (+ quiesced list-MPU).

Based on stock Apache Kafka **4.4.0** + Aiven RSM **v1.2.0** Phase F setup
([`evidence/kafka-ts-r2-phasef-20261106/`](evidence/kafka-ts-r2-phasef-20261106/),
[`kafka-tiered-storage-s3-compatibility.md`](kafka-tiered-storage-s3-compatibility.md)).
Client isolation: **384 MiB** tool / heap **256 MiB**; never Java inside broker
cgroup (broker **2048 MiB** / heap **1 GiB**) — same dual512-fix bar.

Coordinates with **T02 / lane 3d** local Seaweed retention–Delete proof (Compose
slot). That local proof does **not** substitute this cloud packet; this packet
does **not** claim local Seaweed. Do not steal T02’s Docker slot.

**B2 track:** preserve existing B2 lifecycle deadline / heartbeat separately.
Archived **b1** remains forbidden. This packet is **R2-only**.

---

## Credential boundary (old grant vs new scope)

| Identity | Scope | This packet | Notes |
|---|---|---|---|
| **Old approved Phase F grant** (Root parent CF API) | `POST …/r2/buckets` + `POST …/r2/temp-access-credentials` (`object-read-write`, prefix-scoped, TTL **3600**) | **YES — only path** | Parent **never** in broker; session via AWS default chain + `AWS_SESSION_TOKEN`; no revoke API — TTL + bucket delete ([temp credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)) |
| **New TF managing secret** `CLOUDFLARE_TERRAFORM_R2_API_TOKEN` (`dofek-terraform-r2-manage` id `ac888fe9…`) | Account API Tokens Write + Workers R2 Storage Write; GH-only | **NO** | For `provider.cloudflare.r2` / durable `dofek-kafka-ts-offload` after apply — **not** injected into this lab ([IaC](kafka-ts-r2-offload-iac.md)) |
| Infisical / GH `CLOUDFLARE_API_TOKEN` (Traefik DNS) | Zone DNS challenge | **NO** | Unchanged; must not receive Account Tokens Edit |
| Archive `R2_*` / `METRIC_STREAM_R2_*` | JSONL archive bucket | **NO** | Do not reuse for Kafka TS |
| Prod TF child `KAFKA_TIERED_STORAGE_*` | Durable Object RW for `dofek-kafka-ts-offload` | **NO** — **do not create** before TF apply | Missing in Infisical today (see audit below) |

**New resource identity (this run only):** disposable bucket
`kafka-ts-r2-q-mpudel-YYYYMMDD` + prefix
`kafka-ts-parity/r2/YYYYMMDD-q-mpudel/` — **not** Phase F bucket name reuse,
**not** `dofek-kafka-ts-offload`.

---

## Exact tests (pass / fail)

### Shared setup (Root)

1. Create disposable R2 bucket + mint prefix-scoped temp session (TTL 3600),
   same stock APIs as Phase F `ROOT_SETUP_RESULT.json`.
2. Cursor brings Compose Kafka 4.4.0 + RSM 1.2.0 (pins as Phase F
   `plugin-provenance.json`) with stock:
   - `AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED`
   - `AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED`
   - `rsm.config.s3.path.style.access.enabled=true`
   - `rsm.config.s3.multipart.upload.part.size=5242880` (**5 MiB** min —
     [Aiven configs](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/docs/configs.rst))
   - region `auto`; endpoint `https://<accountId>.r2.cloudflarestorage.com`
3. External client only for admin/produce/consume.

### Test A — Q-MPU (main topic)

| Field | Value |
|---|---|
| Topic | Lab-only `tieredTopicR2QMpu` (1 partition); `remote.storage.enable=true` |
| Produce bound | **One** closed segment whose `.log` object is **≥ 5 MiB and ≤ 8 MiB** (prefer ~5200–7000 × 1024 B values, or equivalent). **Not** Phase F’s 64 KiB Put path. |
| Wall bound | ≤ **20 min** from first produce → `COPY` complete / MPU complete evidence |
| Pass | Sanitized broker/RSM/SDK lines (or equivalent stock trace) show **CreateMultipartUpload**, ≥1 **UploadPart**, **CompleteMultipartUpload** for the `.log` object; remote keys present under prefix; local closed segment removed (active log only) |
| Fail / non-pass | Only PutObject; “eligible” without UploadPart; segment &lt; 5 MiB; Java in broker cgroup; parent creds in broker |

### Test B — Q-DEL (main + quarantine)

| Field | Value |
|---|---|
| Topics | Same main as A **and** `tieredTopicR2QMpu.quarantine.v1` (suffix
  [`METRIC_STREAM_QUARANTINE_TOPIC_SUFFIX`](../src/metric-stream/kafka-quarantine.ts)); both `remote.storage.enable=true` |
| Quarantine produce | Tiny Phase-F-class segment (**64 × 1024 B** values) so quarantine has remote objects — **not** an MPU claim for quarantine |
| Retention | Set **short** `retention.ms` / `local.retention.ms` (e.g. **60 s / 30 s**) on **both** topics via stock `kafka-configs.sh` **after** copy complete; measure delete lag — do not invent a parser |
| Wall bound | ≤ **25 min** from retention apply → both prefixes empty (or fail with measured lag) |
| Pass | (1) `kafka-topics.sh --describe` TopicIds (base64url) for main **and** quarantine; (2) stock `kafka-dump-log.sh --remote-log-metadata-decoder` on RLMM shows spanning segments reach **`DELETE_SEGMENT_FINISHED`** (or equivalent latest-state absence of unfinished delete) for both TopicIds; (3) Root/Cursor **read-only** `ListObjectsV2` under both Aiven prefixes → **0** keys for mapped `.log`/`.indexes`/`.rsm-manifest`; (4) list multipart uploads under those prefixes → **0** (or only proven orphans after broker quiesced — **never** abort active broker MPUs to fake GC) |
| Fail / non-pass | Manual `DeleteObjects` / CF bucket wipe used as the **pass** (Phase F cleanup was manual — **not** Q-DEL); main-only inventory; quarantine HWM alone for main absence; custom retention parser |

### Test C — bounded remote read (optional same lab, after A, before B wipe)

| Field | Value |
|---|---|
| Consume | Finite console-consumer digest on main offsets covering the MPU segment (count match + sha256 `offset|value` plan) |
| Download meter | **`observed_D` = unknown** — **no** hard download-cap claim (same as Phase F). Planning figure **≤ ~10 MiB** for operator stop judgment only |
| Wall | ≤ **10 min** |

### Cleanup (Root; after pass or abort)

List exact prefix → DeleteObjects if leftovers → abort **quiesced** MPUs only →
CF DELETE bucket → GET 404. Compose `down --remove-orphans --volumes` → zero
owned containers/volumes. Do **not** recreate same bucket name before session
TTL without review. Evidence dir:
`docs/evidence/kafka-ts-r2-q-mpudel-YYYYMMDD/` (sanitized only).

---

## Explicit non-claims

- Not production readiness / cutover / dual-write
- Not app account-erasure end-to-end / `stock_physical_maintenance_ack` issuance
- Not failure/restart/backpressure (separate gates)
- Not archive JSONL / `dofek-kafka-ts-offload` durable path
- Not B2 Phase M
- Not a hard download byte meter
- Local Seaweed Q-DEL (T02) ≠ this cloud packet

---

## Infisical names-only audit (prod `/`, 2026-11-07 session)

**Present (do not change topic values in this work):**
`METRIC_STREAM_LEGACY_TOPIC`, `METRIC_STREAM_LIVE_TOPIC`,
`METRIC_STREAM_HISTORY_TOPIC`, `METRIC_STREAM_TOPIC`,
`METRIC_STREAM_TRANSPORT_EPOCH`, `METRIC_STREAM_R2_BUCKET`,
`R2_ACCESS_KEY_ID`, `R2_ENDPOINT`, `R2_SECRET_ACCESS_KEY`,
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`,
`ACCOUNT_ERASURE_LEDGER_R2_BUCKET`, `ACCOUNT_ERASURE_LEDGER_KEYRING_JSON`.

**Missing (block merge/deploy / broker TS; do not invent values here; do not
mint runtime keys before TF apply):**

| Name | Needed for |
|---|---|
| `KAFKA_BROKERS` | App/runtime bootstrap (lane 87 + 3d / B7) |
| `KAFKA_CLUSTER_ID` | Stable KRaft cluster id in `KAFKA_ENV_FILE` |
| `KAFKA_TIERED_STORAGE_BUCKET` | TF → Infisical after apply |
| `KAFKA_TIERED_STORAGE_ENDPOINT` | TF → Infisical after apply |
| `KAFKA_TIERED_STORAGE_REGION` | TF → Infisical after apply |
| `KAFKA_TIERED_STORAGE_ACCESS_KEY_ID` | TF child token id after apply |
| `KAFKA_TIERED_STORAGE_SECRET_ACCESS_KEY` | TF sha256(token value) after apply |

GH `CLOUDFLARE_TERRAFORM_R2_API_TOKEN` exists (names-only confirmed earlier) —
**not** an Infisical runtime secret.

---

## Root decision needed before any cloud GET/mutation

Approve **this packet** (credential mode = Phase F temp session on **new**
disposable identity; tests A+B(+C); bounds above) **or** request bound/scope
edits. Until ACK: Cursor continues docs / Infisical names audit / coordination
with T02 local proof only — **zero** R2 API calls from this lane.

Cross-links: [IaC](kafka-ts-r2-offload-iac.md),
[assessment current plan](kafka-tiered-storage-assessment.md#current-plan-root-conditional-ack--runtime-only),
[physical-absence draft gaps](_draft-kafka-ts-physical-absence-runbook.md).
