# Kafka TS on R2 — ONE cloud qualification packet (Q-MPU + Q-DEL)

**Status:** corrected for Root source review → **user cloud-budget decision** next.
**Do not execute** (no bucket create, mint, List/Get/Put/Delete, broker-vs-R2) until
the **user** answers the dashboard cloud-budget question on this corrected packet.
No TF apply / merge / deploy. No production topic cutover.

Closes **both** Phase F gaps in **one** disposable lab:

1. **Q-MPU** — actual multipart (`CreateMultipartUpload` / `UploadPart` /
   `CompleteMultipartUpload`).
2. **Q-DEL** — native RLM retention → remote delete for **main and**
   `.quarantine.v1`, empty `ListObjectsV2` (+ quiesced list-MPU).

Pins / client isolation match Phase F + dual512-fix:
[`evidence/kafka-ts-r2-phasef-20261106/`](evidence/kafka-ts-r2-phasef-20261106/),
Kafka **4.4.0** + Aiven RSM **1.2.0**, client **384 MiB** / heap **256 MiB**,
broker **2048 MiB** / heap **1 GiB**.

Coordinates with **T02 / 3d** local Seaweed retention–Delete (separate; not a
substitute). **B2** lifecycle deadline/heartbeat preserved; archived **b1**
forbidden. This packet is **R2-only**.

Companion Root launch text (readonly, no secrets):
[`kafka-ts-r2-q-mpudel-20261107-launch.md`](kafka-ts-r2-q-mpudel-20261107-launch.md).

---

## Config keys (verified — do not use `rsm.config.s3.*`)

Aiven `S3StorageConfig` defines **raw** keys `s3.multipart.upload.part.size` and
`s3.path.style.access.enabled`
([`S3StorageConfig.java` v1.2.0](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/storage/s3/src/main/java/io/aiven/kafka/tieredstorage/storage/s3/S3StorageConfig.java);
[configs.rst](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/docs/configs.rst)).

`RemoteStorageManagerConfig` passes storage backends
`originalsWithPrefix("storage.")`
([`RemoteStorageManagerConfig.java`](https://github.com/Aiven-Open/tiered-storage-for-apache-kafka/blob/v1.2.0/core/src/main/java/io/aiven/kafka/tieredstorage/config/RemoteStorageManagerConfig.java)
`STORAGE_PREFIX = "storage."`). Broker property prefix is Kafka’s `rsm.config.`.

| Layer | Exact key / env that **works** |
|---|---|
| Aiven raw (after `storage.` strip) | `s3.multipart.upload.part.size`, `s3.path.style.access.enabled` |
| Broker property | `rsm.config.storage.s3.multipart.upload.part.size`, `rsm.config.storage.s3.path.style.access.enabled` |
| Compose / Kafka Docker env (Phase F + `deploy/stack.yml`) | `KAFKA_RSM_CONFIG_STORAGE_S3_MULTIPART_UPLOAD_PART_SIZE`, `KAFKA_RSM_CONFIG_STORAGE_S3_PATH_STYLE_ACCESS_ENABLED` |

**Wrong / ignored:** `rsm.config.s3.multipart.upload.part.size` (and any
`rsm.config.s3.*` without `storage.`) — does **not** reach `S3StorageConfig`;
MPU part size would stay default **25 MiB** and a 5–8 MiB segment would **not**
multipart. Phase F lab compose used the **STORAGE_S3_** form
(`/tmp/kafka-ts-r2-phasef-20261106/docker-compose.yml`).

Lab must set:

```text
KAFKA_RSM_CONFIG_STORAGE_S3_PATH_STYLE_ACCESS_ENABLED=true
KAFKA_RSM_CONFIG_STORAGE_S3_MULTIPART_UPLOAD_PART_SIZE=5242880
```

(plus existing `…_STORAGE_S3_{BUCKET_NAME,ENDPOINT_URL,REGION}`,
`…_STORAGE_BACKEND_CLASS`, `AWS_*_CHECKSUM_*=WHEN_REQUIRED`).

---

## Credential boundary (Phase F exact; no new runtime parent)

Two **distinct** Root-only credentials (never in broker):

| Role | Source (names only) | Permission / use |
|---|---|---|
| **CF REST Bearer** | Operator env `CF_API_TOKEN` = same class as Infisical **`CLOUDFLARE_API_TOKEN`** (Traefik/DNS token that Phase F Root already used for account R2 REST) | `Authorization: Bearer …` on `POST /accounts/{id}/r2/buckets` and `POST /accounts/{id}/r2/temp-access-credentials`. Phase F preflight: Get Bucket → **404/10006** (auth OK); Create Token / `permission_groups` → **403/9109** (no API Tokens Write — expected). Create/mint need account **Workers R2 Storage Write** on that Bearer ([Create Bucket](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/), [temp credentials](https://developers.cloudflare.com/api/resources/r2/subresources/temporary_credentials/methods/create/)). |
| **Delegation parent Access Key ID** | Infisical **`R2_ACCESS_KEY_ID`** (archive Object key **ID only** in mint JSON `parentAccessKeyId`) | Parent S3 key that can mint `object-read-write` sessions for the **new** disposable bucket + prefix. Secret stays Root-only for mint/cleanup. **ID may appear** in Root mint request; **secret never** in Cursor env, compose files, or chat. |

**Broker receives only** child session trio from mint (`accessKeyId` /
`secretAccessKey` / `sessionToken` → `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`). **`parent_in_broker=false`**.

| Identity | This packet |
|---|---|
| Phase F path above (Bearer + `R2_ACCESS_KEY_ID` parent ID for mint) | **YES** |
| GH `CLOUDFLARE_TERRAFORM_R2_API_TOKEN` / TF child `KAFKA_TIERED_STORAGE_*` | **NO** (apply path; do not mint before TF apply) |
| Parent secret / Bearer in broker | **Forbidden** |
| Writing archive objects under prod JSONL prefixes | **Forbidden** — parent ID is **delegation only**, not broker archive reuse |

---

## Resource identity (exact)

| Field | Value |
|---|---|
| Bucket | `kafka-ts-r2-q-mpudel-20261107` |
| Prefix | `kafka-ts-parity/r2/20261107-q-mpudel/` |
| Account | `8e5b2f62ffe8ebdd48e725d325a6d51e` |
| Session TTL | **3600** s from mint |
| Wall clock | **≤ 55 min after mint** (must finish or abort before TTL) |
| **Total upload bound** | **≤ 16 MiB** summed across main+quarantine remote `.log`/`.indexes`/`.rsm-manifest` **and** multipart part attempt bodies (operator stop if exceeded) |
| Evidence dir | `docs/evidence/kafka-ts-r2-q-mpudel-20261107/` (sanitized) |

Do **not** reuse `kafka-ts-r2-f-20261106` or `dofek-kafka-ts-offload`.

---

## Exact tests

### Test A — Q-MPU (main)

| Field | Value |
|---|---|
| Topic | Lab-only `tieredTopicR2QMpu` (1 partition); `remote.storage.enable=true` |
| Segment | One closed `.log` **≥ 5 MiB and ≤ 8 MiB** (with part size **5242880**) |
| Pass | Sanitized RSM/broker lines (or stock S3 API inventory during/after copy) show **CreateMultipartUpload**, ≥1 **UploadPart**, **CompleteMultipartUpload** for `.log`; remote keys under prefix; local closed segment gone |
| MPU proof hygiene | **No** AWS SDK full wire / HTTP body logging; **no** secret values in evidence. Prefer RSM “copy completed” + multipart API name lines and/or Root `ListMultipartUploads`/`ListObjectsV2` counts |
| Fail | PutObject-only; wrong config prefix (default 25 MiB part); Java in broker cgroup; parent in broker |

### Test B — Q-DEL (main + quarantine)

| Field | Value |
|---|---|
| Topics | Main **and** `tieredTopicR2QMpu.quarantine.v1` |
| Quarantine produce | Phase-F-class **64 × 1024 B** (remote objects only; **not** MPU claim) |
| Retention | Short `retention.ms` / `local.retention.ms` via stock `kafka-configs.sh` after copy (e.g. 60 s / 30 s) |
| Pass | TopicIds via `kafka-topics.sh --describe`; RLMM dump → `DELETE_SEGMENT_FINISHED` (or no unfinished delete) for **both** TopicIds; `ListObjectsV2` **0** keys on both Aiven prefixes; list-MPU **0** (quiesced; never abort active broker MPU to fake GC) |
| Fail | Manual DeleteObjects as pass; main-only inventory; custom parser |

### Test C — finite one consume

| Field | Value |
|---|---|
| Consume | **One** finite console-consumer pass on main covering the MPU segment (count + sha256 `offset|value` plan match) |
| `observed_D` | **unknown** — no hard download meter |
| Bound | Counts toward ≤55 min wall and planning-only download judgment |

---

## Explicit non-claims

Not production cutover; not app erasure ack; not failure/restart/backpressure;
not durable `dofek-kafka-ts-offload`; not B2; not hard download meter; local
Seaweed ≠ this packet.

---

## Infisical names-only (prod `/`)

**Present (do not change topic values):** `METRIC_STREAM_*` topic keys,
`METRIC_STREAM_R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_ENDPOINT`,
`R2_SECRET_ACCESS_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, …
**Missing (block merge/deploy; do not mint before TF apply):** `KAFKA_BROKERS`,
`KAFKA_CLUSTER_ID`, `KAFKA_TIERED_STORAGE_{BUCKET,ENDPOINT,REGION,ACCESS_KEY_ID,SECRET_ACCESS_KEY}`.

---

## Decision gate

1. ~~Source/launch packet corrections~~ (this revision).
2. **User** cloud-budget / scope answer on the dashboard (not an execute ACK to
   Root alone).
3. Only after **approve budget** → Root mint on exact identity → Cursor runs
   A+B+C within bounds → cleanup.
